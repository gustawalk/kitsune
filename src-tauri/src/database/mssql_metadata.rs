use super::{Database, Driver, text};
use crate::model::*;
use std::collections::BTreeMap;
impl Database {
    pub fn is_mssql(&self) -> bool {
        matches!(&self.driver, Driver::Mssql(_))
    }
    pub(super) fn mssql_metadata(&mut self, t: &TableRef) -> Result<Metadata, Error> {
        let p = [Value::Text(t.schema.clone()), Value::Text(t.name.clone())];
        let rows=self.query("SELECT c.name,ty.name,CAST(c.is_nullable AS int),dc.definition,COALESCE(pk.key_ordinal,0) FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id LEFT JOIN (SELECT i.object_id,ic.column_id,ic.key_ordinal FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.is_primary_key=1) pk ON pk.object_id=c.object_id AND pk.column_id=c.column_id WHERE s.name=?1 AND o.name=?2 ORDER BY c.column_id",&p,10000,true,10)?;
        if rows.truncated || rows.rows.is_empty() {
            return Err(Error::new(
                "TABLE_MISSING",
                "SQL Server metadata is unavailable or exceeds limits.",
            ));
        }
        let columns = rows
            .rows
            .iter()
            .map(|r| Column {
                name: text(r, 0),
                data_type: text(r, 1),
                nullable: text(r, 2) == "1",
                default_value: r.get(3).and_then(Value::text),
                pk: text(r, 4).parse().unwrap_or(0),
                enum_type: None,
            })
            .collect();
        let foreign_keys = self.mssql_foreign_keys(t, false)?;
        let rows=self.query("SELECT i.name,CAST(i.is_unique AS int),c.name,CAST(i.has_filter AS int) FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE s.name=?1 AND o.name=?2 AND ic.key_ordinal>0 AND i.is_disabled=0 ORDER BY i.name,ic.key_ordinal",&p,10000,true,10)?;
        let mut indexes: BTreeMap<String, Index> = BTreeMap::new();
        for r in rows.rows {
            let name = text(&r, 0);
            let index = indexes.entry(name.clone()).or_insert(Index {
                name,
                unique: text(&r, 1) == "1",
                partial: text(&r, 3) == "1",
                columns: vec![],
            });
            index.columns.push(text(&r, 2));
        }
        Ok(Metadata {
            table: t.clone(),
            columns,
            foreign_keys,
            indexes: indexes.into_values().collect(),
            enums: vec![],
        })
    }
    pub(super) fn mssql_foreign_keys(
        &mut self,
        t: &TableRef,
        incoming: bool,
    ) -> Result<Vec<ForeignKey>, Error> {
        let target = if incoming {
            "ts.name=?1 AND dst.name=?2"
        } else {
            "ss.name=?1 AND src.name=?2"
        };
        let sql = format!(
            "SELECT fk.name,ss.name,src.name,ts.name,dst.name,sc.name,tc.name FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id JOIN sys.tables src ON src.object_id=fc.parent_object_id JOIN sys.schemas ss ON ss.schema_id=src.schema_id JOIN sys.tables dst ON dst.object_id=fc.referenced_object_id JOIN sys.schemas ts ON ts.schema_id=dst.schema_id JOIN sys.columns sc ON sc.object_id=src.object_id AND sc.column_id=fc.parent_column_id JOIN sys.columns tc ON tc.object_id=dst.object_id AND tc.column_id=fc.referenced_column_id WHERE {target} AND fk.is_disabled=0 ORDER BY ss.name,src.name,fk.name,fc.constraint_column_id"
        );
        let rows = self.query(
            &sql,
            &[Value::Text(t.schema.clone()), Value::Text(t.name.clone())],
            10000,
            true,
            10,
        )?;
        let mut keys: BTreeMap<(String, String, String), ForeignKey> = BTreeMap::new();
        for r in rows.rows {
            let name = text(&r, 0);
            let key = keys
                .entry((text(&r, 1), text(&r, 2), name.clone()))
                .or_insert_with(|| ForeignKey {
                    name,
                    from: TableRef {
                        schema: text(&r, 1),
                        name: text(&r, 2),
                        kind: "table".into(),
                    },
                    to: TableRef {
                        schema: text(&r, 3),
                        name: text(&r, 4),
                        kind: "table".into(),
                    },
                    columns: vec![],
                    target_columns: vec![],
                });
            key.columns.push(text(&r, 5));
            key.target_columns.push(text(&r, 6));
        }
        Ok(keys.into_values().collect())
    }
}
