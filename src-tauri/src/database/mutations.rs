use super::{Database, Driver, identity_columns, placeholder, qualified};
use crate::{model::*, safety::quote};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationRequest {
    pub connection_id: String,
    pub table: TableRef,
    pub kind: String,
    #[serde(default)]
    pub rows: Vec<MutationRow>,
    pub column: Option<String>,
    pub value: Option<Value>,
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutationRow {
    pub key: BTreeMap<String, Value>,
    pub before: Option<Value>,
}
pub struct MutationPlan {
    pub sql: String,
    pub params: Vec<Value>,
    pub expected_rows: u64,
}
fn editable(value: &Value) -> Result<(), Error> {
    if matches!(
        value,
        Value::Binary(_) | Value::Array(_) | Value::Unknown(_)
    ) {
        return Err(Error::new(
            "EDIT_UNSUPPORTED",
            "Use explicit SQL for binary, array, or custom values.",
        ));
    }
    Ok(())
}
impl Database {
    pub fn plan_mutation(&mut self, request: &MutationRequest) -> Result<MutationPlan, Error> {
        if !["insert", "update", "delete"].contains(&request.kind.as_str()) {
            return Err(Error::new("VALIDATION", "Unsupported table operation."));
        }
        if request.rows.len() > 500
            || serde_json::to_vec(&request.values).map_or(true, |v| v.len() > 4 * 1024 * 1024)
        {
            return Err(Error::new(
                "MUTATION_LIMIT",
                "Select at most 500 rows and keep new values below 4 MiB.",
            ));
        }
        self.refresh_metadata();
        self.require_transactional_table(&request.table)?;
        if !self.tables()?.iter().any(|t| {
            t.schema == request.table.schema && t.name == request.table.name && t.kind == "table"
        }) {
            return Err(Error::new(
                "EDIT_UNSUPPORTED",
                "Only base tables support these operations.",
            ));
        }
        let metadata = self.metadata(&request.table)?;
        let pg = matches!(&self.driver, Driver::Postgres(_));
        let table = qualified(&request.table);
        let keys = identity_columns(&metadata);
        let mut params = Vec::new();
        if request.kind == "insert" {
            if !request.rows.is_empty() || request.column.is_some() || request.value.is_some() {
                return Err(Error::new("VALIDATION", "Invalid new-record request."));
            }
            let mut columns = Vec::new();
            let mut placeholders = Vec::new();
            for (name, value) in &request.values {
                let field = metadata
                    .columns
                    .iter()
                    .find(|c| &c.name == name)
                    .ok_or_else(|| Error::new("VALIDATION", "Unknown insert column."))?;
                editable(value)?;
                if matches!(value, Value::Null) && !field.nullable && field.pk == 0 {
                    return Err(Error::new(
                        "VALIDATION",
                        "A required column cannot be NULL.",
                    ));
                }
                columns.push(quote(name));
                params.push(value.clone());
                placeholders.push(placeholder(pg, params.len()));
            }
            return Ok(MutationPlan {
                sql: if columns.is_empty() {
                    if self.is_mysql() {
                        format!("INSERT INTO {table} () VALUES ()")
                    } else {
                        format!("INSERT INTO {table} DEFAULT VALUES")
                    }
                } else {
                    format!(
                        "INSERT INTO {table} ({}) VALUES ({})",
                        columns.join(", "),
                        placeholders.join(", ")
                    )
                },
                params,
                expected_rows: 1,
            });
        }
        if request.rows.is_empty() || keys.is_empty() {
            return Err(Error::new(
                "IDENTITY",
                "Select rows with complete, non-null unique keys.",
            ));
        }
        if !request.values.is_empty() {
            return Err(Error::new("VALIDATION", "Invalid bulk operation values."));
        }
        let column = if request.kind == "update" {
            let column = request
                .column
                .as_ref()
                .ok_or_else(|| Error::new("VALIDATION", "Choose a column to update."))?;
            let field = metadata
                .columns
                .iter()
                .find(|c| &c.name == column)
                .ok_or_else(|| Error::new("VALIDATION", "Unknown update column."))?;
            if keys.contains(column) || field.pk > 0 {
                return Err(Error::new(
                    "EDIT_IDENTITY",
                    "Identity columns cannot be bulk edited.",
                ));
            }
            let value = request
                .value
                .as_ref()
                .ok_or_else(|| Error::new("VALIDATION", "Provide the new value."))?;
            editable(value)?;
            if matches!(value, Value::Null) && !field.nullable {
                return Err(Error::new("VALIDATION", "This column cannot be NULL."));
            }
            params.push(value.clone());
            Some(field)
        } else {
            if request.column.is_some() || request.value.is_some() {
                return Err(Error::new("VALIDATION", "Invalid delete request."));
            }
            None
        };
        let mut seen = BTreeSet::new();
        let mut identities = Vec::new();
        let mut predicates = Vec::new();
        for row in &request.rows {
            if row.key.len() != keys.len()
                || keys
                    .iter()
                    .any(|k| row.key.get(k).is_none_or(|v| matches!(v, Value::Null)))
            {
                return Err(Error::new(
                    "IDENTITY",
                    "A selected row has an incomplete unique key.",
                ));
            }
            if !seen.insert(
                serde_json::to_string(&row.key)
                    .map_err(|_| Error::new("VALIDATION", "Invalid key."))?,
            ) {
                return Err(Error::new(
                    "IDENTITY",
                    "A record was selected more than once.",
                ));
            }
            let mut parts = Vec::new();
            for key in &keys {
                params.push(row.key[key].clone());
                parts.push(format!(
                    "{} = {}",
                    quote(key),
                    placeholder(pg, params.len())
                ));
            }
            identities.push(format!("({})", parts.join(" AND ")));
            if let Some(field) = column {
                let before = row.before.as_ref().ok_or_else(|| {
                    Error::new(
                        "VALIDATION",
                        "Each edited row needs its previous cell value.",
                    )
                })?;
                editable(before)?;
                let name = if pg && field.data_type.eq_ignore_ascii_case("json") {
                    format!("{}::text", quote(&field.name))
                } else {
                    quote(&field.name)
                };
                if matches!(before, Value::Null) {
                    parts.push(format!("{name} IS NULL"));
                } else {
                    params.push(before.clone());
                    parts.push(format!("{name} = {}", placeholder(pg, params.len())));
                }
            }
            predicates.push(format!("({})", parts.join(" AND ")));
        }
        if params.len() > if self.is_mssql() { 2000 } else { 30000 }
            || serde_json::to_vec(&params).map_or(true, |v| v.len() > 4 * 1024 * 1024)
        {
            return Err(Error::new(
                "MUTATION_LIMIT",
                "This selection exceeds the safe parameter limit. Select fewer rows.",
            ));
        }
        let action = if let Some(field) = column {
            format!(
                "UPDATE {table} SET {} = {}",
                quote(&field.name),
                placeholder(pg, 1)
            )
        } else {
            format!("DELETE FROM {table}")
        };
        Ok(MutationPlan {
            sql: if self.is_mysql() {
                format!("{action} WHERE ({})", predicates.join(" OR "))
            } else {
                format!(
                    "{action} WHERE ({}) AND (SELECT COUNT(*) FROM {table} WHERE {}) = {}",
                    predicates.join(" OR "),
                    identities.join(" OR "),
                    request.rows.len()
                )
            },
            params,
            expected_rows: request.rows.len() as u64,
        })
    }
}
