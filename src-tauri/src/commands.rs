use crate::{
    database::{Database, identity_columns, record_filters},
    model::*,
    monitor,
    state::{AppState, Approval, OperationGuard, QueryOperation, Session, WatchTask},
};
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager};
fn decode<T: serde::de::DeserializeOwned>(value: Json) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|_| Error::new("VALIDATION", "Request fields are missing or invalid."))
}
fn encode<T: serde::Serialize>(value: T) -> Result<Json, Error> {
    serde_json::to_value(value).map_err(|_| Error::new("SERIALIZATION", "Cannot encode response."))
}
fn field<'a>(p: &'a Json, key: &str) -> Result<&'a str, Error> {
    p[key]
        .as_str()
        .ok_or_else(|| Error::new("VALIDATION", "A required text field is missing."))
}
fn locked() -> Error {
    Error::new("STATE", "Application state is unavailable.")
}
fn resolve_password(config: &mut ConnectionConfig) -> Result<(), Error> {
    if config.remember_password && config.password.is_empty() && !config.id.is_empty() {
        match crate::security::credentials::load(&config.id) {
            Ok(password) => config.password = password,
            Err(error) if error.code == "CREDENTIAL_MISSING" => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn api(app: tauri::AppHandle, method: String, payload: Json) -> Result<Json, Error> {
    if method == "cancel_query" {
        let state = app.state::<AppState>();
        let id = field(&payload, "operationId")?;
        if let Some(handle) = state.operations.lock().map_err(|_| locked())?.get(id) {
            handle.cancel();
            return Ok(json!({"requested":true,"serverConfirmed":false}));
        }
        return Ok(json!({"requested":false,"serverConfirmed":false}));
    }
    tokio::task::spawn_blocking(move || dispatch(app, &method, payload))
        .await
        .map_err(|_| Error::new("TASK_FAILED", "The operation could not complete."))?
}
pub(crate) fn dispatch<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    method: &str,
    p: Json,
) -> Result<Json, Error> {
    let state = app.state::<AppState>();
    match method {
        "export_table" => crate::exports::run(&app, p),
        "diagnose_query" => crate::diagnostics::run(&app, p),
        "restore_receipt" | "restore_eligibility" | "preview_restore" | "commit_restore" => {
            crate::restore::handle(&app, method, p)
        }
        "choose_sqlite_file" => crate::file_picker::choose(&app, &p),
        "choose_tls_file" => crate::file_picker::choose_tls(&app),
        "bootstrap" => {
            let configs = state.storage.list::<ConnectionConfig>("connections")?;
            let (active, read_only, transactions) = {
                let sessions = state.sessions.lock().map_err(|_| locked())?;
                let active: Vec<String> = sessions.keys().cloned().collect();
                let read_only: HashMap<String, bool> = sessions
                    .iter()
                    .map(|(id, session)| (id.clone(), session.read_only.load(Ordering::SeqCst)))
                    .collect();
                let mut transactions = HashMap::<String, String>::new();
                for session in sessions.values() {
                    if let Ok(editors) = session.editors.lock() {
                        for (id, e) in editors.iter() {
                            transactions.insert(
                                id.clone(),
                                if e.lost.load(Ordering::SeqCst) {
                                    "lost"
                                } else if e.transaction.load(Ordering::SeqCst) {
                                    "active"
                                } else {
                                    "idle"
                                }
                                .into(),
                            );
                        }
                    }
                }
                (active, read_only, transactions)
            };
            Ok(
                json!({"connections":configs,"active":active,"readOnly":read_only,"transactions":transactions,"watches":state.storage.list::<Watch>("watches")?,"investigations":state.storage.list::<Investigation>("investigations")?,"settings":state.storage.list::<ApplicationSettings>("settings")?.first(),"workspace":state.storage.list::<Json>("workspace")?.first(),"credentialStorage":"operatingSystem"}),
            )
        }
        "save_connection" => {
            let mut config: ConnectionConfig = decode(p)?;
            config.validate()?;
            if config.id.is_empty() {
                config.id = uuid::Uuid::new_v4().to_string();
            }
            let previously_remembered = state
                .storage
                .get::<ConnectionConfig>("connections", &config.id)?
                .is_some_and(|saved| saved.remember_password);
            if config.remember_password && !config.password.is_empty() {
                crate::security::credentials::save(&config.id, &config.password)?;
            } else if !config.remember_password && previously_remembered {
                crate::security::credentials::remove(&config.id)?;
            }
            config.password.clear();
            config.create = false;
            state.stop_connection(&config.id);
            state.storage.put("connections", &config.id, &config)?;
            encode(config)
        }
        "delete_connection" => {
            let id = field(&p, "id")?;
            if state
                .storage
                .get::<ConnectionConfig>("connections", id)?
                .is_some_and(|saved| saved.remember_password)
            {
                crate::security::credentials::remove(id)?;
            }
            state.stop_connection(id);
            state.storage.delete("connections", id)?;
            Ok(Json::Null)
        }
        "test_connection" => {
            let mut config: ConnectionConfig = decode(p)?;
            resolve_password(&mut config)?;
            if config.create {
                return Err(Error::new(
                    "VALIDATION",
                    "Testing cannot create a database. Choose Connect to explicitly create the file.",
                ));
            }
            let _ = Database::open(&config, &state.internal, false)?;
            Ok(json!({"success":true}))
        }
        "connect" => {
            let mut config: ConnectionConfig = decode(p)?;
            resolve_password(&mut config)?;
            config.validate()?;
            let previously_remembered = !config.id.is_empty()
                && state
                    .storage
                    .get::<ConnectionConfig>("connections", &config.id)?
                    .is_some_and(|saved| saved.remember_password);
            if config.id.is_empty() {
                config.id = uuid::Uuid::new_v4().to_string();
            }
            let db = Database::open(&config, &state.internal, false)?;
            if config.remember_password {
                crate::security::credentials::save(&config.id, &config.password)?;
            } else if previously_remembered {
                crate::security::credentials::remove(&config.id)?;
            }
            let mut monitor_config = config.clone();
            monitor_config.create = false;
            let monitor = Database::open(&monitor_config, &state.internal, true)?;
            let readonly = config.environment == "production" || config.read_only;
            state.stop_connection(&config.id);
            let id = config.id.clone();
            let mut saved = config.clone();
            saved.password.clear();
            saved.create = false;
            state.storage.put("connections", &id, &saved)?;
            state.sessions.lock().map_err(|_| locked())?.insert(
                id.clone(),
                Arc::new(Session {
                    access: std::sync::RwLock::new(()),
                    generation: uuid::Uuid::new_v4().to_string(),
                    editors: Mutex::new(HashMap::new()),
                    main_interrupt: Mutex::new(db.interrupt()),
                    monitor_permit: Arc::new(tokio::sync::Semaphore::new(1)),
                    config,
                    db: Mutex::new(db),
                    monitor: Mutex::new(monitor),
                    read_only: AtomicBool::new(readonly),
                    connected: AtomicBool::new(true),
                }),
            );
            Ok(
                json!({"id":id,"readOnly":readonly,"capabilities":{"supportsSchemas":saved.driver!="sqlite","supportsForeignKeys":true,"supportsQueryCancellation":true,"supportsExplain":true,"supportsTransactionalDdl":saved.driver!="mysql","supportsReturning":saved.driver!="mysql"&&saved.driver!="mssql","supportsHistoricalRestore":saved.driver!="mssql","supportsNotifications":false}}),
            )
        }
        "disconnect" => {
            state.stop_connection(field(&p, "id")?);
            Ok(Json::Null)
        }
        "set_write_access" => {
            let session = state.session(field(&p, "id")?)?;
            let _access = session.access.write().map_err(|_| locked())?;
            if let Ok(mut editors) = session.editors.lock() {
                if editors
                    .values()
                    .any(|e| e.transaction.load(Ordering::SeqCst))
                {
                    return Err(Error::new(
                        "TRANSACTION_ACTIVE",
                        "Commit or roll back SQL-tab transactions before changing connection access.",
                    ));
                }
                for editor in editors.values() {
                    editor.closed.store(true, Ordering::SeqCst);
                }
                editors.clear();
            }
            let enabled = p["enabled"].as_bool().unwrap_or(false);
            if enabled && !p["confirmed"].as_bool().unwrap_or(false) {
                return Err(Error::new(
                    "CONFIRM_REQUIRED",
                    "Confirm write access for this connection session.",
                ));
            }
            let mut config = session.config.clone();
            config.create = false;
            config.read_only = !enabled;
            if enabled {
                config.environment = "custom".into();
            }
            let db = Database::open(&config, &state.internal, !enabled)?;
            let mut current = session.db.lock().map_err(|_| locked())?;
            *session.main_interrupt.lock().map_err(|_| locked())? = db.interrupt();
            *current = db;
            session.read_only.store(!enabled, Ordering::SeqCst);
            Ok(json!({"readOnly":!enabled}))
        }
        "tables" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if p["refresh"].as_bool().unwrap_or(false) {
                db.refresh_metadata();
            }
            encode(db.tables()?)
        }
        "completion" | "sql_completion" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let tables: Vec<TableRef> = decode(p["tables"].clone())?;
            if tables.len() > 5 {
                return Err(Error::new(
                    "VALIDATION",
                    "Autocomplete is limited to five referenced tables.",
                ));
            }
            let mut db = session.db.lock().map_err(|_| locked())?;
            let mut columns = Vec::new();
            let mut completions = Vec::new();
            for table in tables {
                for column in db.metadata(&table)?.columns {
                    completions.push(SqlCompletion {
                        label: column.name.clone(),
                        parts: vec![column.name.clone()],
                        kind: "column".into(),
                        detail: table.name.clone(),
                    });
                    completions.push(SqlCompletion {
                        label: format!("{}.{}", table.name, column.name),
                        parts: vec![table.name.clone(), column.name.clone()],
                        kind: "column".into(),
                        detail: table.name.clone(),
                    });
                    columns.push(column.name.clone());
                    columns.push(format!("{}.{}", table.name, column.name));
                }
            }
            columns.sort();
            columns.dedup();
            if method == "sql_completion" {
                encode(completions)
            } else {
                encode(columns)
            }
        }
        "record_sql" => {
            let record: RecordRef = decode(p)?;
            let session = state.session(&record.connection_id)?;
            let metadata = session
                .db
                .lock()
                .map_err(|_| locked())?
                .metadata(&record.table)?;
            validate_key(&record.key, &metadata)?;
            let conditions = record
                .key
                .keys()
                .enumerate()
                .map(|(i, key)| {
                    format!(
                        "{} = {}{}",
                        crate::safety::quote(key),
                        if session.config.driver == "postgres" {
                            "$"
                        } else {
                            "?"
                        },
                        i + 1
                    )
                })
                .collect::<Vec<_>>();
            Ok(
                json!({"sql":format!("SELECT * FROM {} WHERE {};",crate::database::qualified(&record.table),conditions.join(" AND ")),"params":record.key.values().collect::<Vec<_>>()}),
            )
        }
        "schema_table" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let table: TableRef = decode(p["table"].clone())?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if p["refresh"].as_bool().unwrap_or(false) {
                db.refresh_metadata();
            }
            let metadata = db.metadata(&table)?;
            let incoming = db.incoming_foreign_keys(&table, &metadata)?;
            let definition = db.table_definition(&table)?;
            encode(SchemaTable {
                metadata,
                incoming,
                definition,
            })
        }
        "schema_batch" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let tables: Vec<TableRef> = decode(p["tables"].clone())?;
            if tables.len() > 24 {
                return Err(Error::new(
                    "SCHEMA_LIMIT",
                    "Load at most 24 tables per metadata batch.",
                ));
            }
            let id = field(&p, "operationId")?;
            let operation = Arc::new(QueryOperation {
                cancelled: AtomicBool::new(false),
                interrupt: Mutex::new(None),
            });
            {
                let mut operations = state.operations.lock().map_err(|_| locked())?;
                if operations.len() >= 100 || operations.contains_key(id) {
                    return Err(Error::new(
                        "OPERATION_LIMIT",
                        "Too many queued operations or duplicate operation identifier.",
                    ));
                }
                operations.insert(id.into(), operation.clone());
            }
            let _guard = OperationGuard {
                operations: &state.operations,
                id: id.into(),
            };
            let mut db = session.db.lock().map_err(|_| locked())?;
            if p["refresh"].as_bool().unwrap_or(false) {
                db.refresh_metadata();
            }
            *operation.interrupt.lock().map_err(|_| locked())? = db.interrupt();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let mut output = SchemaBatch {
                tables: Vec::new(),
                errors: Vec::new(),
            };
            let mut bytes = 0;
            for table in tables {
                if operation.cancelled.load(Ordering::SeqCst) {
                    return Err(Error::new("CANCELLED", "Schema loading was cancelled."));
                }
                if !session.connected.load(Ordering::SeqCst) {
                    return Err(Error::new(
                        "NOT_CONNECTED",
                        "Connection closed during schema loading.",
                    ));
                }
                if std::time::Instant::now() > deadline {
                    return Err(Error::new(
                        "SCHEMA_TIMEOUT",
                        "Metadata batch exceeded its time budget. Try a smaller scope.",
                    ));
                }
                match db.metadata(&table) {
                    Ok(metadata) => {
                        bytes += serde_json::to_vec(&metadata).map_err(|_| locked())?.len();
                        if bytes > 4 * 1024 * 1024 {
                            return Err(Error::new(
                                "SCHEMA_LIMIT",
                                "Metadata batch exceeds 4 MiB. Narrow the schema scope.",
                            ));
                        }
                        output.tables.push(metadata);
                    }
                    Err(error) => output.errors.push(SchemaLoadError { table, error }),
                }
            }
            if operation.cancelled.load(Ordering::SeqCst) {
                return Err(Error::new("CANCELLED", "Schema loading was cancelled."));
            }
            *operation.interrupt.lock().map_err(|_| locked())? = None;
            encode(output)
        }
        "metadata" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let table: TableRef = decode(p["table"].clone())?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if p["refresh"].as_bool().unwrap_or(false) {
                db.refresh_metadata();
            }
            encode(db.metadata(&table)?)
        }
        "browse" => {
            let request: BrowseRequest = decode(p)?;
            let session = state.session(&request.connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            encode(db.browse(&request)?)
        }
        "count_rows" => {
            let request: BrowseRequest = decode(p)?;
            let session = state.session(&request.connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            encode(db.count_rows(&request)?)
        }
        "estimate_rows" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let table: TableRef = decode(p["table"].clone())?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            encode(db.estimate_rows(&table)?)
        }
        "index_advice" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let table: TableRef = decode(p["table"].clone())?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            encode(db.index_advice(&table)?)
        }
        "mysql_statement" => {
            let sql = field(&p, "sql")?;
            let cursor = p["cursor"].as_u64().unwrap_or(0) as usize;
            let mut units = 0;
            let mut byte = sql.len();
            for (index, c) in sql.char_indices() {
                if units >= cursor {
                    byte = index;
                    break;
                }
                units += c.len_utf16();
            }
            let parts = crate::mysql_sql::statements(sql)?;
            let mut start = 0;
            let mut chosen = None;
            for part in parts {
                if let Some(offset) = sql[start..].find(&part) {
                    let end = start + offset + part.len();
                    if byte <= end {
                        chosen = Some(part);
                        break;
                    }
                    start = end;
                }
            }
            let selected = chosen.unwrap_or_default();
            let mut delimiter = "__KITSUNE_END__".to_string();
            while selected.contains(&delimiter) {
                delimiter = uuid::Uuid::new_v4().simple().to_string()[..16].into();
            }
            Ok(
                json!({"sql":if selected.is_empty(){String::new()}else{format!("DELIMITER {delimiter}\n{selected}{delimiter}")}}),
            )
        }
        "close_editor_session" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let id = field(&p, "tabId")?;
            let mut editors = session.editors.lock().map_err(|_| locked())?;
            let closing = editors.get(id).cloned();
            let _idle = closing.as_ref().map(|editor| editor.db.try_lock().map_err(|_| Error::new("EDITOR_BUSY", "Wait for this SQL operation to finish or cancel it before closing the tab."))).transpose()?;
            if editors
                .get(id)
                .is_some_and(|e| e.transaction.load(Ordering::SeqCst))
                && !p["confirmed"].as_bool().unwrap_or(false)
            {
                return Err(Error::new(
                    "CONFIRM_REQUIRED",
                    "Closing this SQL tab ends its connection and discards uncommitted work.",
                ));
            }
            if let Some(editor) = editors.remove(id) {
                editor.closed.store(true, Ordering::SeqCst);
                if let Some(ref handle) = editor.interrupt {
                    handle.cancel();
                }
            }
            Ok(Json::Null)
        }
        "editor_status" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let editors = session.editors.lock().map_err(|_| locked())?;
            let editor = editors.get(field(&p, "tabId")?);
            Ok(
                json!({"transactionState":editor.map(|e|if e.lost.load(Ordering::SeqCst){"lost"}else if e.transaction.load(Ordering::SeqCst){"active"}else{"idle"}).unwrap_or("idle")}),
            )
        }
        "review_query" => {
            let connection_id = field(&p, "connectionId")?;
            let session = state.session(connection_id)?;
            let _access = session.access.read().map_err(|_| locked())?;
            let sql = field(&p, "sql")?;
            if sql.len() > 1024 * 1024 {
                return Err(Error::new(
                    "SQL_LIMIT",
                    "SQL text is limited to 1 MiB per execution.",
                ));
            }
            let generation = if session.config.driver == "mysql" {
                format!(
                    "{}:{}",
                    session.generation,
                    session
                        .editor(p["tabId"].as_str().unwrap_or("legacy"), &state.internal)?
                        .generation
                )
            } else {
                session.generation.clone()
            };
            let token = uuid::Uuid::new_v4().to_string();
            let mut approvals = state.approvals.lock().map_err(|_| locked())?;
            approvals.retain(|_, a| a.created.elapsed().as_secs() < 120);
            if approvals.len() >= 100 {
                return Err(Error::new("REVIEW_LIMIT", "Too many pending SQL reviews."));
            }
            approvals.insert(
                token.clone(),
                Approval {
                    restore: None,
                    expected_affected: None,
                    sql: sql.into(),
                    params: p
                        .get("params")
                        .cloned()
                        .map(decode)
                        .transpose()?
                        .unwrap_or_default(),
                    connection_id: connection_id.into(),
                    generation,
                    script: p["script"].as_bool().unwrap_or(false),
                    created: std::time::Instant::now(),
                },
            );
            Ok(json!({"token":token}))
        }
        "execute" => {
            let connection_id = field(&p, "connectionId")?;
            let sql = field(&p, "sql")?;
            if sql.len() > 1024 * 1024 {
                return Err(Error::new(
                    "SQL_LIMIT",
                    "SQL text is limited to 1 MiB per execution.",
                ));
            }
            let id = field(&p, "operationId")?;
            let session = state.session(connection_id)?;
            let _access = session.access.read().map_err(|_| locked())?;
            let operation = Arc::new(QueryOperation {
                cancelled: AtomicBool::new(false),
                interrupt: Mutex::new(None),
            });
            {
                let mut operations = state.operations.lock().map_err(|_| locked())?;
                if operations.len() >= 100 || operations.contains_key(id) {
                    return Err(Error::new(
                        "OPERATION_LIMIT",
                        "Too many queued operations or duplicate operation identifier.",
                    ));
                }
                operations.insert(id.into(), operation.clone());
            }
            let _operation_guard = OperationGuard {
                operations: &state.operations,
                id: id.into(),
            };
            let editor = if session.config.driver == "mysql" {
                Some(session.editor(p["tabId"].as_str().unwrap_or("legacy"), &state.internal)?)
            } else {
                None
            };
            if editor
                .as_ref()
                .is_some_and(|e| e.lost.load(Ordering::SeqCst))
            {
                return Err(Error::new(
                    "TRANSACTION_LOST",
                    "This SQL session lost its connection. End the session before running more SQL.",
                ));
            }
            let generation = editor
                .as_ref()
                .map(|e| format!("{}:{}", session.generation, e.generation))
                .unwrap_or_else(|| session.generation.clone());
            let mut db = if let Some(ref editor) = editor {
                editor.db.lock().map_err(|_| locked())?
            } else {
                session.db.lock().map_err(|_| locked())?
            };
            if editor
                .as_ref()
                .is_some_and(|e| e.closed.load(Ordering::SeqCst))
            {
                return Err(Error::new(
                    "SESSION_CLOSED",
                    "This SQL session was closed. Run again in a new session.",
                ));
            }
            if operation.cancelled.load(Ordering::SeqCst) {
                return Err(Error::new(
                    "CANCELLED",
                    "Queued SQL was cancelled before execution.",
                ));
            }
            let readonly = session.read_only.load(Ordering::SeqCst);
            let params: Vec<Value> = p
                .get("params")
                .cloned()
                .map(decode)
                .transpose()?
                .unwrap_or_default();
            let confirmed = if let Some(token) = p["confirmationToken"].as_str() {
                state
                    .approvals
                    .lock()
                    .map_err(|_| locked())?
                    .remove(token)
                    .is_some_and(|a| {
                        a.expected_affected.is_none()
                            && a.sql == sql
                            && a.params == params
                            && a.connection_id == connection_id
                            && a.generation == generation
                            && a.script == p["script"].as_bool().unwrap_or(false)
                            && a.created.elapsed().as_secs() < 120
                    })
            } else {
                false
            };
            let script = p["script"].as_bool().unwrap_or(false);
            let statements = if session.config.driver == "mysql" {
                crate::mysql_sql::statements(sql)?
            } else {
                crate::safety::statements(sql)?
            };
            if statements.is_empty() {
                return Err(Error::new("SQL_EMPTY", "Enter a SQL statement to execute."));
            }
            if !script && statements.len() != 1 {
                return Err(Error::new(
                    "SQL_STATEMENTS",
                    "Select sequential script mode to run multiple statements.",
                ));
            }
            if statements.len() > 100 {
                return Err(Error::new(
                    "SQL_STATEMENTS",
                    "Scripts are limited to 100 statements.",
                ));
            }
            if script && !params.is_empty() {
                return Err(Error::new(
                    "VALIDATION",
                    "Bound values are supported only for single-statement execution.",
                ));
            }
            for s in &statements {
                if session.config.driver == "mysql" {
                    crate::mysql_sql::validate(s, readonly, confirmed)?;
                } else {
                    crate::safety::validate_sql(s, readonly, confirmed)?;
                }
            }
            let settings = state
                .storage
                .list::<ApplicationSettings>("settings")?
                .into_iter()
                .next()
                .unwrap_or_default();
            let limit = settings.row_limit.clamp(1, 10000) as usize;
            let timeout = settings.query_timeout.clamp(1, 300);
            if let Some(handle) = db.interrupt() {
                *operation.interrupt.lock().map_err(|_| locked())? = Some(handle);
            }
            let start = std::time::Instant::now();
            let mut results = Vec::new();
            let mut error = None;
            let mut result_bytes = 0usize;
            let mut schema_changed = false;
            let mut implicit_commit = false;
            for statement in statements {
                // This classification only selects a fail-closed database read
                // path. It is not the safety boundary: SQLite checks
                // sqlite3_stmt_readonly, PostgreSQL starts BEGIN READ ONLY,
                // and server adapters apply their own SQL checks.
                let read_candidate = ["SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW"]
                    .contains(&crate::safety::first_word(&statement).as_str());
                let statement_read_only = readonly || read_candidate;
                let ddl = [
                    "CREATE",
                    "ALTER",
                    "DROP",
                    "TRUNCATE",
                    "RENAME",
                    "CALL",
                    "EXECUTABLE",
                ]
                .contains(&crate::mysql_sql::first_word(&statement).as_str())
                    && session.config.driver == "mysql";
                let was_active = db.transaction_active();
                if operation.cancelled.load(Ordering::SeqCst) {
                    error = Some(Error::new(
                        "CANCELLED",
                        "Execution was cancelled. Previously completed script statements remain committed.",
                    ));
                    break;
                }
                if !session.connected.load(Ordering::SeqCst) {
                    error = Some(Error::new(
                        "NOT_CONNECTED",
                        "Connection closed during execution.",
                    ));
                    break;
                }
                let outcome = if session.config.driver == "mysql" {
                    db.mysql_native(&statement, &params, limit, timeout, statement_read_only)
                } else {
                    db.query(&statement, &params, limit, statement_read_only, timeout)
                        .map(|r| vec![r])
                };
                if outcome.is_ok() && ddl {
                    schema_changed = true;
                    if was_active && !db.transaction_active() {
                        implicit_commit = true;
                    }
                }
                if let Some(ref editor) = editor {
                    if outcome.is_err()
                        && (editor.transaction.load(Ordering::SeqCst) || db.transaction_active())
                    {
                        editor.lost.store(true, Ordering::SeqCst);
                    }
                    editor
                        .transaction
                        .store(db.transaction_active(), Ordering::SeqCst);
                }
                match outcome {
                    Ok(mut sets) if sets.len() > 1 => {
                        let size = serde_json::to_vec(&sets).map_err(|_| locked())?.len();
                        if result_bytes.saturating_add(size) > 10 * 1024 * 1024 {
                            error = Some(Error::new(
                                "SCRIPT_RESULT_LIMIT",
                                "Results exceed 10 MiB. Earlier statements may have committed.",
                            ));
                            break;
                        }
                        result_bytes += size;
                        results.append(&mut sets);
                    }
                    Ok(mut sets) => {
                        let mut result = sets.pop().unwrap_or_else(ResultSet::empty);
                        let size = serde_json::to_vec(&result)
                            .map_err(|_| {
                                Error::new("SERIALIZATION", "Cannot encode query results.")
                            })?
                            .len();
                        if result_bytes.saturating_add(size) > 10 * 1024 * 1024 {
                            result.rows.clear();
                            result.columns.clear();
                            result.types.clear();
                            result.truncated = true;
                            results.push(result);
                            error = Some(Error::new(
                                "SCRIPT_RESULT_LIMIT",
                                "The result payload limit was reached. The listed statements completed, including the current statement; its result was omitted. Remaining script statements were not executed.",
                            ));
                            break;
                        }
                        result_bytes += size;
                        results.push(result)
                    }
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            *operation.interrupt.lock().map_err(|_| locked())? = None;
            drop(db);
            let mut warning = if implicit_commit {
                Some(
                    "The statement ended the active transaction through an implicit commit. Earlier changes may already be committed.",
                )
            } else {
                None
            };
            if schema_changed {
                if let Ok(mut main) = session.db.lock() {
                    main.refresh_metadata();
                }
                if let Ok(mut monitor) = session.monitor.try_lock() {
                    monitor.refresh_metadata();
                }
            }
            if settings.query_history && state.storage.add_history(&uuid::Uuid::new_v4().to_string(),connection_id,&json!({"sql":sql,"connectionId":connection_id,"createdAt":chrono::Utc::now().to_rfc3339(),"durationMs":start.elapsed().as_millis() as u64,"success":error.is_none(),"rows":results.last().map(|r|r.rows.len())})).is_err() {
                warning=Some("Local query history could not be saved. The execution results above are authoritative; do not repeat a write just to save history.");
            }
            tracing::info!(
                operation = "execute",
                driver = session.config.driver.as_str(),
                success = error.is_none(),
                duration_ms = start.elapsed().as_millis() as u64,
                "Database operation completed"
            );
            Ok(
                json!({"schemaChanged":schema_changed,"results":results,"error":error,"warning":warning,"durationMs":start.elapsed().as_millis() as u64,"transactionState":editor.as_ref().map(|e|if e.lost.load(Ordering::SeqCst){"lost"}else if e.transaction.load(Ordering::SeqCst){"active"}else{"idle"}).unwrap_or("idle")}),
            )
        }
        "history" => encode(state.storage.history()?),
        "clear_history" => {
            state.storage.clear_history()?;
            Ok(Json::Null)
        }
        "saved_queries" => encode(state.storage.list::<Json>("queries")?),
        "save_query" => {
            let id = p["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let value = json!({"id":id,"name":field(&p,"name")?,"sql":field(&p,"sql")?});
            state.storage.put("queries", &id, &value)?;
            Ok(value)
        }
        "delete_query" => {
            state.storage.delete("queries", field(&p, "id")?)?;
            Ok(Json::Null)
        }
        "record" => {
            let record: RecordRef = decode(p)?;
            let session = state.session(&record.connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            let metadata = db.metadata(&record.table)?;
            validate_key(&record.key, &metadata)?;
            let result = db.browse(&BrowseRequest {
                filter_groups: vec![],
                group_mode: "all".into(),
                connection_id: record.connection_id.clone(),
                table: record.table.clone(),
                filters: record_filters(&record.key),
                sort: String::new(),
                descending: false,
                offset: 0,
                keyset: false,
                cursor: None,
                limit: 2,
            })?;
            if result.rows.len() > 1 {
                return Err(Error::new(
                    "IDENTITY",
                    "The key does not uniquely identify a record.",
                ));
            }
            let mut relationships = metadata
                .foreign_keys
                .iter()
                .map(|fk| json!({"foreignKey":fk,"direction":"outgoing"}))
                .collect::<Vec<_>>();
            for fk in db.incoming_foreign_keys(&record.table, &metadata)? {
                relationships.push(json!({"foreignKey":fk,"direction":"incoming"}));
            }
            Ok(json!({"metadata":metadata,"result":result,"relationships":relationships}))
        }
        "expand" => {
            let session = state.session(field(&p, "connectionId")?)?;
            let fk: ForeignKey = decode(p["foreignKey"].clone())?;
            let incoming = field(&p, "direction")? == "incoming";
            let values: BTreeMap<String, Value> = decode(p["values"].clone())?;
            let table = if incoming {
                fk.from.clone()
            } else {
                fk.to.clone()
            };
            let source_columns = if incoming {
                &fk.target_columns
            } else {
                &fk.columns
            };
            let target_columns = if incoming {
                &fk.columns
            } else {
                &fk.target_columns
            };
            if source_columns.len() != target_columns.len() {
                return Err(Error::new(
                    "METADATA",
                    "Foreign key column counts do not match.",
                ));
            }
            let mut filters = Vec::new();
            for (s, t) in source_columns.iter().zip(target_columns) {
                let value = values.get(s).ok_or_else(|| {
                    Error::new(
                        "IDENTITY",
                        "The selected record lacks a relationship column.",
                    )
                })?;
                if matches!(value, Value::Null) {
                    return Ok(json!({"table":table,"result":ResultSet::empty(),"metadata":null}));
                }
                filters.push(Filter {
                    column: t.clone(),
                    operator: "eq".into(),
                    value: value.clone(),
                });
            }
            let mut db = session.db.lock().map_err(|_| locked())?;
            let metadata = db.metadata(&table)?;
            let result = db.browse(&BrowseRequest {
                filter_groups: vec![],
                group_mode: "all".into(),
                connection_id: session.config.id.clone(),
                table: table.clone(),
                filters,
                sort: String::new(),
                descending: false,
                offset: p["offset"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32,
                keyset: false,
                cursor: None,
                limit: 50,
            })?;
            Ok(json!({"table":table,"metadata":metadata,"result":result}))
        }
        "save_investigation" => {
            let mut i: Investigation = decode(p)?;
            if i.id.is_empty() {
                i.id = uuid::Uuid::new_v4().to_string();
            }
            if i.name.trim().is_empty() {
                return Err(Error::new("VALIDATION", "Give this investigation a name."));
            }
            if serde_json::to_vec(&i.graph).map_err(|_| locked())?.len() > 1024 * 1024 {
                return Err(Error::new("GRAPH_LIMIT", "Graph state exceeds 1 MiB."));
            }
            state.storage.put("investigations", &i.id, &i)?;
            encode(i)
        }
        "delete_investigation" => {
            state.storage.delete("investigations", field(&p, "id")?)?;
            Ok(Json::Null)
        }
        "watches" => {
            let mut watches = state.storage.list::<Watch>("watches")?;
            let errors = state.watch_errors.lock().map_err(|_| locked())?;
            for watch in &mut watches {
                if let Some(error) = errors.get(&watch.id) {
                    watch.status = "error".into();
                    watch.last_error = Some(error.clone());
                }
            }
            encode(watches)
        }
        "save_watch" => {
            let _gate = state.watch_gate.lock().map_err(|_| locked())?;
            let allow = p["allowProductionCapture"].as_bool().unwrap_or(false);
            let mut watch: Watch = decode(p)?;
            if watch.name.trim().is_empty() {
                return Err(Error::new("VALIDATION", "Give this watch a name."));
            }
            if !["record", "table", "query"].contains(&watch.kind.as_str())
                || !["metadata", "full"].contains(&watch.capture.as_str())
            {
                return Err(Error::new(
                    "VALIDATION",
                    "Invalid watch type or capture mode.",
                ));
            }
            watch.interval_seconds = watch.interval_seconds.clamp(2, 3600);
            watch.group_name = watch.group_name.trim().to_string();
            if watch.group_name.len() > 80
                || watch
                    .duration_seconds
                    .is_some_and(|n| !(10..=86400).contains(&n))
            {
                return Err(Error::new(
                    "VALIDATION",
                    "Watch groups are limited to 80 characters; timeboxes must be 10 seconds to 24 hours.",
                ));
            }
            if watch.id.is_empty() {
                watch.id = uuid::Uuid::new_v4().to_string();
            }
            let configs = state.storage.list::<ConnectionConfig>("connections")?;
            let config = configs
                .iter()
                .find(|c| c.id == watch.connection_id)
                .ok_or_else(|| Error::new("VALIDATION", "Watch connection does not exist."))?;
            let previous = state
                .storage
                .list::<Watch>("watches")?
                .into_iter()
                .find(|w| w.id == watch.id && w.connection_id == watch.connection_id);
            let previously_authorized = previous.is_some_and(|w| w.production_capture_authorized);
            watch.production_capture_authorized = config.environment == "production"
                && watch.capture == "full"
                && (allow || previously_authorized);
            if config.environment == "production"
                && watch.capture == "full"
                && !watch.production_capture_authorized
            {
                return Err(Error::new(
                    "CAPTURE_CONSENT",
                    "Explicitly authorize full-value capture for this production watch.",
                ));
            }
            if watch.kind == "query" {
                crate::safety::validate_sql(&watch.sql, true, false)?;
            } else {
                let session = state.session(&watch.connection_id)?;
                let mut db = session.db.lock().map_err(|_| locked())?;
                let table = watch
                    .table
                    .as_ref()
                    .ok_or_else(|| Error::new("VALIDATION", "Select a watch table."))?;
                let metadata = db.metadata(table)?;
                if identity_columns(&metadata).is_empty() {
                    return Err(Error::new(
                        "WATCH_IDENTITY",
                        "Choose a table with a primary or non-null unique key, or use a query watch without an identity table.",
                    ));
                }
                if watch.filters.len()
                    + watch
                        .filter_groups
                        .iter()
                        .map(|g| g.filters.len())
                        .sum::<usize>()
                    > 100
                    || watch.filter_groups.len() > 16
                    || !["all", "any"].contains(&watch.group_mode.as_str())
                    || watch
                        .filter_groups
                        .iter()
                        .any(|g| !["all", "any"].contains(&g.mode.as_str()))
                {
                    return Err(Error::new("WATCH_SCOPE", "Invalid grouped watch scope."));
                }
                for filter in watch
                    .filters
                    .iter()
                    .chain(watch.filter_groups.iter().flat_map(|g| g.filters.iter()))
                {
                    if !metadata.columns.iter().any(|c| c.name == filter.column)
                        || ![
                            "eq",
                            "ne",
                            "gt",
                            "lt",
                            "gte",
                            "lte",
                            "contains",
                            "startsWith",
                            "endsWith",
                            "like",
                            "notLike",
                            "ilike",
                            "notIlike",
                            "null",
                            "notNull",
                        ]
                        .contains(&filter.operator.as_str())
                    {
                        return Err(Error::new(
                            "WATCH_SCOPE",
                            "A scope filter references an unavailable column or operator. Review the watch scope.",
                        ));
                    }
                }
                if watch.kind == "record" {
                    validate_key(&watch.key, &metadata)?;
                } else if watch.filters.is_empty()
                    && watch.filter_groups.iter().all(|g| g.filters.is_empty())
                {
                    return Err(Error::new(
                        "WATCH_SCOPE",
                        "Table watches require an explicit filter. Use a query watch for an explicitly bounded result.",
                    ));
                }
                for col in metadata.columns {
                    let lower = col.name.to_lowercase();
                    if ["password", "secret", "token", "private_key", "ssn"]
                        .iter()
                        .any(|s| lower.contains(s))
                        && !watch.excluded_columns.contains(&col.name)
                    {
                        watch.excluded_columns.push(col.name);
                    }
                }
            }
            state.stop_watch(&watch.id);
            watch.status = "paused".into();
            state.storage.put("watches", &watch.id, &watch)?;
            encode(watch)
        }
        "watch_group_action" => {
            let group = field(&p, "group")?;
            let action = field(&p, "action")?;
            if group.is_empty() || !["resume", "pause", "stop"].contains(&action) {
                return Err(Error::new(
                    "VALIDATION",
                    "Choose a group and a supported action.",
                ));
            }
            let watches = state.storage.list::<Watch>("watches")?;
            let mut completed = 0;
            let mut errors = Vec::new();
            for watch in watches.iter().filter(|w| w.group_name == group) {
                match dispatch(
                    app.clone(),
                    "watch_action",
                    json!({"id":watch.id,"action":action}),
                ) {
                    Ok(_) => completed += 1,
                    Err(e) => errors.push(json!({"id":watch.id,"name":watch.name,"error":e})),
                }
            }
            Ok(json!({"completed":completed,"errors":errors}))
        }
        "watch_action" => {
            let _gate = state.watch_gate.lock().map_err(|_| locked())?;
            let id = field(&p, "id")?;
            let action = field(&p, "action")?;
            if !["start", "resume", "pause", "stop", "delete"].contains(&action) {
                return Err(Error::new("VALIDATION", "Unknown watch action."));
            }
            let mut watch = state
                .storage
                .list::<Watch>("watches")?
                .into_iter()
                .find(|w| w.id == id)
                .ok_or_else(|| Error::new("WATCH_MISSING", "Watch no longer exists."))?;
            match action {
                "start" | "resume" => {
                    let session = state.session(&watch.connection_id)?;
                    if session.config.environment == "production"
                        && watch.capture == "full"
                        && !watch.production_capture_authorized
                    {
                        return Err(Error::new(
                            "CAPTURE_CONSENT",
                            "This production watch needs authorization for full-value capture. Configure it or use metadata-only capture.",
                        ));
                    }
                    let at_limit = {
                        let tasks = state.tasks.lock().map_err(|_| locked())?;
                        tasks.len() >= 50 && !tasks.contains_key(id)
                    };
                    if at_limit {
                        return Err(Error::new(
                            "WATCH_LIMIT",
                            "At most 50 watches may be active.",
                        ));
                    }
                    state.stop_watch(id);
                    watch.status = "running".into();
                    watch.started_at = Some(chrono::Utc::now().to_rfc3339());
                    watch.deadline_at = watch.duration_seconds.map(|n| {
                        (chrono::Utc::now() + chrono::Duration::seconds(n as i64)).to_rfc3339()
                    });
                    watch.last_error = None;
                    let stop = Arc::new(AtomicBool::new(false));
                    let wake = Arc::new(tokio::sync::Notify::new());
                    let interrupt = Arc::new(Mutex::new(None));
                    state.storage.put("watches", id, &watch)?;
                    if let Err(error) = state.storage.event(&monitor::lifecycle(
                        &watch,
                        "watchStarted",
                        "Monitoring started; first observation establishes a baseline.",
                    )) {
                        watch.status = "error".into();
                        watch.last_error =
                            Some("Local history is unavailable; monitoring did not start.".into());
                        let _ = state.storage.put("watches", id, &watch);
                        state
                            .watch_errors
                            .lock()
                            .map_err(|_| locked())?
                            .insert(id.into(), watch.last_error.clone().unwrap_or_default());
                        return Err(error);
                    }
                    state.watch_errors.lock().map_err(|_| locked())?.remove(id);
                    state.tasks.lock().map_err(|_| locked())?.insert(
                        id.into(),
                        WatchTask {
                            stop: stop.clone(),
                            wake: wake.clone(),
                            interrupt: interrupt.clone(),
                        },
                    );
                    tauri::async_runtime::spawn(monitor::run(
                        app.clone(),
                        watch.clone(),
                        stop,
                        wake,
                        interrupt,
                    ));
                }
                "pause" | "stop" => {
                    state.stop_watch(id);
                    watch.status = if action == "pause" {
                        "paused"
                    } else {
                        "stopped"
                    }
                    .into();
                    state.storage.put("watches", id, &watch)?;
                    state.storage.event(&monitor::lifecycle(
                        &watch,
                        "watchStopped",
                        "Monitoring stopped. Changes during the gap are not captured.",
                    ))?;
                }
                "delete" => {
                    state.stop_watch(id);
                    state.watch_errors.lock().map_err(|_| locked())?.remove(id);
                    state.storage.delete("watches", id)?;
                    state.storage.clear_events(Some(id.into()))?;
                }
                _ => return Err(Error::new("VALIDATION", "Unknown watch action.")),
            }
            let _ = app.emit("watch-status", id);
            encode(watch)
        }
        "preview_table_mutation" => {
            let request: crate::database::mutations::MutationRequest = decode(p)?;
            let session = state.session(&request.connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if session.read_only.load(Ordering::SeqCst) {
                return Err(Error::new(
                    "READ_ONLY",
                    "Enable write access explicitly before changing table data.",
                ));
            }
            let plan = db.plan_mutation(&request)?;
            let token = uuid::Uuid::new_v4().to_string();
            let mut approvals = state.approvals.lock().map_err(|_| locked())?;
            approvals.retain(|_, a| a.created.elapsed().as_secs() < 120);
            if approvals.len() >= 100 {
                return Err(Error::new("REVIEW_LIMIT", "Too many pending reviews."));
            }
            approvals.insert(
                token.clone(),
                Approval {
                    restore: None,
                    expected_affected: Some(plan.expected_rows),
                    sql: plan.sql.clone(),
                    params: plan.params.clone(),
                    connection_id: request.connection_id,
                    generation: session.generation.clone(),
                    script: false,
                    created: std::time::Instant::now(),
                },
            );
            Ok(
                json!({"token":token,"sql":plan.sql,"params":plan.params,"expectedRows":plan.expected_rows}),
            )
        }
        "commit_table_mutation" => {
            let connection_id = field(&p, "connectionId")?;
            let session = state.session(connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if session.read_only.load(Ordering::SeqCst) || !session.connected.load(Ordering::SeqCst)
            {
                return Err(Error::new(
                    "READ_ONLY",
                    "The connection is read-only or disconnected.",
                ));
            }
            let approval = state
                .approvals
                .lock()
                .map_err(|_| locked())?
                .remove(field(&p, "token")?)
                .filter(|a| {
                    a.connection_id == connection_id
                        && a.generation == session.generation
                        && a.created.elapsed().as_secs() < 120
                        && a.expected_affected.is_some()
                        && a.restore.is_none()
                })
                .ok_or_else(|| {
                    Error::new(
                        "REVIEW_EXPIRED",
                        "This review expired or has already been used. Review the operation again.",
                    )
                })?;
            encode(db.query_checked(
                &approval.sql,
                &approval.params,
                1,
                false,
                30,
                approval.expected_affected,
            )?)
        }
        "update_cell" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Request {
                record: RecordRef,
                column: String,
                before: Value,
                value: Value,
                confirmed: bool,
            }
            let request: Request = decode(p)?;
            if !request.confirmed {
                return Err(Error::new(
                    "CONFIRMATION_REQUIRED",
                    "Review the cell change before saving.",
                ));
            }
            let session = state.session(&request.record.connection_id)?;
            let mut db = session.db.lock().map_err(|_| locked())?;
            if session.read_only.load(Ordering::SeqCst) || !session.connected.load(Ordering::SeqCst)
            {
                return Err(Error::new(
                    "READ_ONLY",
                    "This connection is read-only or disconnected. Enable write access explicitly before editing.",
                ));
            }
            db.update_cell(
                &request.record,
                &request.column,
                &request.before,
                &request.value,
            )?;
            Ok(json!({"affected":1}))
        }
        "events" => encode(state.storage.event_page(
            p["watchId"].as_str().map(str::to_owned),
            p["limit"].as_u64().unwrap_or(300) as u32,
            p["offset"].as_u64().unwrap_or(0).min(1000000) as u32,
        )?),
        "clear_events" => {
            let _gate = state.watch_gate.lock().map_err(|_| locked())?;
            state
                .approvals
                .lock()
                .map_err(|_| locked())?
                .retain(|_, a| a.restore.is_none());
            state
                .storage
                .clear_events(p["watchId"].as_str().map(str::to_owned))?;
            Ok(Json::Null)
        }
        "save_appearance" => {
            let mut settings = state
                .storage
                .list::<ApplicationSettings>("settings")?
                .into_iter()
                .next()
                .unwrap_or_default();
            settings.theme = field(&p, "theme")?.into();
            settings.density = field(&p, "density")?.into();
            settings.validate()?;
            state.storage.put("settings", "default", &settings)?;
            encode(settings)
        }
        "save_settings" => {
            let settings: ApplicationSettings = decode(p)?;
            settings.validate()?;
            state.storage.put("settings", "default", &settings)?;
            state.storage.retain(
                settings.retention_days,
                settings.max_events,
                settings.storage_mi_b * 1024 * 1024,
            )?;
            encode(settings)
        }
        "ui_state" => {
            let key = field(&p, "key")?;
            if key.len() > 512 {
                return Err(Error::new("VALIDATION", "Layout key is too long."));
            }
            Ok(state
                .storage
                .get::<Json>("ui_state", key)?
                .unwrap_or(Json::Null))
        }
        "save_ui_state" => {
            let key = field(&p, "key")?;
            if key.len() > 512
                || serde_json::to_vec(&p["value"]).map_or(true, |v| v.len() > 512 * 1024)
            {
                return Err(Error::new(
                    "LAYOUT_LIMIT",
                    "Layout exceeds the storage limit.",
                ));
            }
            state.storage.put("ui_state", key, &p["value"])?;
            Ok(Json::Null)
        }
        "save_workspace" => {
            state.storage.put("workspace", "default", &p)?;
            Ok(Json::Null)
        }
        _ => Err(Error::new("COMMAND", "Unknown application command.")),
    }
}
fn validate_key(key: &BTreeMap<String, Value>, metadata: &Metadata) -> Result<(), Error> {
    let columns = identity_columns(metadata);
    if columns.is_empty()
        || columns.len() != key.len()
        || columns.iter().any(|name| {
            key.get(name)
                .is_none_or(|value| matches!(value, Value::Null))
        })
    {
        return Err(Error::new(
            "IDENTITY",
            "A complete, non-null primary or eligible unique key is required for this record operation.",
        ));
    }
    Ok(())
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let internal = dir.join("kitsune-metadata.sqlite3");
    let storage =
        crate::storage::Storage::open(&internal).map_err(|e| std::io::Error::other(e.message))?;
    for mut w in storage
        .list::<Watch>("watches")
        .map_err(|e| std::io::Error::other(e.message))?
    {
        w.status = "paused".into();
        storage
            .put("watches", &w.id, &w)
            .map_err(|e| std::io::Error::other(e.message))?;
    }
    let settings = storage
        .list::<ApplicationSettings>("settings")
        .map_err(|e| std::io::Error::other(e.message))?
        .into_iter()
        .next()
        .unwrap_or_default();
    settings
        .validate()
        .map_err(|e| std::io::Error::other(e.message))?;
    storage
        .retain(
            settings.retention_days,
            settings.max_events,
            settings.storage_mi_b * 1024 * 1024,
        )
        .map_err(|e| std::io::Error::other(e.message))?;
    app.manage(AppState {
        storage,
        internal,
        sessions: Mutex::new(HashMap::new()),
        watch_gate: Mutex::new(()),
        watch_errors: Mutex::new(HashMap::new()),
        approvals: Mutex::new(HashMap::new()),
        tasks: Mutex::new(HashMap::new()),
        operations: Mutex::new(HashMap::new()),
        permits: Arc::new(tokio::sync::Semaphore::new(4)),
    });
    Ok(())
}
