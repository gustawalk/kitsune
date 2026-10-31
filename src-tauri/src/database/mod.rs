pub mod mssql;
mod mssql_metadata;
pub mod mutations;
pub mod mysql;
mod mysql_metadata;
pub mod postgres;
mod restoration;
use crate::model::*;
use crate::safety::quote;
use base64::Engine;
use rusqlite::{
    Connection, OpenFlags,
    types::{Value as SqlValue, ValueRef},
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

/// Upper bound for collected results; row and timeout limits still apply.
pub const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;

enum Driver {
    Sqlite(Connection),
    Postgres(postgres::Pg),
    Mysql(mysql::Mysql),
    Mssql(mssql::Mssql),
}
pub struct Database {
    driver: Driver,
    metadata_cache: BTreeMap<TableRef, (Instant, usize, Metadata)>,
    incoming_cache: BTreeMap<TableRef, (Instant, usize, Vec<ForeignKey>)>,
    incoming_cache_bytes: usize,
    tables_cache: Option<(Instant, Vec<TableRef>)>,
    metadata_cache_bytes: usize,
    restore_cache: BTreeMap<TableRef, (Instant, String)>,
}
pub enum Interrupt {
    Sqlite(Arc<rusqlite::InterruptHandle>),
    Postgres(Arc<postgres::Cancel>),
    Mysql(Arc<mysql::Cancel>),
    Mssql(Arc<mssql::Cancel>),
}
impl Interrupt {
    pub fn cancel(&self) {
        match self {
            Self::Sqlite(c) => c.interrupt(),
            Self::Postgres(c) => c.cancel(),
            Self::Mysql(c) => c.cancel(),
            Self::Mssql(c) => c.cancel(),
        }
    }
}
impl Database {
    fn new(driver: Driver) -> Self {
        Self {
            driver,
            metadata_cache: BTreeMap::new(),
            incoming_cache: BTreeMap::new(),
            incoming_cache_bytes: 0,
            tables_cache: None,
            metadata_cache_bytes: 0,
            restore_cache: BTreeMap::new(),
        }
    }
    pub fn refresh_metadata(&mut self) {
        self.restore_cache.clear();
        self.metadata_cache.clear();
        self.incoming_cache.clear();
        self.incoming_cache_bytes = 0;
        self.metadata_cache_bytes = 0;
        self.tables_cache = None;
    }

    pub fn open(
        config: &ConnectionConfig,
        internal: &Path,
        force_read_only: bool,
    ) -> Result<Self, Error> {
        config.validate()?;
        if config.driver == "postgres" {
            return Ok(Self::new(Driver::Postgres(postgres::Pg::open(config)?)));
        }
        if config.driver == "mysql" {
            let mut config = config.clone();
            config.read_only |= force_read_only || config.environment == "production";
            return Ok(Self::new(Driver::Mysql(mysql::Mysql::open(&config)?)));
        }
        if config.driver == "mssql" {
            return Ok(Self::new(Driver::Mssql(mssql::Mssql::open(config)?)));
        }
        let path = Path::new(&config.path);
        if path.exists() && path.canonicalize().ok() == internal.canonicalize().ok() {
            return Err(Error::new(
                "INTERNAL_DATABASE",
                "The application metadata database cannot be opened as a user connection.",
            ));
        }
        let read_only = force_read_only || config.read_only || config.environment == "production";
        if read_only && config.create {
            return Err(Error::new(
                "READ_ONLY",
                "Cannot create a database in read-only mode.",
            ));
        }
        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else if config.create {
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let db = Connection::open_with_flags(path, flags)?;
        db.busy_timeout(Duration::from_secs(3))?;
        // Connection-local enforcement; does not alter persistent database settings.
        db.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY,
            true,
        )?;
        // Native SQLite authorization prevents external-file and connection-state escape.
        db.authorizer(Some(|context: rusqlite::hooks::AuthContext<'_>| {
            use rusqlite::hooks::{AuthAction, Authorization};
            match context.action {
                AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
                AuthAction::Pragma { pragma_name, .. }
                    if ![
                        "table_info",
                        "table_xinfo",
                        "foreign_key_list",
                        "index_list",
                        "index_info",
                    ]
                    .contains(&pragma_name) =>
                {
                    Authorization::Deny
                }
                AuthAction::Function { function_name }
                    if function_name.eq_ignore_ascii_case("load_extension")
                        || function_name.eq_ignore_ascii_case("writefile")
                        || function_name.eq_ignore_ascii_case("readfile") =>
                {
                    Authorization::Deny
                }
                _ => Authorization::Allow,
            }
        }));
        Ok(Self::new(Driver::Sqlite(db)))
    }
    pub fn require_readonly(&self, sql: &str) -> Result<(), Error> {
        if let Driver::Sqlite(db) = &self.driver
            && !db.prepare(sql)?.readonly()
        {
            return Err(Error::new(
                "READ_ONLY",
                "Diagnostics cannot execute a write.",
            ));
        }
        Ok(())
    }
    pub fn interrupt(&self) -> Option<Arc<Interrupt>> {
        match &self.driver {
            Driver::Sqlite(db) => Some(Arc::new(Interrupt::Sqlite(Arc::new(
                db.get_interrupt_handle(),
            )))),
            Driver::Postgres(pg) => pg.cancel_handle().map(|c| Arc::new(Interrupt::Postgres(c))),
            Driver::Mysql(db) => Some(Arc::new(Interrupt::Mysql(db.cancel_handle()))),
            Driver::Mssql(db) => Some(Arc::new(Interrupt::Mssql(db.cancel_handle()))),
        }
    }
    pub fn mysql_native(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
        timeout: u64,
        read_only: bool,
    ) -> Result<Vec<ResultSet>, Error> {
        if let Driver::Mysql(db) = &mut self.driver {
            db.native(sql, params, limit, timeout, read_only)
        } else {
            Err(Error::new("UNSUPPORTED", "Native MySQL session required."))
        }
    }
    pub fn transaction_active(&self) -> bool {
        matches!(&self.driver, Driver::Mysql(db) if db.transaction_active)
    }
    pub fn mssql_explain(&mut self, sql: &str, params: &[Value]) -> Result<ResultSet, Error> {
        if let Driver::Mssql(db) = &mut self.driver {
            db.explain(sql, params)
        } else {
            Err(Error::new("UNSUPPORTED", "SQL Server operation."))
        }
    }
    pub fn query(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
        read_only: bool,
        timeout: u64,
    ) -> Result<ResultSet, Error> {
        self.query_checked(sql, params, limit, read_only, timeout, None)
    }
    pub fn query_checked(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
        read_only: bool,
        timeout: u64,
        expected: Option<u64>,
    ) -> Result<ResultSet, Error> {
        match &mut self.driver {
            Driver::Mssql(db) => db.query_checked(sql, params, limit, read_only, timeout, expected),
            Driver::Mysql(db) => db.query_checked(sql, params, limit, read_only, timeout, expected),
            Driver::Postgres(pg) => {
                pg.query_checked(sql, params, limit, read_only, timeout, expected)
            }
            Driver::Sqlite(db) => {
                let start = Instant::now();
                let deadline = start + Duration::from_secs(timeout.clamp(1, 300));
                let own_transaction = db.is_autocommit();
                if own_transaction {
                    db.execute_batch("BEGIN")?;
                }
                db.progress_handler(1000, Some(move || Instant::now() > deadline));
                let mut writes = false;
                let result = (|| {
                    let mut statement = db.prepare(sql)?;
                    writes = !statement.readonly();
                    if read_only && !statement.readonly() {
                        return Err(Error::new(
                            "READ_ONLY",
                            "SQLite rejected a write in read-only execution.",
                        ));
                    }
                    let columns = statement
                        .column_names()
                        .iter()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>();
                    let types = statement
                        .columns()
                        .iter()
                        .map(|c| c.decl_type().unwrap_or("dynamic").into())
                        .collect();
                    let values = params
                        .iter()
                        .map(sql_value)
                        .collect::<Result<Vec<_>, _>>()?;
                    if columns.is_empty() {
                        let affected = statement.execute(rusqlite::params_from_iter(values))?;
                        return Ok(ResultSet {
                            columns,
                            types,
                            rows: vec![],
                            affected: affected as u64,
                            duration_ms: start.elapsed().as_millis() as u64,
                            truncated: false,
                            next_cursor: None,
                            keyset_supported: false,
                        });
                    }
                    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
                    let mut result = ResultSet {
                        columns,
                        types,
                        rows: vec![],
                        affected: 0,
                        duration_ms: 0,
                        truncated: false,
                        next_cursor: None,
                        keyset_supported: false,
                    };
                    let mut bytes = 0usize;
                    while let Some(row) = rows.next()? {
                        if result.rows.len() >= limit {
                            result.truncated = true;
                            break;
                        }
                        let mut record = Vec::new();
                        let mut too_large = false;
                        for col in 0..result.columns.len() {
                            let raw = row.get_ref(col)?;
                            let value_bytes = match raw {
                                ValueRef::Blob(v) | ValueRef::Text(v) => v.len(),
                                _ => 8,
                            };
                            if bytes.saturating_add(value_bytes) > crate::database::MAX_RESULT_BYTES
                            {
                                if read_only {
                                    result.truncated = true;
                                    too_large = true;
                                    break;
                                }
                                return Err(Error::new(
                                    "RESULT_LIMIT",
                                    "This statement exceeded the safe result-size limit. Its transaction was rolled back; select fewer or smaller values and run it again.",
                                ));
                            }
                            bytes += value_bytes;
                            record.push(match raw {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(n) => Value::Integer(n.to_string()),
                                ValueRef::Real(n) => Value::Float(n.to_string()),
                                ValueRef::Text(v) => match std::str::from_utf8(v) {
                                    Ok(s) => Value::Text(s.into()),
                                    Err(_) => Value::Unknown(format!(
                                        "Invalid UTF-8 text (base64): {}",
                                        base64::engine::general_purpose::STANDARD.encode(v)
                                    )),
                                },
                                ValueRef::Blob(v) => Value::Binary(
                                    base64::engine::general_purpose::STANDARD.encode(v),
                                ),
                            });
                        }
                        if too_large {
                            break;
                        }
                        result.rows.push(record);
                    }
                    result.duration_ms = start.elapsed().as_millis() as u64;
                    Ok(result)
                })();
                db.progress_handler(0, None::<fn() -> bool>);
                match result {
                    Ok(mut value) => {
                        if value.truncated && !read_only {
                            let _ = db.execute_batch("ROLLBACK");
                            return Err(Error::new(
                                "RESULT_LIMIT",
                                "This statement exceeded the safe result limit. Its transaction was rolled back; narrow the query and run it again.",
                            ));
                        }
                        if writes {
                            value.affected = db.changes();
                        }
                        if expected.is_some_and(|n| n != value.affected) {
                            let _ = db.execute_batch("ROLLBACK");
                            return Err(Error::new(
                                "MUTATION_CONFLICT",
                                "The selected rows changed or no longer match. No changes from this operation were committed. Refresh and review the selection.",
                            ));
                        }
                        if own_transaction {
                            let outcome = if value.truncated {
                                "ROLLBACK"
                            } else {
                                "COMMIT"
                            };
                            if let Err(error) = db.execute_batch(outcome) {
                                let _ = db.execute_batch("ROLLBACK");
                                return Err(error.into());
                            }
                        }
                        if writes {
                            value.affected = db.changes();
                        }
                        Ok(value)
                    }
                    Err(error) => {
                        let _ = db.execute_batch("ROLLBACK");
                        Err(error)
                    }
                }
            }
        }
    }
    pub fn tables(&mut self) -> Result<Vec<TableRef>, Error> {
        if let Some((time, tables)) = &self.tables_cache
            && time.elapsed() < Duration::from_secs(60)
        {
            return Ok(tables.clone());
        }
        let pg = matches!(&self.driver, Driver::Postgres(_));
        let sql = if self.is_mssql() {
            "SELECT s.name,o.name,CASE WHEN o.type='V' THEN 'view' ELSE 'table' END FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name"
        } else if self.is_mysql() {
            "SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_schema,table_name"
        } else if pg {
            "SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name"
        } else {
            "SELECT '',name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        };
        let r = self.query(sql, &[], 10000, true, 30)?;
        if r.truncated {
            return Err(Error::new(
                "METADATA_LIMIT",
                "More than 10,000 tables. Metadata exceeds the supported limit.",
            ));
        }
        let tables: Vec<TableRef> = r
            .rows
            .iter()
            .map(|r| TableRef {
                schema: text(r, 0),
                name: text(r, 1),
                kind: if text(r, 2).to_lowercase().contains("view") {
                    "view".into()
                } else {
                    "table".into()
                },
            })
            .collect();
        self.tables_cache = Some((Instant::now(), tables.clone()));
        Ok(tables)
    }
    pub fn metadata(&mut self, table: &TableRef) -> Result<Metadata, Error> {
        if let Some((time, _, metadata)) = self.metadata_cache.get(table)
            && time.elapsed() < Duration::from_secs(60)
        {
            return Ok(metadata.clone());
        }
        let metadata = match &self.driver {
            Driver::Sqlite(_) => self.sqlite_metadata(table),
            Driver::Postgres(_) => self.pg_metadata(table),
            Driver::Mysql(_) => self.mysql_metadata(table),
            Driver::Mssql(_) => self.mssql_metadata(table),
        }?;
        if let Some((_, size, _)) = self.metadata_cache.remove(table) {
            self.metadata_cache_bytes = self.metadata_cache_bytes.saturating_sub(size);
        }
        let size = serde_json::to_vec(&metadata)
            .map(|value| value.len())
            .unwrap_or(usize::MAX);
        if size <= 16 * 1024 * 1024 {
            while self.metadata_cache.len() >= 256
                || self.metadata_cache_bytes.saturating_add(size) > 16 * 1024 * 1024
            {
                let oldest = self
                    .metadata_cache
                    .iter()
                    .min_by_key(|(_, entry)| entry.0)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    if let Some((_, bytes, _)) = self.metadata_cache.remove(&oldest) {
                        self.metadata_cache_bytes = self.metadata_cache_bytes.saturating_sub(bytes);
                    }
                } else {
                    break;
                }
            }
            self.metadata_cache_bytes += size;
            self.metadata_cache
                .insert(table.clone(), (Instant::now(), size, metadata.clone()));
        }
        Ok(metadata)
    }
    fn sqlite_metadata(&mut self, table: &TableRef) -> Result<Metadata, Error> {
        let p = [Value::Text(table.name.clone())];
        let rows=self.query("SELECT name,type,\"notnull\",dflt_value,pk FROM pragma_table_xinfo(?1) WHERE hidden<>1",&p,10000,true,30)?;
        let mut columns = rows
            .rows
            .iter()
            .map(|r| Column {
                name: text(r, 0),
                data_type: text(r, 1),
                nullable: text(r, 2) != "1",
                default_value: r.get(3).and_then(Value::text),
                pk: text(r, 4).parse().unwrap_or(0),
                enum_type: None,
            })
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Err(Error::new(
                "TABLE_MISSING",
                "The table or view no longer exists.",
            ));
        }
        let fk=self.query("SELECT id,seq,\"table\",\"from\",\"to\" FROM pragma_foreign_key_list(?1) ORDER BY id,seq",&p,10000,true,30)?;
        let mut foreign_keys: Vec<ForeignKey> = Vec::new();
        for r in &fk.rows {
            let name = format!("fk_{}_{}", table.name, text(r, 0));
            let idx = foreign_keys
                .iter()
                .position(|f| f.name == name)
                .unwrap_or_else(|| {
                    foreign_keys.push(ForeignKey {
                        name: name.clone(),
                        from: table.clone(),
                        to: TableRef {
                            schema: String::new(),
                            name: text(r, 2),
                            kind: "table".into(),
                        },
                        columns: vec![],
                        target_columns: vec![],
                    });
                    foreign_keys.len() - 1
                });
            foreign_keys[idx].columns.push(text(r, 3));
            foreign_keys[idx].target_columns.push(text(r, 4));
        }
        for key in &mut foreign_keys {
            if key.target_columns.iter().any(|c| c.is_empty()) {
                let target = self.query(
                    "SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk",
                    &[Value::Text(key.to.name.clone())],
                    1000,
                    true,
                    30,
                )?;
                key.target_columns = target.rows.iter().map(|r| text(r, 0)).collect();
            }
        }
        let ix = self.query(
            "SELECT name,\"unique\",partial,origin FROM pragma_index_list(?1)",
            &p,
            10000,
            true,
            30,
        )?;
        let has_primary_index = ix.rows.iter().any(|row| text(row, 3) == "pk");
        if !has_primary_index && columns.iter().filter(|column| column.pk > 0).count() == 1 {
            for column in &mut columns {
                if column.pk > 0 && column.data_type.eq_ignore_ascii_case("INTEGER") {
                    column.nullable = false;
                }
            }
        }
        let mut indexes = Vec::new();
        for r in ix.rows {
            let name = text(&r, 0);
            let cols = self.query(
                "SELECT name FROM pragma_index_info(?1) ORDER BY seqno",
                &[Value::Text(name.clone())],
                10000,
                true,
                30,
            )?;
            indexes.push(Index {
                name,
                unique: text(&r, 1) == "1",
                partial: text(&r, 2) == "1",
                columns: cols.rows.iter().map(|r| text(r, 0)).collect(),
            });
        }
        Ok(Metadata {
            table: table.clone(),
            columns,
            foreign_keys,
            indexes,
            enums: vec![],
        })
    }
    fn pg_metadata(&mut self, table: &TableRef) -> Result<Metadata, Error> {
        let p = [
            Value::Text(table.schema.clone()),
            Value::Text(table.name.clone()),
        ];
        let r=self.query("SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,pg_get_expr(d.adbin,d.adrelid),COALESCE(array_position(i.indkey::smallint[],a.attnum)+1,0),CASE WHEN t.typtype='e' THEN tn.nspname END,CASE WHEN t.typtype='e' THEN t.typname END FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_catalog.pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",&p,10000,true,30)?;
        let columns = r
            .rows
            .iter()
            .map(|r| Column {
                name: text(r, 0),
                data_type: text(r, 1),
                nullable: text(r, 2) == "true",
                default_value: r.get(3).and_then(Value::text),
                pk: text(r, 4).parse().unwrap_or(0),
                enum_type: r
                    .get(5)
                    .and_then(Value::text)
                    .zip(r.get(6).and_then(Value::text))
                    .map(|(schema, name)| EnumRef { schema, name }),
            })
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Err(Error::new(
                "TABLE_MISSING",
                "The table or view no longer exists.",
            ));
        }
        let r=self.query("SELECT con.conname,tn.nspname,tc.relname,sa.attname,ta.attname FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class sc ON sc.oid=con.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid=sc.relnamespace JOIN pg_catalog.pg_class tc ON tc.oid=con.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(src,dst,pos) JOIN pg_catalog.pg_attribute sa ON sa.attrelid=sc.oid AND sa.attnum=k.src JOIN pg_catalog.pg_attribute ta ON ta.attrelid=tc.oid AND ta.attnum=k.dst WHERE con.contype='f' AND sn.nspname=$1 AND sc.relname=$2 ORDER BY con.conname,k.pos",&p,10000,true,30)?;
        let mut foreign_keys: Vec<ForeignKey> = Vec::new();
        for r in r.rows {
            let name = text(&r, 0);
            let idx = foreign_keys
                .iter()
                .position(|f| f.name == name)
                .unwrap_or_else(|| {
                    foreign_keys.push(ForeignKey {
                        name: name.clone(),
                        from: table.clone(),
                        to: TableRef {
                            schema: text(&r, 1),
                            name: text(&r, 2),
                            kind: "table".into(),
                        },
                        columns: vec![],
                        target_columns: vec![],
                    });
                    foreign_keys.len() - 1
                });
            foreign_keys[idx].columns.push(text(&r, 3));
            foreign_keys[idx].target_columns.push(text(&r, 4));
        }
        let enum_rows=self.query("SELECT DISTINCT tn.nspname,t.typname,e.enumlabel,e.enumsortorder FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid AND t.typtype='e' JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY tn.nspname,t.typname,e.enumsortorder",&p,10000,true,30)?;
        let mut enum_values: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        for row in enum_rows.rows {
            enum_values
                .entry((text(&row, 0), text(&row, 1)))
                .or_default()
                .push(text(&row, 2));
        }
        if enum_rows.truncated {
            return Err(Error::new(
                "METADATA_LIMIT",
                "Enum metadata exceeds the supported limit.",
            ));
        }
        let enums = enum_values
            .into_iter()
            .map(|((schema, name), values)| EnumType {
                schema,
                name,
                values,
            })
            .collect();
        let r=self.query("SELECT ic.relname,ix.indisunique,a.attname,ix.indpred IS NOT NULL FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class c ON c.oid=ix.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class ic ON ic.oid=ix.indexrelid CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(num,pos) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num WHERE n.nspname=$1 AND c.relname=$2 AND k.pos<=ix.indnkeyatts ORDER BY ic.relname,k.pos",&p,10000,true,30)?;
        let mut indexes: Vec<Index> = vec![];
        for r in r.rows {
            let name = text(&r, 0);
            let idx = indexes
                .iter()
                .position(|i| i.name == name)
                .unwrap_or_else(|| {
                    indexes.push(Index {
                        name: name.clone(),
                        unique: text(&r, 1) == "true",
                        partial: text(&r, 3) == "true",
                        columns: vec![],
                    });
                    indexes.len() - 1
                });
            indexes[idx].columns.push(text(&r, 2));
        }
        Ok(Metadata {
            table: table.clone(),
            columns,
            foreign_keys,
            indexes,
            enums,
        })
    }
    pub fn incoming_foreign_keys(
        &mut self,
        table: &TableRef,
        metadata: &Metadata,
    ) -> Result<Vec<ForeignKey>, Error> {
        if let Some((time, _, keys)) = self.incoming_cache.get(table)
            && time.elapsed() < Duration::from_secs(60)
        {
            return Ok(keys.clone());
        }
        let keys = self.load_incoming_foreign_keys(table, metadata)?;
        let size = serde_json::to_vec(&keys)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if let Some((_, bytes, _)) = self.incoming_cache.remove(table) {
            self.incoming_cache_bytes = self.incoming_cache_bytes.saturating_sub(bytes);
        }
        if size <= 16 * 1024 * 1024 {
            while self.incoming_cache.len() >= 256
                || self.incoming_cache_bytes.saturating_add(size) > 16 * 1024 * 1024
            {
                let oldest = self
                    .incoming_cache
                    .iter()
                    .min_by_key(|(_, entry)| entry.0)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    if let Some((_, bytes, _)) = self.incoming_cache.remove(&oldest) {
                        self.incoming_cache_bytes = self.incoming_cache_bytes.saturating_sub(bytes);
                    }
                } else {
                    break;
                }
            }
            self.incoming_cache_bytes += size;
            self.incoming_cache
                .insert(table.clone(), (Instant::now(), size, keys.clone()));
        }
        Ok(keys)
    }
    fn load_incoming_foreign_keys(
        &mut self,
        table: &TableRef,
        metadata: &Metadata,
    ) -> Result<Vec<ForeignKey>, Error> {
        if self.is_mssql() {
            return self.mssql_foreign_keys(table, true);
        }
        if self.is_mysql() {
            return self.mysql_foreign_keys(table, true);
        }
        let pg = matches!(&self.driver, Driver::Postgres(_));
        let (sql, params) = if pg {
            (
                "SELECT sn.nspname,sc.relname,con.conname,sa.attname,ta.attname FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class sc ON sc.oid=con.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid=sc.relnamespace JOIN pg_catalog.pg_class tc ON tc.oid=con.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(src,dst,pos) JOIN pg_catalog.pg_attribute sa ON sa.attrelid=sc.oid AND sa.attnum=k.src JOIN pg_catalog.pg_attribute ta ON ta.attrelid=tc.oid AND ta.attnum=k.dst WHERE con.contype='f' AND tn.nspname=$1 AND tc.relname=$2 ORDER BY sn.nspname,sc.relname,con.conname,k.pos",
                vec![
                    Value::Text(table.schema.clone()),
                    Value::Text(table.name.clone()),
                ],
            )
        } else {
            (
                "SELECT '',s.name,CAST(f.id AS TEXT),f.\"from\",f.\"to\",f.seq FROM sqlite_schema s JOIN pragma_foreign_key_list(s.name) f WHERE s.type='table' AND f.\"table\"=?1 ORDER BY s.name,f.id,f.seq",
                vec![Value::Text(table.name.clone())],
            )
        };
        let result = self.query(sql, &params, 10000, true, 30)?;
        if result.truncated {
            return Err(Error::new(
                "RELATIONSHIP_LIMIT",
                "Incoming metadata exceeds 10,000 foreign-key columns.",
            ));
        }
        let mut pk: Vec<_> = metadata.columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        let mut keys: BTreeMap<(String, String, String), ForeignKey> = BTreeMap::new();
        for row in result.rows {
            let schema = text(&row, 0);
            let from = text(&row, 1);
            let name = if pg {
                text(&row, 2)
            } else {
                format!("fk_{}_{}", from, text(&row, 2))
            };
            let key = keys
                .entry((schema.clone(), from.clone(), name.clone()))
                .or_insert_with(|| ForeignKey {
                    name,
                    from: TableRef {
                        schema,
                        name: from,
                        kind: "table".into(),
                    },
                    to: table.clone(),
                    columns: Vec::new(),
                    target_columns: Vec::new(),
                });
            key.columns.push(text(&row, 3));
            let mut target = text(&row, 4);
            if !pg && target.is_empty() {
                let seq = text(&row, 5).parse::<usize>().unwrap_or(usize::MAX);
                target = pk.get(seq).map(|c| c.name.clone()).ok_or_else(|| {
                    Error::new(
                        "METADATA",
                        "Implicit foreign key lacks a complete target primary key.",
                    )
                })?;
            }
            key.target_columns.push(target);
        }
        Ok(keys.into_values().collect())
    }
    pub fn table_definition(&mut self, table: &TableRef) -> Result<Option<String>, Error> {
        if self.is_mssql() {
            let r=self.query("SELECT OBJECT_DEFINITION(o.object_id) FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=?1 AND o.name=?2",&[Value::Text(table.schema.clone()),Value::Text(table.name.clone())],1,true,5)?;
            return Ok(r.rows.first().and_then(|r| r.first()).and_then(Value::text));
        }
        if self.is_mysql() {
            let r = self.query(
                &format!("SHOW CREATE TABLE {}", qualified(table)),
                &[],
                1,
                true,
                5,
            )?;
            return Ok(r.rows.first().and_then(|r| r.get(1)).and_then(Value::text));
        }
        if matches!(&self.driver, Driver::Postgres(_)) {
            return Ok(None);
        }
        let result = self.query(
            "SELECT sql FROM sqlite_schema WHERE name=?1 AND type IN ('table','view')",
            &[Value::Text(table.name.clone())],
            1,
            true,
            5,
        )?;
        Ok(result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(Value::text))
    }
    pub fn update_cell(
        &mut self,
        record: &RecordRef,
        column: &str,
        before: &Value,
        value: &Value,
    ) -> Result<(), Error> {
        self.update_cells(record, &[(column, before, value)])
    }
    pub fn update_cells(
        &mut self,
        record: &RecordRef,
        changes: &[(&str, &Value, &Value)],
    ) -> Result<(), Error> {
        self.refresh_metadata();
        self.require_transactional_table(&record.table)?;
        let metadata = self.metadata(&record.table)?;
        let keys = identity_columns(&metadata);
        if keys.is_empty()
            || keys.len() != record.key.len()
            || keys
                .iter()
                .any(|key| record.key.get(key).is_none_or(|v| matches!(v, Value::Null)))
        {
            return Err(Error::new(
                "IDENTITY",
                "Editing requires a complete, non-null unique record key.",
            ));
        }
        // Resolve the actual object kind rather than trusting the frontend's table hint.
        let tables = self.tables()?;
        if !tables.iter().any(|t| {
            t.schema == record.table.schema && t.name == record.table.name && t.kind == "table"
        }) {
            return Err(Error::new(
                "EDIT_UNSUPPORTED",
                "Only base tables can be edited.",
            ));
        }
        let pg = matches!(&self.driver, Driver::Postgres(_));
        let mut params = Vec::new();
        let mut assignments = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        if changes.is_empty() || changes.len() > 500 {
            return Err(Error::new(
                "VALIDATION",
                "Provide between 1 and 500 field changes.",
            ));
        }
        for &(column, before, value) in changes {
            if !names.insert(column) {
                return Err(Error::new(
                    "VALIDATION",
                    "A field can only be changed once.",
                ));
            }
            let field = metadata
                .columns
                .iter()
                .find(|c| c.name == column)
                .ok_or_else(|| Error::new("VALIDATION", "The column no longer exists."))?;
            if keys.iter().any(|key| key == column) || field.pk > 0 {
                return Err(Error::new(
                    "EDIT_IDENTITY",
                    "Record identity columns cannot be changed in the cell editor.",
                ));
            }
            if matches!(value, Value::Null) && !field.nullable {
                return Err(Error::new("VALIDATION", "This column does not allow NULL."));
            }
            if matches!(
                before,
                Value::Binary(_) | Value::Unknown(_) | Value::Array(_)
            ) || matches!(
                value,
                Value::Binary(_) | Value::Unknown(_) | Value::Array(_)
            ) {
                return Err(Error::new(
                    "EDIT_UNSUPPORTED",
                    "Binary, array, and custom values require an explicit SQL query.",
                ));
            }
            params.push(value.clone());
            assignments.push(format!(
                "{} = {}",
                quote(column),
                placeholder(pg, params.len())
            ));
        }
        let mut predicates = Vec::new();
        for key in &keys {
            params.push(record.key[key].clone());
            predicates.push(format!(
                "{} = {}",
                quote(key),
                placeholder(pg, params.len())
            ));
        }
        let identity_predicate = predicates.join(" AND ");
        for &(column, before, _) in changes {
            if matches!(before, Value::Null) {
                predicates.push(format!("{} IS NULL", quote(column)));
            } else {
                params.push(before.clone());
                // PostgreSQL JSON has no equality operator; compare its textual representation.
                let comparison = if pg
                    && metadata
                        .columns
                        .iter()
                        .any(|f| f.name == column && f.data_type.eq_ignore_ascii_case("json"))
                {
                    format!("{}::text", quote(column))
                } else {
                    quote(column)
                };
                predicates.push(format!("{comparison} = {}", placeholder(pg, params.len())));
            }
        }
        let sql = format!(
            "UPDATE {} SET {} WHERE {}{}",
            qualified(&record.table),
            assignments.join(", "),
            predicates.join(" AND "),
            if self.is_mysql() {
                String::new()
            } else {
                format!(
                    " AND (SELECT COUNT(*) FROM {} WHERE {}) = 1",
                    qualified(&record.table),
                    identity_predicate
                )
            }
        );
        let result = self.query_checked(&sql, &params, 1, false, 30, Some(1)).map_err(|error| {
            if ["MUTATION_CONFLICT", "WRITE_CONFLICT"].contains(&error.code.as_str()) {
                Error::new("EDIT_CONFLICT", "An edited cell changed or disappeared. No changes were saved. Refresh and review the current values before trying again.")
            } else { error }
        })?;
        if result.affected == 0 {
            return Err(Error::new(
                "EDIT_CONFLICT",
                "This cell changed or the record disappeared. Refresh the table and review its current value before editing again.",
            ));
        }
        Ok(())
    }
    pub fn browse(&mut self, request: &BrowseRequest) -> Result<ResultSet, Error> {
        self.browse_with_timeout(request, 30)
    }
    pub fn browse_statement(
        &mut self,
        request: &BrowseRequest,
    ) -> Result<(String, Vec<Value>, u32), Error> {
        self.browse_statement_mode(request, true)
    }
    fn browse_statement_mode(
        &mut self,
        request: &BrowseRequest,
        paginated: bool,
    ) -> Result<(String, Vec<Value>, u32), Error> {
        let metadata = self.metadata(&request.table)?;
        let pg = matches!(&self.driver, Driver::Postgres(_));
        let mut params = vec![];
        let mut predicates = vec![];
        if request.filter_groups.len() > 16
            || request.filters.len()
                + request
                    .filter_groups
                    .iter()
                    .map(|g| g.filters.len())
                    .sum::<usize>()
                > 100
        {
            return Err(Error::new(
                "FILTER_LIMIT",
                "Use at most 16 groups and 100 conditions.",
            ));
        }
        if !["all", "any"].contains(&request.group_mode.as_str()) {
            return Err(Error::new("VALIDATION", "Invalid filter group mode."));
        }
        let mut groups = vec![];
        for group in std::iter::once(FilterGroup {
            mode: "all".into(),
            filters: request.filters.clone(),
        })
        .chain(request.filter_groups.clone())
        {
            if !["all", "any"].contains(&group.mode.as_str()) {
                return Err(Error::new("VALIDATION", "Invalid filter mode."));
            }
            let mut group_parts = vec![];
            for f in &group.filters {
                if !metadata.columns.iter().any(|c| c.name == f.column) {
                    return Err(Error::new("VALIDATION", "Unknown filter column."));
                }
                let col = quote(&f.column);
                let operator = match f.operator.as_str() {
                    "eq" => "=",
                    "ne" => "<>",
                    "gt" => ">",
                    "lt" => "<",
                    "gte" => ">=",
                    "lte" => "<=",
                    "contains" => "LIKE",
                    "startsWith" => "LIKE",
                    "endsWith" => "LIKE",
                    "like" => "LIKE",
                    "notLike" => "NOT LIKE",
                    "ilike" if pg => "ILIKE",
                    "notIlike" if pg => "NOT ILIKE",
                    "null" => "IS NULL",
                    "notNull" => "IS NOT NULL",
                    _ => return Err(Error::new("VALIDATION", "Unsupported filter operator.")),
                };
                if f.operator == "null" || f.operator == "notNull" {
                    group_parts.push(format!("{col} {operator}"));
                } else if matches!(f.value, Value::Null) {
                    if !["eq", "ne"].contains(&f.operator.as_str()) {
                        return Err(Error::new(
                            "VALIDATION",
                            "NULL supports only equality or explicit null filters.",
                        ));
                    }
                    group_parts.push(format!(
                        "{col} IS {}NULL",
                        if f.operator == "ne" { "NOT " } else { "" }
                    ));
                } else {
                    let value =
                        if ["contains", "startsWith", "endsWith"].contains(&f.operator.as_str()) {
                            let literal = f
                                .value
                                .text()
                                .unwrap_or_default()
                                .replace('!', "!!")
                                .replace('%', "!%")
                                .replace('_', "!_");
                            Value::Text(match f.operator.as_str() {
                                "startsWith" => format!("{literal}%"),
                                "endsWith" => format!("%{literal}"),
                                _ => format!("%{literal}%"),
                            })
                        } else {
                            f.value.clone()
                        };
                    params.push(value);
                    group_parts.push(format!(
                        "{col} {operator} {}{}",
                        placeholder(pg, params.len()),
                        if ["contains", "startsWith", "endsWith"].contains(&f.operator.as_str()) {
                            " ESCAPE '!'"
                        } else {
                            ""
                        }
                    ));
                }
            }
            if !group_parts.is_empty() {
                groups.push(format!(
                    "({})",
                    group_parts.join(if group.mode == "any" { " OR " } else { " AND " })
                ));
            }
        }
        // Legacy filters remain an AND scope, while explicit groups use their selected root join.
        if !groups.is_empty() {
            if !request.filters.is_empty() {
                predicates.push(groups.remove(0));
            }
            if !groups.is_empty() {
                predicates.push(format!(
                    "({})",
                    groups.join(if request.group_mode == "any" {
                        " OR "
                    } else {
                        " AND "
                    })
                ));
            }
        }
        let mut order = Vec::new();
        let keyset_keys = identity_columns(&metadata);
        let keyset_supported = paginated
            && request.keyset
            && request.sort.is_empty()
            && !keyset_keys.is_empty()
            && keyset_keys.len() <= 16
            && keyset_keys
                .iter()
                .all(|key| cursor_column_supported(&metadata, key));
        if paginated && request.cursor.is_some() && !keyset_supported {
            return Err(Error::new(
                "CURSOR_UNSUPPORTED",
                "Cursor paging is unavailable for this table or sort. Reset paging and use offset navigation.",
            ));
        }
        if paginated && let Some(cursor) = request.cursor.as_ref() {
            if cursor.len() != keyset_keys.len()
                || cursor.iter().any(|value| !cursor_value_supported(value))
            {
                return Err(Error::new(
                    "CURSOR_INVALID",
                    "The page cursor does not match this table's stable key.",
                ));
            }
            predicates.push(cursor_predicate(
                &keyset_keys,
                cursor,
                request.descending,
                &mut params,
                pg,
            ));
        }
        if paginated && !request.sort.is_empty() {
            if !metadata.columns.iter().any(|c| c.name == request.sort) {
                return Err(Error::new("VALIDATION", "Unknown sort column."));
            }
            order.push(format!(
                "{} {}",
                quote(&request.sort),
                if request.descending { "DESC" } else { "ASC" }
            ));
        }
        for key in &keyset_keys {
            if key != &request.sort {
                order.push(if keyset_supported && request.descending {
                    format!("{} DESC", quote(key))
                } else {
                    quote(key)
                });
            }
        }
        let mut sql = format!("SELECT * FROM {}", qualified(&request.table));
        if !predicates.is_empty() {
            sql.push_str(&format!(" WHERE {}", predicates.join(" AND ")));
        }
        if paginated && !order.is_empty() {
            sql.push_str(&format!(" ORDER BY {}", order.join(",")));
        }
        let limit = request.limit.clamp(1, 1001);
        if paginated && self.is_mssql() {
            if order.is_empty() {
                sql.push_str(" ORDER BY (SELECT NULL)");
            }
            let page_offset = if keyset_supported { 0 } else { request.offset };
            params.push(Value::Integer(page_offset.to_string()));
            let offset = placeholder(pg, params.len());
            params.push(Value::Integer((limit + 1).to_string()));
            sql.push_str(&format!(
                " OFFSET {offset} ROWS FETCH NEXT {} ROWS ONLY",
                placeholder(pg, params.len())
            ));
        } else if paginated {
            params.push(Value::Integer((limit + 1).to_string()));
            let lim = placeholder(pg, params.len());
            sql.push_str(&format!(" LIMIT {lim}"));
            if !keyset_supported {
                params.push(Value::Integer(request.offset.to_string()));
                sql.push_str(&format!(" OFFSET {}", placeholder(pg, params.len())));
            }
        }
        Ok((sql, params, limit))
    }
    fn count_statement(&mut self, request: &BrowseRequest) -> Result<u64, Error> {
        let (query, params, _) = self.browse_statement_mode(request, false)?;
        let count = if self.is_mssql() {
            "COUNT_BIG(*)"
        } else {
            "COUNT(*)"
        };
        let sql = format!("SELECT {count} FROM ({query}) AS kitsune_count_scope");
        let result = self.query(&sql, &params, 1, true, 10)?;
        result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(Value::text)
            .and_then(|count| count.parse::<u64>().ok())
            .ok_or_else(|| {
                Error::new(
                    "COUNT_UNAVAILABLE",
                    "The database did not return a usable row count.",
                )
            })
    }
    pub fn count_rows(&mut self, request: &BrowseRequest) -> Result<RowCounts, Error> {
        let matching = self.count_statement(request)?;
        let has_filters = !request.filters.is_empty()
            || request
                .filter_groups
                .iter()
                .any(|group| !group.filters.is_empty());
        if !has_filters {
            return Ok(RowCounts {
                matching,
                total: matching,
            });
        }
        let mut total_request = request.clone();
        total_request.filters.clear();
        total_request.filter_groups.clear();
        total_request.group_mode = "all".into();
        let total = self.count_statement(&total_request)?;
        Ok(RowCounts { matching, total })
    }
    pub fn estimate_rows(&mut self, table: &TableRef) -> Result<RowEstimate, Error> {
        self.metadata(table)?;
        if table.kind.eq_ignore_ascii_case("view") {
            return Ok(RowEstimate {
                total: None,
                source: "No table statistics are available for views".into(),
            });
        }
        let estimate = if self.is_mssql() {
            let result = self.query(
                "SELECT SUM(p.rows) FROM sys.partitions p JOIN sys.tables t ON t.object_id=p.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=COALESCE(NULLIF(?1,''),SCHEMA_NAME()) AND t.name=?2 AND p.index_id IN (0,1)",
                &[
                    Value::Text(table.schema.clone()),
                    Value::Text(table.name.clone()),
                ],
                1,
                true,
                10,
            )?;
            (estimated_value(&result), "SQL Server partition statistics")
        } else if self.is_mysql() {
            let result = self.query(
                "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA=COALESCE(NULLIF(?1,''),DATABASE()) AND TABLE_NAME=?2 AND TABLE_TYPE='BASE TABLE'",
                &[
                    Value::Text(table.schema.clone()),
                    Value::Text(table.name.clone()),
                ],
                1,
                true,
                10,
            )?;
            (estimated_value(&result), "MySQL/MariaDB table statistics")
        } else if matches!(&self.driver, Driver::Postgres(_)) {
            let result = self.query(
                "SELECT CASE WHEN c.reltuples>=0 THEN c.reltuples::bigint ELSE NULL END FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=COALESCE(NULLIF($1,''),current_schema()) AND c.relname=$2 AND c.relkind IN ('r','p')",
                &[
                    Value::Text(table.schema.clone()),
                    Value::Text(table.name.clone()),
                ],
                1,
                true,
                10,
            )?;
            (estimated_value(&result), "PostgreSQL planner statistics")
        } else {
            let stats_exist = self.query(
                "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_stat1'",
                &[],
                1,
                true,
                10,
            )?;
            if stats_exist.rows.is_empty() {
                return Ok(RowEstimate {
                    total: None,
                    source: "Run ANALYZE to collect SQLite row estimates".into(),
                });
            }
            let metadata = self.metadata(table)?;
            let indexes: Vec<_> = metadata
                .indexes
                .iter()
                .filter(|index| !index.partial)
                .map(|index| index.name.clone())
                .collect();
            if indexes.is_empty() {
                return Ok(RowEstimate {
                    total: None,
                    source: "No full-index SQLite statistics are available".into(),
                });
            }
            let mut params = vec![Value::Text(table.name.clone())];
            let mut index_placeholders = Vec::with_capacity(indexes.len());
            for index in indexes {
                params.push(Value::Text(index));
                index_placeholders.push(placeholder(false, params.len()));
            }
            let sql = format!(
                "SELECT MAX(CAST(substr(stat,1,instr(stat||' ',' ')-1) AS INTEGER)) FROM sqlite_stat1 WHERE tbl=?1 AND idx IN ({})",
                index_placeholders.join(",")
            );
            let result = self.query(&sql, &params, 1, true, 10)?;
            (estimated_value(&result), "SQLite ANALYZE statistics")
        };
        Ok(RowEstimate {
            total: estimate.0,
            source: estimate.1.into(),
        })
    }
    pub fn index_advice(&mut self, table: &TableRef) -> Result<IndexAdvice, Error> {
        const MAX_RECOMMENDATIONS: usize = 200;
        let metadata = self.metadata(table)?;
        let mut recommendations = Vec::new();
        let mut truncated = false;
        for foreign_key in &metadata.foreign_keys {
            if !has_supporting_index(&metadata.indexes, &foreign_key.columns) {
                recommendations.push(IndexRecommendation {
                    table: table.clone(),
                    related_table: foreign_key.to.clone(),
                    foreign_key: foreign_key.name.clone(),
                    columns: foreign_key.columns.clone(),
                    direction: "outgoing".into(),
                });
            }
            if recommendations.len() >= MAX_RECOMMENDATIONS {
                truncated = true;
                break;
            }
        }
        if !truncated {
            let incoming = self.incoming_foreign_keys(table, &metadata)?;
            for foreign_key in incoming {
                let child = self.metadata(&foreign_key.from)?;
                if !has_supporting_index(&child.indexes, &foreign_key.columns) {
                    recommendations.push(IndexRecommendation {
                        table: foreign_key.from.clone(),
                        related_table: table.clone(),
                        foreign_key: foreign_key.name,
                        columns: foreign_key.columns,
                        direction: "incoming".into(),
                    });
                }
                if recommendations.len() >= MAX_RECOMMENDATIONS {
                    truncated = true;
                    break;
                }
            }
        }
        Ok(IndexAdvice {
            recommendations,
            truncated,
        })
    }
    pub fn browse_with_timeout(
        &mut self,
        request: &BrowseRequest,
        timeout: u64,
    ) -> Result<ResultSet, Error> {
        let metadata = self.metadata(&request.table)?;
        let keys = identity_columns(&metadata);
        let keyset_supported = request.keyset
            && request.sort.is_empty()
            && !keys.is_empty()
            && keys.len() <= 16
            && keys
                .iter()
                .all(|key| cursor_column_supported(&metadata, key));
        let (sql, params, limit) = self.browse_statement(request)?;
        let mut r = self.query(&sql, &params, (limit + 1) as usize, true, timeout)?;
        if r.rows.len() > limit as usize {
            r.rows.truncate(limit as usize);
            r.truncated = true;
        }
        r.keyset_supported = keyset_supported;
        if keyset_supported && r.truncated {
            r.next_cursor = r.rows.last().and_then(|row| {
                keys.iter()
                    .map(|key| {
                        let index = r.columns.iter().position(|column| column == key)?;
                        let value = row.get(index)?;
                        cursor_value_supported(value).then(|| value.clone())
                    })
                    .collect::<Option<Vec<_>>>()
            });
            if r.next_cursor.is_none() {
                r.keyset_supported = false;
            }
        }
        Ok(r)
    }
}
pub fn qualified(table: &TableRef) -> String {
    if table.schema.is_empty() {
        quote(&table.name)
    } else {
        format!("{}.{}", quote(&table.schema), quote(&table.name))
    }
}
fn placeholder(pg: bool, index: usize) -> String {
    format!("{}{index}", if pg { "$" } else { "?" })
}
fn text(row: &[Value], index: usize) -> String {
    row.get(index).and_then(Value::text).unwrap_or_default()
}
fn sql_value(v: &Value) -> Result<SqlValue, Error> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Boolean(b) => SqlValue::Integer(i64::from(*b)),
        Value::Integer(n) => SqlValue::Integer(n.parse().map_err(|_| {
            Error::new(
                "VALUE_RANGE",
                "Integer is outside SQLite's signed 64-bit range.",
            )
        })?),
        Value::Float(n) => SqlValue::Real(
            n.parse()
                .map_err(|_| Error::new("VALUE_RANGE", "Invalid floating point value."))?,
        ),
        Value::Binary(s) => SqlValue::Blob(
            base64::engine::general_purpose::STANDARD
                .decode(s)
                .map_err(|_| Error::new("VALUE_ENCODING", "Invalid binary encoding."))?,
        ),
        _ => SqlValue::Text(v.text().unwrap_or_default()),
    })
}
pub fn record_key(
    metadata: &Metadata,
    row: &[Value],
    columns: &[String],
) -> BTreeMap<String, Value> {
    let mut key = BTreeMap::new();
    for column in identity_columns(metadata) {
        if columns.iter().filter(|c| *c == &column).count() != 1 {
            return BTreeMap::new();
        }
        let Some(i) = columns.iter().position(|c| c == &column) else {
            return BTreeMap::new();
        };
        let Some(value) = row.get(i) else {
            return BTreeMap::new();
        };
        if matches!(value, Value::Null) {
            return BTreeMap::new();
        }
        key.insert(column, value.clone());
    }
    key
}
pub fn record_filters(key: &BTreeMap<String, Value>) -> Vec<Filter> {
    key.iter()
        .map(|(column, value)| Filter {
            column: column.clone(),
            operator: "eq".into(),
            value: value.clone(),
        })
        .collect()
}

pub fn identity_columns(metadata: &Metadata) -> Vec<String> {
    let mut pk: Vec<_> = metadata.columns.iter().filter(|c| c.pk > 0).collect();
    pk.sort_by_key(|c| c.pk);
    if !pk.is_empty() {
        return pk.into_iter().map(|c| c.name.clone()).collect();
    }
    metadata
        .indexes
        .iter()
        .find(|i| {
            i.unique
                && !i.partial
                && !i.columns.is_empty()
                && i.columns.iter().all(|name| {
                    metadata
                        .columns
                        .iter()
                        .any(|c| &c.name == name && !c.nullable)
                })
        })
        .map(|i| i.columns.clone())
        .unwrap_or_default()
}
fn estimated_value(result: &ResultSet) -> Option<u64> {
    result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(Value::text)
        .and_then(|value| value.parse::<u64>().ok())
}
fn has_supporting_index(indexes: &[Index], columns: &[String]) -> bool {
    !columns.is_empty()
        && indexes.iter().any(|index| {
            !index.partial
                && index.columns.len() >= columns.len()
                && index.columns.iter().take(columns.len()).eq(columns.iter())
        })
}
fn cursor_column_supported(metadata: &Metadata, name: &str) -> bool {
    let Some(column) = metadata.columns.iter().find(|column| column.name == name) else {
        return false;
    };
    if column.enum_type.is_some() {
        return true;
    }
    let kind = column.data_type.to_lowercase();
    kind.is_empty()
        || [
            "int",
            "serial",
            "numeric",
            "decimal",
            "real",
            "float",
            "double",
            "number",
            "text",
            "char",
            "varchar",
            "nvarchar",
            "nchar",
            "string",
            "uuid",
            "uniqueidentifier",
            "date",
            "time",
            "bool",
            "bit",
            "enum",
        ]
        .iter()
        .any(|supported| kind.contains(supported))
}
fn cursor_value_supported(value: &Value) -> bool {
    matches!(
        value,
        Value::Boolean(_)
            | Value::Integer(_)
            | Value::Decimal(_)
            | Value::Float(_)
            | Value::Text(_)
            | Value::Date(_)
            | Value::Timestamp(_)
            | Value::Uuid(_)
    )
}
fn cursor_predicate(
    keys: &[String],
    cursor: &[Value],
    descending: bool,
    params: &mut Vec<Value>,
    postgres: bool,
) -> String {
    let comparison = if descending { "<" } else { ">" };
    let mut disjunctions = Vec::with_capacity(keys.len());
    for i in 0..keys.len() {
        let mut conjunctions = Vec::with_capacity(i + 1);
        for j in 0..=i {
            params.push(cursor[j].clone());
            let operator = if i == j { comparison } else { "=" };
            conjunctions.push(format!(
                "{} {operator} {}",
                quote(&keys[j]),
                placeholder(postgres, params.len())
            ));
        }
        disjunctions.push(format!("({})", conjunctions.join(" AND ")));
    }
    format!("({})", disjunctions.join(" OR "))
}
