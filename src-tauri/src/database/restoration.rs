use super::{Database, Driver};
use crate::model::*;
use sha2::{Digest, Sha256};
impl Database {
    pub fn write_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.owned_transaction(false, operation)
    }
    pub fn read_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.owned_transaction(true, operation)
    }
    fn owned_transaction<T>(
        &mut self,
        read_only: bool,
        operation: impl FnOnce(&mut Self) -> Result<T, Error>,
    ) -> Result<T, Error> {
        match &mut self.driver {
            Driver::Sqlite(db) => db.execute_batch(if read_only {
                "BEGIN"
            } else {
                "BEGIN IMMEDIATE"
            })?,
            Driver::Postgres(pg) => pg.restore_begin(read_only)?,
            Driver::Mysql(db) => db.restore_begin(read_only)?,
            Driver::Mssql(db) => db.restore_begin(read_only)?,
        };
        let outcome = operation(self);
        let end = match &mut self.driver {
            Driver::Sqlite(db) => {
                let result = db.execute_batch(if outcome.is_ok() {
                    "COMMIT"
                } else {
                    "ROLLBACK"
                });
                if result.is_err() && outcome.is_ok() {
                    let _ = db.execute_batch("ROLLBACK");
                    Err(Error::new(
                        "OUTCOME_UNCERTAIN",
                        "SQLite did not confirm the restore outcome. Verify the current record before retrying.",
                    ))
                } else {
                    Ok(())
                }
            }
            Driver::Postgres(pg) => pg.restore_end(outcome.is_ok()),
            Driver::Mysql(db) => db.restore_end(outcome.is_ok()),
            Driver::Mssql(db) => db.restore_end(outcome.is_ok()),
        };
        match outcome {
            Err(error) => Err(error),
            Ok(value) => {
                end?;
                Ok(value)
            }
        }
    }
    pub fn restore_generated(&mut self, table: &TableRef) -> Result<(Vec<String>, bool), Error> {
        if self.is_mssql() {
            let r=self.query("SELECT c.name FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=?1 AND o.name=?2 AND (c.is_computed=1 OR c.is_identity=1)",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],10000,true,5)?;
            return Ok((r.rows.iter().filter_map(|r| r[0].text()).collect(), false));
        }
        if self.is_mysql() {
            let r=self.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?1 AND TABLE_NAME=?2 AND (EXTRA LIKE '%VIRTUAL GENERATED%' OR EXTRA LIKE '%STORED GENERATED%')",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],10000,true,5)?;
            return Ok((r.rows.iter().filter_map(|r| r[0].text()).collect(), false));
        }
        if self.is_postgres() {
            let rows=self.query("SELECT a.attname,a.attgenerated::text,a.attidentity::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],10000,true,5)?;
            let mut columns = Vec::new();
            let mut identity = false;
            for row in rows.rows {
                if row[1].text().is_some_and(|v| !v.is_empty()) {
                    columns.push(row[0].text().unwrap_or_default());
                }
                if row[2].text().as_deref() == Some("a") {
                    identity = true;
                }
            }
            Ok((columns, identity))
        } else {
            let rows = self.query(
                "SELECT name FROM pragma_table_xinfo(?1) WHERE hidden>=2",
                &[Value::Text(table.name.clone())],
                10000,
                true,
                5,
            )?;
            Ok((
                rows.rows.iter().filter_map(|r| r[0].text()).collect(),
                false,
            ))
        }
    }
    pub fn is_postgres(&self) -> bool {
        matches!(&self.driver, Driver::Postgres(_))
    }
    pub fn restore_schema(&mut self, table: &TableRef) -> Result<String, Error> {
        if let Some((time, signature)) = self.restore_cache.get(table)
            && time.elapsed() < std::time::Duration::from_secs(60)
        {
            return Ok(signature.clone());
        }
        let mut metadata = self.metadata(table)?;
        metadata.indexes.sort_by(|a, b| a.name.cmp(&b.name));
        metadata.foreign_keys.sort_by(|a, b| a.name.cmp(&b.name));
        let definition = self.table_definition(table)?.map(|sql| {
            if self.is_mysql() {
                stable_mysql_definition(&sql)
            } else {
                sql
            }
        });
        let mut generated = self.restore_generated(table)?;
        generated.0.sort();
        let constraints = if self.is_mysql() {
            Some(self.query("SELECT CONSTRAINT_NAME,REFERENCED_TABLE_NAME,UPDATE_RULE,DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=?1 AND (TABLE_NAME=?2 OR REFERENCED_TABLE_NAME=?2) ORDER BY CONSTRAINT_NAME",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],10000,true,5)?.rows)
        } else if self.is_postgres() {
            Some(self.query("SELECT f.conname,pg_catalog.pg_get_constraintdef(f.oid) FROM pg_catalog.pg_constraint f JOIN pg_catalog.pg_class c ON c.oid=f.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 ORDER BY f.conname",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],10000,true,5)?.rows)
        } else {
            None
        };
        let bytes = serde_json::to_vec(&(metadata, definition, generated, constraints))
            .map_err(|_| Error::new("METADATA", "Schema could not be compared."))?;
        let signature = format!("{:x}", Sha256::digest(bytes));
        if self.restore_cache.len() >= 256 {
            self.restore_cache.clear();
        }
        self.restore_cache.insert(
            table.clone(),
            (std::time::Instant::now(), signature.clone()),
        );
        Ok(signature)
    }
    pub fn restore_lock(&mut self, table: &TableRef) -> Result<(), Error> {
        if self.is_mysql() {
            self.query(
                &format!(
                    "SELECT 1 FROM {} LIMIT 1 FOR UPDATE",
                    super::qualified(table)
                ),
                &[],
                1,
                false,
                5,
            )?;
            self.restore_cache.remove(table);
        }
        if self.is_postgres() {
            self.query(
                &format!(
                    "LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE",
                    super::qualified(table)
                ),
                &[],
                1,
                false,
                5,
            )?;
        }
        Ok(())
    }
    pub fn restore_protection(&mut self, table: &TableRef) -> Result<(), Error> {
        if self.is_mysql() {
            self.require_transactional_table(table)?;
            let p = [
                Value::Text(table.schema.clone()),
                Value::Text(table.name.clone()),
            ];
            let r=self.query("SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE UNIQUE_CONSTRAINT_SCHEMA=?1 AND REFERENCED_TABLE_NAME=?2 AND (DELETE_RULE IN ('CASCADE','SET NULL') OR UPDATE_RULE IN ('CASCADE','SET NULL'))",&p,1,true,5)?;
            if r.rows
                .first()
                .and_then(|r| r.first())
                .and_then(Value::text)
                .as_deref()
                != Some("0")
            {
                return Err(Error::new(
                    "RESTORE_CASCADE",
                    "Historical restore is blocked for cascading or SET NULL relationships. Use reviewed SQL.",
                ));
            }
            return Ok(());
        }
        if self.is_mssql() {
            return Err(Error::new(
                "RESTORE_UNSUPPORTED",
                "Reviewed historical restoration is not yet supported for SQL Server. Inspect history and use reviewed SQL instead.",
            ));
        }
        let (trigger, cascade) = if self.is_postgres() {
            let unsupported=self.query("SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND (c.relkind<>'r' OR c.relrowsecurity OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid))",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],1,true,5)?;
            if unsupported.rows[0][0].text() != Some("0".into()) {
                return Err(Error::new(
                    "RESTORE_TABLE",
                    "Partitioned, inherited, or row-security tables require an explicit SQL workflow.",
                ));
            }

            let p = [
                Value::Text(table.schema.clone()),
                Value::Text(table.name.clone()),
            ];
            let triggers=self.query("SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal AND t.tgenabled<>'D'",&p,1,true,5)?;
            let cascades=self.query("SELECT count(*) FROM pg_catalog.pg_constraint f JOIN pg_catalog.pg_class c ON c.oid=f.confrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND f.contype='f' AND (f.confdeltype IN ('c','n','d') OR f.confupdtype IN ('c','n','d'))",&p,1,true,5)?;
            (
                triggers.rows[0][0].text() != Some("0".into()),
                cascades.rows[0][0].text() != Some("0".into()),
            )
        } else {
            let p = [Value::Text(table.name.clone())];
            let triggers = self.query(
                "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name=?1",
                &p,
                1,
                true,
                5,
            )?;
            let cascades=self.query("SELECT count(*) FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f.\"table\"=?1 AND (f.on_delete IN ('CASCADE','SET NULL','SET DEFAULT') OR f.on_update IN ('CASCADE','SET NULL','SET DEFAULT'))",&p,1,true,5)?;
            (
                triggers.rows[0][0].text() != Some("0".into()),
                cascades.rows[0][0].text() != Some("0".into()),
            )
        };
        if trigger || cascade {
            return Err(Error::new(
                "RESTORE_SIDE_EFFECTS",
                "Restore is unavailable: this table has active triggers or cascading relationships whose effects cannot be safely reversed.",
            ));
        }
        Ok(())
    }
}

// SHOW CREATE includes the next sequence value, which changes with data rather than schema.
fn stable_mysql_definition(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if matches!(bytes[i], b'\'' | b'"' | b'`') {
            let quote = bytes[i];
            output.push(bytes[i]);
            i += 1;
            while i < bytes.len() {
                let ch = bytes[i];
                output.push(ch);
                i += 1;
                if ch == quote {
                    if bytes.get(i) == Some(&quote) {
                        output.push(quote);
                        i += 1;
                    } else {
                        break;
                    }
                }
            }
        } else if (i == 0 || bytes[i - 1].is_ascii_whitespace())
            && bytes[i..].starts_with(b"AUTO_INCREMENT=")
        {
            let mut end = i + 15;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end > i + 15 && bytes.get(end).is_none_or(u8::is_ascii_whitespace) {
                while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
                    end += 1;
                }
                i = end;
            } else {
                output.push(bytes[i]);
                i += 1;
            }
        } else {
            output.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(output).expect("only ASCII sequence metadata was removed")
}
#[cfg(test)]
mod fingerprint_tests {
    use super::stable_mysql_definition;
    #[test]
    fn ignores_sequence_counter_but_preserves_literals_and_schema() {
        let a = "CREATE TABLE `AUTO_INCREMENT=5` (id INT AUTO_INCREMENT, note TEXT DEFAULT 'AUTO_INCREMENT=3') ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4";
        let b = a.replace("InnoDB AUTO_INCREMENT=3", "InnoDB AUTO_INCREMENT=900");
        assert_eq!(stable_mysql_definition(a), stable_mysql_definition(&b));
        assert!(stable_mysql_definition(a).contains("DEFAULT 'AUTO_INCREMENT=3'"));
        assert!(stable_mysql_definition(a).contains("`AUTO_INCREMENT=5`"));
        assert_ne!(
            stable_mysql_definition(a),
            stable_mysql_definition(&a.replace("id INT", "id BIGINT"))
        );
    }
}
