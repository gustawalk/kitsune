use super::{Database, Driver, text};
use crate::model::*;
use std::collections::BTreeMap;
impl Database {
    pub fn is_mysql(&self) -> bool {
        matches!(&self.driver, Driver::Mysql(_))
    }
    pub fn require_transactional_table(&mut self, table: &TableRef) -> Result<(), Error> {
        if self.is_mssql() {
            let r=self.query("SELECT COUNT(*) FROM sys.triggers tr JOIN sys.objects o ON o.object_id=tr.parent_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=?1 AND o.name=?2 AND tr.is_disabled=0",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],1,true,5)?;
            if r.rows
                .first()
                .and_then(|r| r.first())
                .and_then(Value::text)
                .as_deref()
                != Some("0")
            {
                return Err(Error::new(
                    "TRANSACTION_UNSUPPORTED",
                    "SQL Server generated writes require a table without active triggers.",
                ));
            }
        }
        if self.is_mysql() {
            let r=self.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?1 AND TABLE_NAME=?2",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],1,true,5)?;
            if r.rows
                .first()
                .and_then(|r| r.first())
                .and_then(Value::text)
                .is_none_or(|e| !e.eq_ignore_ascii_case("InnoDB"))
            {
                return Err(Error::new(
                    "TRANSACTION_UNSUPPORTED",
                    "Managed writes require an InnoDB base table.",
                ));
            }
        }
        Ok(())
    }
    pub(super) fn mysql_metadata(&mut self, table: &TableRef) -> Result<Metadata, Error> {
        let p = [
            Value::Text(table.schema.clone()),
            Value::Text(table.name.clone()),
        ];
        let r=self.query("SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_DEFAULT,COALESCE(k.ORDINAL_POSITION,0) FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=?1 AND c.TABLE_NAME=?2 ORDER BY c.ORDINAL_POSITION",&p,10000,true,30)?;
        if r.truncated {
            return Err(Error::new(
                "METADATA_LIMIT",
                "Column metadata exceeds the supported limit.",
            ));
        }
        let columns = r
            .rows
            .iter()
            .map(|r| Column {
                name: text(r, 0),
                data_type: text(r, 1),
                nullable: text(r, 2) == "YES",
                default_value: r.get(3).and_then(Value::text),
                pk: text(r, 4).parse().unwrap_or(0),
            })
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Err(Error::new(
                "TABLE_MISSING",
                "Table is missing or inaccessible.",
            ));
        }
        let foreign_keys = self.mysql_foreign_keys(table, false)?;
        let r=self.query("SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=?1 AND TABLE_NAME=?2 ORDER BY INDEX_NAME,SEQ_IN_INDEX",&p,10000,true,30)?;
        if r.truncated {
            return Err(Error::new(
                "METADATA_LIMIT",
                "Index metadata exceeds the supported limit.",
            ));
        }
        let mut indexes: BTreeMap<String, Index> = BTreeMap::new();
        for row in &r.rows {
            let name = text(row, 0);
            let entry = indexes.entry(name.clone()).or_insert(Index {
                name,
                unique: text(row, 1) == "0",
                partial: false,
                columns: vec![],
            });
            if !matches!(row[3], Value::Null) || matches!(row[2], Value::Null) {
                entry.partial = true;
            }
            entry.columns.push(text(row, 2));
        }
        Ok(Metadata {
            table: table.clone(),
            columns,
            foreign_keys,
            indexes: indexes.into_values().collect(),
        })
    }
    pub(super) fn mysql_foreign_keys(
        &mut self,
        table: &TableRef,
        incoming: bool,
    ) -> Result<Vec<ForeignKey>, Error> {
        let condition = if incoming {
            "REFERENCED_TABLE_SCHEMA=?1 AND REFERENCED_TABLE_NAME=?2"
        } else {
            "TABLE_SCHEMA=?1 AND TABLE_NAME=?2"
        };
        let sql = format!(
            "SELECT CONSTRAINT_NAME,TABLE_SCHEMA,TABLE_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,COLUMN_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE {condition} AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION"
        );
        let r = self.query(
            &sql,
            &[
                Value::Text(table.schema.clone()),
                Value::Text(table.name.clone()),
            ],
            10000,
            true,
            30,
        )?;
        if r.truncated {
            return Err(Error::new(
                "METADATA_LIMIT",
                "Foreign-key metadata exceeds the supported limit.",
            ));
        }
        let mut keys: BTreeMap<(String, String, String), ForeignKey> = BTreeMap::new();
        for row in &r.rows {
            let name = text(row, 0);
            let key = keys
                .entry((text(row, 1), text(row, 2), name.clone()))
                .or_insert_with(|| ForeignKey {
                    name,
                    from: TableRef {
                        schema: text(row, 1),
                        name: text(row, 2),
                        kind: "table".into(),
                    },
                    to: TableRef {
                        schema: text(row, 3),
                        name: text(row, 4),
                        kind: "table".into(),
                    },
                    columns: vec![],
                    target_columns: vec![],
                });
            key.columns.push(text(row, 5));
            key.target_columns.push(text(row, 6));
        }
        Ok(keys.into_values().collect())
    }
}
