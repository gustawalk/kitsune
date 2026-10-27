//! Runs real application services and SQLite through the Tauri mock window runtime.
//! No database operation is mocked and no fixture is included in the shipped UI.
use crate::{commands::dispatch, model::*, state::AppState, storage::Storage};
use serde_json::{Value as Json, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
fn app() -> (
    tauri::App<tauri::test::MockRuntime>,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let app = tauri::test::mock_app();
    let path = std::env::temp_dir().join(format!("kitsune-ipc-{}.sqlite3", uuid::Uuid::new_v4()));
    let internal = path.with_extension("metadata.sqlite3");
    app.manage(AppState {
        storage: Storage::open(&internal).unwrap(),
        internal: internal.clone(),
        sessions: Mutex::new(HashMap::new()),
        tasks: Mutex::new(HashMap::new()),
        operations: Mutex::new(HashMap::new()),
        permits: Arc::new(tokio::sync::Semaphore::new(4)),
        watch_gate: Mutex::new(()),
        watch_errors: Mutex::new(HashMap::new()),
        approvals: Mutex::new(HashMap::new()),
    });
    (app, path, internal)
}
fn call(app: &tauri::App<tauri::test::MockRuntime>, method: &str, p: Json) -> Result<Json, Error> {
    dispatch(app.handle().clone(), method, p)
}
fn connect(
    app: &tauri::App<tauri::test::MockRuntime>,
    path: &std::path::Path,
    production: bool,
) -> Json {
    let config = json!({"id":"test","name":"Fixture","driver":"sqlite","environment":if production{"production"}else{"development"},"path":path,"create":false,"readOnly":false,"password":"not-persisted"});
    call(app, "connect", config).unwrap()
}
fn record() -> Json {
    json!({"connectionId":"test","table":{"schema":"","name":"orders","kind":"table"},"key":{"id":{"kind":"integer","value":"5821"}}})
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sqlite_investigation_watch_history_and_reconnect() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    assert_eq!(connect(&app, &path, false)["readOnly"], false);
    let tables = call(&app, "tables", json!({"connectionId":"test"})).unwrap();
    assert!(
        tables
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "orders")
    );
    let inspected = call(&app, "record", record()).unwrap();
    assert_eq!(inspected["result"]["rows"].as_array().unwrap().len(), 1);
    let relationships = inspected["relationships"].as_array().unwrap();
    assert!(
        relationships
            .iter()
            .any(|r| r["foreignKey"]["to"]["name"] == "customers" && r["direction"] == "outgoing")
    );
    assert!(
        relationships
            .iter()
            .any(|r| r["foreignKey"]["from"]["name"] == "order_items"
                && r["direction"] == "incoming")
    );
    let values = inspected["result"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .zip(inspected["result"]["rows"][0].as_array().unwrap())
        .map(|(c, v)| (c.as_str().unwrap().to_string(), v.clone()))
        .collect::<serde_json::Map<_, _>>();
    for r in relationships {
        let expanded=call(&app,"expand",json!({"connectionId":"test","foreignKey":r["foreignKey"],"direction":r["direction"],"values":values})).unwrap();
        assert!(!expanded["result"]["rows"].as_array().unwrap().is_empty());
    }
    let graph = json!({"nodes":[{"id":"root","record":record(),"x":0,"y":0,"depth":0}],"edges":[],"selected":"root"});
    call(
        &app,
        "save_investigation",
        json!({"id":"investigation","name":"Order investigation","root":record(),"graph":graph}),
    )
    .unwrap();
    let w=call(&app,"save_watch",json!({"id":"watch","name":"Order status","connectionId":"test","kind":"record","table":record()["table"],"key":record()["key"],"sql":"","intervalSeconds":2,"capture":"full","notifications":false,"filters":[],"excludedColumns":[]})).unwrap();
    assert!(
        w["excludedColumns"]
            .as_array()
            .unwrap()
            .contains(&json!("secret_token"))
    );
    call(&app, "watch_action", json!({"id":"watch","action":"start"})).unwrap();
    assert_eq!(
        call(
            &app,
            "watch_action",
            json!({"id":"watch","action":"invalid"})
        )
        .unwrap_err()
        .code,
        "VALIDATION"
    );
    assert!(
        app.state::<AppState>()
            .tasks
            .lock()
            .unwrap()
            .contains_key("watch")
    );
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let watches = call(&app, "watches", json!({})).unwrap();
        if !watches[0]["lastObserved"].is_null() {
            break;
        }
        assert!(Instant::now() < deadline, "baseline timed out");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    external
        .execute(
            "UPDATE orders SET status='completed',secret_token='new-raw-secret' WHERE id=5821",
            [],
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let event = loop {
        let events = call(&app, "events", json!({"watchId":"watch"})).unwrap();
        if let Some(e) = events
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["eventType"] == "recordChanged")
        {
            break e.clone();
        }
        assert!(Instant::now() < deadline, "change timed out");
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    assert_eq!(event["changes"][0]["column"], "status");
    assert_eq!(event["changes"][0]["before"]["value"], "pending");
    assert_eq!(event["changes"][0]["after"]["value"], "completed");
    assert!(!event.to_string().contains("new-raw-secret"));
    assert!(!event["restoreSource"].is_null());
    let review = call(&app, "preview_restore", json!({"eventId":event["id"]})).unwrap();
    assert!(!review.to_string().contains("new-raw-secret"));
    call(&app,"commit_restore",json!({"connectionId":"test","token":review["token"],"operationId":"restore-real-observation"})).unwrap();
    assert_eq!(
        external
            .query_row("SELECT status FROM orders WHERE id=5821", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "pending"
    );
    assert_eq!(
        external
            .query_row("SELECT secret_token FROM orders WHERE id=5821", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "new-raw-secret"
    );
    call(&app, "watch_action", json!({"id":"watch","action":"pause"})).unwrap();
    assert_eq!(
        call(&app, "watches", json!({})).unwrap()[0]["status"],
        "paused"
    );
    call(
        &app,
        "watch_action",
        json!({"id":"watch","action":"resume"}),
    )
    .unwrap();
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    assert_eq!(
        call(&app, "watches", json!({})).unwrap()[0]["status"],
        "paused"
    );
    connect(&app, &path, false);
    assert!(call(&app, "record", record()).is_ok());
    call(
        &app,
        "save_workspace",
        json!({"activeConnection":"test","tabs":[]}),
    )
    .unwrap();
    let boot = call(&app, "bootstrap", json!({})).unwrap();
    assert_eq!(boot["investigations"][0]["id"], "investigation");
    assert_eq!(boot["workspace"]["activeConnection"], "test");
    assert!(!boot.to_string().contains("not-persisted"));
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test]
async fn reviewed_sql_is_bound_to_statement_session_and_single_use() {
    let (app, path, internal) = app();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY);INSERT INTO t VALUES(1)")
        .unwrap();
    connect(&app, &path, false);
    let request = json!({"connectionId":"test","sql":"DELETE FROM t","operationId":"q","confirmed":true,"script":false});
    assert_eq!(
        call(&app, "execute", request.clone()).unwrap_err().code,
        "CONFIRM_REQUIRED"
    );
    let token = call(&app, "review_query", request.clone()).unwrap()["token"].clone();
    let mut altered = request.clone();
    altered["confirmationToken"] = token;
    altered["sql"] = json!("DROP TABLE t");
    assert_eq!(
        call(&app, "execute", altered).unwrap_err().code,
        "CONFIRM_REQUIRED"
    );
    let token = call(&app, "review_query", request.clone()).unwrap()["token"].clone();
    let mut exact = request.clone();
    exact["confirmationToken"] = token;
    let result = call(&app, "execute", exact.clone()).unwrap();
    assert_eq!(result["results"][0]["affected"], 1);
    assert_eq!(
        call(&app, "execute", exact).unwrap_err().code,
        "CONFIRM_REQUIRED"
    );
    let token = call(&app, "review_query", request.clone()).unwrap()["token"].clone();
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    connect(&app, &path, false);
    let mut stale = request;
    stale["confirmationToken"] = token;
    assert_eq!(
        call(&app, "execute", stale).unwrap_err().code,
        "CONFIRM_REQUIRED"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(db);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test]
async fn production_safety_and_capture_consent() {
    let (app, path, internal) = app();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    assert_eq!(connect(&app, &path, true)["readOnly"], true);
    assert!(call(&app,"execute",json!({"connectionId":"test","sql":"INSERT INTO no_identity VALUES('bad')","operationId":"q","confirmed":true})).is_err());
    let mut w = json!({"id":"prod","name":"Production","connectionId":"test","kind":"record","table":record()["table"],"key":record()["key"],"intervalSeconds":2,"capture":"full","notifications":false,"filters":[],"excludedColumns":[]});
    assert_eq!(
        call(&app, "save_watch", w.clone()).unwrap_err().code,
        "CAPTURE_CONSENT"
    );
    w["capture"] = json!("metadata");
    assert!(call(&app, "save_watch", w).is_ok());
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(db);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
async fn local_history_failure_does_not_hide_committed_sql() {
    let (app, path, internal) = app();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY)", [])
        .unwrap();
    connect(&app, &path, false);
    app.state::<AppState>()
        .storage
        .db
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    let result = call(
        &app,
        "execute",
        json!({"connectionId":"test","sql":"INSERT INTO messages VALUES(1)","operationId":"q"}),
    )
    .unwrap();
    assert!(result["error"].is_null());
    assert!(result["warning"].is_string());
    assert_eq!(result["results"][0]["affected"], 1);
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(db);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test]
async fn development_capture_does_not_authorize_production_capture() {
    let (app, path, internal) = app();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, false);
    call(&app,"save_watch",json!({"id":"w","name":"Dev capture","connectionId":"test","kind":"record","table":record()["table"],"key":record()["key"],"capture":"full","intervalSeconds":2})).unwrap();
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    connect(&app, &path, true);
    assert_eq!(
        call(&app, "watch_action", json!({"id":"w","action":"resume"}))
            .unwrap_err()
            .code,
        "CAPTURE_CONSENT"
    );
    drop(db);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[test]
#[ignore = "Run through bun run test:contracts to validate real IPC JSON in the frontend"]
fn emit_contract_fixture() {
    let output = std::env::var("KITSUNE_CONTRACT_FILE").expect("KITSUNE_CONTRACT_FILE is required");
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, false);
    call(&app,"save_watch",json!({"id":"contract","name":"Contract watch","connectionId":"test","kind":"record","table":record()["table"],"key":record()["key"],"intervalSeconds":5,"capture":"metadata"})).unwrap();
    let mutation_review=call(&app,"preview_table_mutation",json!({"connectionId":"test","table":{"schema":"","name":"no_identity","kind":"table"},"kind":"insert","values":{"note":{"kind":"text","value":"contract insert"}}})).unwrap();
    let mutation_result = call(
        &app,
        "commit_table_mutation",
        json!({"connectionId":"test","token":mutation_review["token"]}),
    )
    .unwrap();
    let appearance = call(
        &app,
        "save_appearance",
        json!({"theme":"forest","density":"comfortable"}),
    )
    .unwrap();
    let source_table = TableRef {
        schema: "".into(),
        name: "products".into(),
        kind: "table".into(),
    };
    let session = app.state::<AppState>().session("test").unwrap();
    let signature = session
        .db
        .lock()
        .unwrap()
        .restore_schema(&source_table)
        .unwrap();
    let restore_event = Event {
        id: "restore-contract".into(),
        watch_id: "contract".into(),
        connection_id: "test".into(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        event_type: "recordChanged".into(),
        summary: "Contract restore".into(),
        changes: vec![],
        before_state: Some(observed(&[
            ("id", Value::Integer("100".into())),
            ("name", Value::Text("Old notebook".into())),
        ])),
        after_state: Some(observed(&[
            ("id", Value::Integer("100".into())),
            ("name", Value::Text("Field notebook".into())),
        ])),
        record: Some(RecordRef {
            connection_id: "test".into(),
            table: source_table,
            key: std::collections::BTreeMap::from([("id".into(), Value::Integer("100".into()))]),
        }),
        capture: "full".into(),
        restore_source: Some(RestoreSource {
            watch_kind: "record".into(),
            schema_fingerprint: signature,
            complete: false,
        }),
    };
    app.state::<AppState>()
        .storage
        .event(&restore_event)
        .unwrap();
    let restore_preview = call(
        &app,
        "preview_restore",
        json!({"eventId":"restore-contract"}),
    )
    .unwrap();
    let restore_outcome=call(&app,"commit_restore",json!({"connectionId":"test","token":restore_preview["token"],"operationId":"contract-restore"})).unwrap();
    let diagnostic=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM products WHERE id=?1","params":[{"kind":"integer","value":"100"}],"mode":"estimate","operationId":"contract-plan"})).unwrap();
    let samples = json!({"sql_completion":call(&app,"sql_completion",json!({"connectionId":"test","tables":[record()["table"]]})).unwrap(),"restore_eligibility":call(&app,"restore_eligibility",json!({"eventId":"restore-contract"})).unwrap(),"diagnose_query":diagnostic,"preview_restore":restore_preview,"commit_restore":restore_outcome,"restore_receipt":call(&app,"restore_receipt",json!({"eventId":"restore-contract"})).unwrap(),"preview_table_mutation":mutation_review,"commit_table_mutation":mutation_result,"save_appearance":appearance,"update_cell":call(&app,"update_cell",json!({"record":record(),"column":"status","before":{"kind":"text","value":"pending"},"value":{"kind":"text","value":"confirmed"},"confirmed":true})).unwrap(),"bootstrap":call(&app,"bootstrap",json!({})).unwrap(),"tables":call(&app,"tables",json!({"connectionId":"test"})).unwrap(),"metadata":call(&app,"metadata",json!({"connectionId":"test","table":record()["table"]})).unwrap(),"browse":call(&app,"browse",json!({"connectionId":"test","table":record()["table"]})).unwrap(),"estimate_rows":call(&app,"estimate_rows",json!({"connectionId":"test","table":record()["table"]})).unwrap(),"index_advice":call(&app,"index_advice",json!({"connectionId":"test","table":record()["table"]})).unwrap(),"record":call(&app,"record",record()).unwrap(),"watches":call(&app,"watches",json!({})).unwrap(),"events":call(&app,"events",json!({})).unwrap(),"execute":call(&app,"execute",json!({"connectionId":"test","sql":"SELECT 1","operationId":"contract"})).unwrap(),"record_sql":call(&app,"record_sql",record()).unwrap(),"schema_table":call(&app,"schema_table",json!({"connectionId":"test","table":record()["table"]})).unwrap(),"schema_batch":call(&app,"schema_batch",json!({"connectionId":"test","operationId":"contract-schema","tables":[record()["table"],{"schema":"","name":"missing","kind":"table"}]})).unwrap(),"completion":call(&app,"completion",json!({"connectionId":"test","tables":[record()["table"]]})).unwrap()});
    std::fs::write(output, serde_json::to_vec(&samples).unwrap()).unwrap();
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
async fn generated_record_sql_binds_values_and_does_not_persist_parameters() {
    let (app, path, internal) = app();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, false);
    let query = call(&app, "record_sql", record()).unwrap();
    assert!(query["sql"].as_str().unwrap().contains("?1"));
    assert!(!query["sql"].as_str().unwrap().contains("5821"));
    let result=call(&app,"execute",json!({"connectionId":"test","sql":query["sql"],"params":query["params"],"operationId":"parameterized"})).unwrap();
    assert_eq!(result["results"][0]["rows"].as_array().unwrap().len(), 1);
    let history = call(&app, "history", json!({})).unwrap();
    assert!(!history.to_string().contains("5821"));
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(db);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[test]
fn cancelling_a_queued_query_does_not_execute_it() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute("CREATE TABLE pending(id INTEGER)", [])
        .unwrap();
    connect(&app, &path, false);
    let session = app.state::<AppState>().session("test").unwrap();
    let guard = session.db.lock().unwrap();
    let handle = app.handle().clone();
    let worker = std::thread::spawn(move || {
        dispatch(
            handle,
            "execute",
            json!({"connectionId":"test","sql":"INSERT INTO pending VALUES(1)","operationId":"queued"}),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let operation = loop {
        if let Some(operation) = app
            .state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .get("queued")
            .cloned()
        {
            break operation;
        }
        assert!(
            Instant::now() < deadline,
            "queued operation was not registered"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    operation.cancel();
    drop(guard);
    assert_eq!(worker.join().unwrap().unwrap_err().code, "CANCELLED");
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM pending", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        app.state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .is_empty()
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[test]
fn schema_viewer_reads_real_structure_and_source_sql_without_modifying_database() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, true);
    let before = std::fs::read(&path).unwrap();
    let details = call(
        &app,
        "schema_table",
        json!({"connectionId":"test","table":record()["table"]}),
    )
    .unwrap();
    assert_eq!(details["metadata"]["table"]["name"], "orders");
    assert!(
        details["metadata"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "status" && c["defaultValue"] == "'pending'")
    );
    assert!(
        details["incoming"]
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key["from"]["name"] == "order_items")
    );
    assert!(
        details["definition"]
            .as_str()
            .unwrap()
            .starts_with("CREATE TABLE orders")
    );
    let tables = call(&app, "tables", json!({"connectionId":"test"})).unwrap();
    let mut requested = tables.as_array().unwrap().clone();
    requested.push(json!({"schema":"","name":"missing_table","kind":"table"}));
    let result = call(
        &app,
        "schema_batch",
        json!({"connectionId":"test","operationId":"schema-test","tables":requested}),
    )
    .unwrap();
    assert_eq!(
        result["tables"].as_array().unwrap().len(),
        tables.as_array().unwrap().len()
    );
    assert_eq!(result["errors"].as_array().unwrap().len(), 1);
    assert_eq!(result["errors"][0]["error"]["code"], "TABLE_MISSING");
    let items = result["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["table"]["name"] == "order_items")
        .unwrap();
    assert_eq!(
        items["columns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["pk"].as_i64().unwrap() > 0)
            .count(),
        2
    );
    let malicious = call(
        &app,
        "schema_table",
        json!({"connectionId":"test","table":{"schema":"","name":"orders\";DROP TABLE orders;--","kind":"table"}}),
    );
    assert!(malicious.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(
        app.state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .is_empty()
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[test]
fn schema_batches_are_bounded_and_cancel_while_queued() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, false);
    let many = vec![record()["table"].clone(); 25];
    assert_eq!(
        call(
            &app,
            "schema_batch",
            json!({"connectionId":"test","operationId":"too-many","tables":many})
        )
        .unwrap_err()
        .code,
        "SCHEMA_LIMIT"
    );
    let session = app.state::<AppState>().session("test").unwrap();
    let guard = session.db.lock().unwrap();
    let handle = app.handle().clone();
    let worker = std::thread::spawn(move || {
        dispatch(
            handle,
            "schema_batch",
            json!({"connectionId":"test","operationId":"queued-schema","tables":[record()["table"]]}),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let operation = loop {
        if let Some(operation) = app
            .state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .get("queued-schema")
            .cloned()
        {
            break operation;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    };
    operation.cancel();
    drop(guard);
    assert_eq!(worker.join().unwrap().unwrap_err().code, "CANCELLED");
    assert!(
        app.state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .is_empty()
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
async fn cell_editor_is_parameterized_conflict_checked_and_read_only_guarded() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE parent(a TEXT,b INTEGER,PRIMARY KEY(a,b)); CREATE TABLE items(a TEXT,b INTEGER,name TEXT NOT NULL,note TEXT, FOREIGN KEY(a,b) REFERENCES parent(a,b),PRIMARY KEY(a,b)); INSERT INTO parent VALUES('root',1); INSERT INTO items VALUES('root',1,'original',NULL); CREATE TABLE no_key(name TEXT); INSERT INTO no_key VALUES('original');").unwrap();
    connect(&app, &path, false);
    let record = json!({"connectionId":"test","table":{"schema":"","name":"items","kind":"table"},"key":{"a":{"kind":"text","value":"root"},"b":{"kind":"integer","value":"1"}}});
    let payload = json!({"record":record,"column":"name","before":{"kind":"text","value":"original"},"value":{"kind":"text","value":"Robert'); DROP TABLE items;--"},"confirmed":true});
    assert_eq!(
        call(&app, "update_cell", payload.clone()).unwrap()["affected"],
        1
    );
    assert_eq!(
        external
            .query_row("SELECT name FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Robert'); DROP TABLE items;--"
    );
    assert_eq!(
        call(&app, "update_cell", payload.clone()).unwrap_err().code,
        "EDIT_CONFLICT"
    );
    let note = json!({"record":record,"column":"note","before":{"kind":"null"},"value":{"kind":"text","value":""},"confirmed":true});
    call(&app, "update_cell", note.clone()).unwrap();
    assert_eq!(
        external
            .query_row("SELECT note FROM items", [], |r| r.get::<_, String>(0))
            .unwrap(),
        ""
    );
    assert_eq!(
        call(&app, "update_cell", note).unwrap_err().code,
        "EDIT_CONFLICT"
    );
    let identity_edit = json!({"record":record,"column":"a","before":{"kind":"text","value":"root"},"value":{"kind":"text","value":"new"},"confirmed":true});
    assert_eq!(
        call(&app, "update_cell", identity_edit).unwrap_err().code,
        "EDIT_IDENTITY"
    );
    let mut missing_key = payload.clone();
    missing_key["record"]["key"] = json!({});
    assert_eq!(
        call(&app, "update_cell", missing_key).unwrap_err().code,
        "IDENTITY"
    );
    let mut no_consent = payload.clone();
    no_consent["confirmed"] = json!(false);
    assert_eq!(
        call(&app, "update_cell", no_consent).unwrap_err().code,
        "CONFIRMATION_REQUIRED"
    );
    let mut null_value = payload.clone();
    null_value["value"] = json!({"kind":"null"});
    assert_eq!(
        call(&app, "update_cell", null_value).unwrap_err().code,
        "VALIDATION"
    );
    let mut no_key = payload.clone();
    no_key["record"]["table"]["name"] = json!("no_key");
    assert_eq!(
        call(&app, "update_cell", no_key).unwrap_err().code,
        "IDENTITY"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    connect(&app, &path, true);
    assert_eq!(
        call(&app, "update_cell", payload).unwrap_err().code,
        "READ_ONLY"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
async fn reviewed_bulk_mutations_are_atomic_single_use_and_support_defaults() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE batch(tenant TEXT NOT NULL,n INTEGER NOT NULL,name TEXT NOT NULL DEFAULT 'untitled' CHECK(name<>'forbidden'),note TEXT,PRIMARY KEY(tenant,n)); INSERT INTO batch VALUES('t',1,'first',NULL),('t',2,'second',''); CREATE TRIGGER skip_one BEFORE UPDATE ON batch WHEN OLD.n=2 AND NEW.name='skip' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    connect(&app, &path, false);
    let table = json!({"schema":"","name":"batch","kind":"table"});
    let key = |n: i32| json!({"tenant":{"kind":"text","value":"t"},"n":{"kind":"integer","value":n.to_string()}});
    let update = |value: &str| json!({"connectionId":"test","table":table,"kind":"update","rows":[{"key":key(1),"before":{"kind":"text","value":"first"}},{"key":key(2),"before":{"kind":"text","value":"second"}}],"column":"name","value":{"kind":"text","value":value}});
    let commit = |review: &Json| {
        call(
            &app,
            "commit_table_mutation",
            json!({"connectionId":"test","token":review["token"]}),
        )
    };
    let names = || {
        external
            .prepare("SELECT name FROM batch ORDER BY n")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let review = call(&app, "preview_table_mutation", update("skip")).unwrap();
    assert_eq!(review["expectedRows"], 2);
    assert_eq!(commit(&review).unwrap_err().code, "MUTATION_CONFLICT");
    assert_eq!(names(), vec!["first", "second"]);
    assert_eq!(commit(&review).unwrap_err().code, "REVIEW_EXPIRED");
    let review = call(&app, "preview_table_mutation", update("forbidden")).unwrap();
    assert_eq!(commit(&review).unwrap_err().code, "SQLITE_CONSTRAINT");
    assert_eq!(names(), vec!["first", "second"]);
    let review = call(&app, "preview_table_mutation", update("new-name")).unwrap();
    external
        .execute("UPDATE batch SET name='outside' WHERE n=2", [])
        .unwrap();
    assert_eq!(commit(&review).unwrap_err().code, "MUTATION_CONFLICT");
    assert_eq!(names(), vec!["first", "outside"]);
    external
        .execute("UPDATE batch SET name='second' WHERE n=2", [])
        .unwrap();
    let review = call(
        &app,
        "preview_table_mutation",
        update("Robert'); DROP TABLE batch;--"),
    )
    .unwrap();
    assert!(!review["sql"].as_str().unwrap().contains("Robert"));
    assert_eq!(commit(&review).unwrap()["affected"], 2);
    assert_eq!(
        names(),
        vec![
            "Robert'); DROP TABLE batch;--",
            "Robert'); DROP TABLE batch;--"
        ]
    );
    let insert = json!({"connectionId":"test","table":table,"kind":"insert","values":{"tenant":{"kind":"text","value":"t"},"n":{"kind":"integer","value":"3"},"note":{"kind":"text","value":""}}});
    let review = call(&app, "preview_table_mutation", insert.clone()).unwrap();
    assert_eq!(commit(&review).unwrap()["affected"], 1);
    assert_eq!(
        external
            .query_row("SELECT name FROM batch WHERE n=3", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "untitled"
    );
    assert_eq!(
        external
            .query_row("SELECT note FROM batch WHERE n=3", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        ""
    );
    let mut duplicate = update("x");
    duplicate["rows"][1]["key"] = key(1);
    assert_eq!(
        call(&app, "preview_table_mutation", duplicate)
            .unwrap_err()
            .code,
        "IDENTITY"
    );
    let mut empty = update("x");
    empty["rows"] = json!([]);
    assert_eq!(
        call(&app, "preview_table_mutation", empty)
            .unwrap_err()
            .code,
        "IDENTITY"
    );
    let mut identity = update("x");
    identity["column"] = json!("n");
    assert_eq!(
        call(&app, "preview_table_mutation", identity)
            .unwrap_err()
            .code,
        "EDIT_IDENTITY"
    );
    let delete = json!({"connectionId":"test","table":table,"kind":"delete","rows":[{"key":key(1)},{"key":key(2)}]});
    external.execute_batch("CREATE TRIGGER skip_delete BEFORE DELETE ON batch WHEN OLD.n=2 BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    let review = call(&app, "preview_table_mutation", delete.clone()).unwrap();
    assert_eq!(commit(&review).unwrap_err().code, "MUTATION_CONFLICT");
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM batch", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    external.execute_batch("DROP TRIGGER skip_delete").unwrap();
    let review = call(&app, "preview_table_mutation", delete).unwrap();
    assert_eq!(commit(&review).unwrap()["affected"], 2);
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM batch", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    external
        .execute_batch(
            "CREATE TABLE auto_defaults(id INTEGER PRIMARY KEY,name TEXT DEFAULT 'created')",
        )
        .unwrap();
    let auto_review=call(&app,"preview_table_mutation",json!({"connectionId":"test","table":{"schema":"","name":"auto_defaults","kind":"table"},"kind":"insert"})).unwrap();
    assert!(
        auto_review["sql"]
            .as_str()
            .unwrap()
            .contains("DEFAULT VALUES")
    );
    assert_eq!(commit(&auto_review).unwrap()["affected"], 1);
    assert_eq!(
        external
            .query_row("SELECT name FROM auto_defaults WHERE id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "created"
    );
    let pending = call(&app, "preview_table_mutation", insert.clone()).unwrap();
    call(
        &app,
        "set_write_access",
        json!({"id":"test","enabled":false}),
    )
    .unwrap();
    assert_eq!(commit(&pending).unwrap_err().code, "READ_ONLY");
    assert_eq!(
        call(&app, "preview_table_mutation", insert)
            .unwrap_err()
            .code,
        "READ_ONLY"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    connect(&app, &path, false);
    assert_eq!(commit(&pending).unwrap_err().code, "REVIEW_EXPIRED");
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[test]
fn appearance_preferences_persist_without_saving_other_drafts() {
    let (app, path, internal) = app();
    let settings = ApplicationSettings {
        row_limit: 444,
        ..ApplicationSettings::default()
    };
    call(
        &app,
        "save_settings",
        serde_json::to_value(&settings).unwrap(),
    )
    .unwrap();
    for theme in [
        "dark", "light", "system", "midnight", "forest", "sand", "oled",
    ] {
        let saved = call(
            &app,
            "save_appearance",
            json!({"theme":theme,"density":"comfortable"}),
        )
        .unwrap();
        assert_eq!(saved["theme"], theme);
        assert_eq!(saved["rowLimit"], 444);
    }
    assert_eq!(
        call(
            &app,
            "save_appearance",
            json!({"theme":"unsupported","density":"compact"})
        )
        .unwrap_err()
        .code,
        "VALIDATION"
    );
    let bootstrap = call(&app, "bootstrap", json!({})).unwrap();
    assert_eq!(bootstrap["settings"]["theme"], "oled");
    assert_eq!(bootstrap["settings"]["density"], "comfortable");
    assert_eq!(bootstrap["settings"]["rowLimit"], 444);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

fn captured_event(
    app: &tauri::App<tauri::test::MockRuntime>,
    table: TableRef,
    key: std::collections::BTreeMap<String, Value>,
    kind: &str,
    before: Option<Vec<ObservedField>>,
    after: Option<Vec<ObservedField>>,
    complete: bool,
) -> Event {
    let session = app.state::<AppState>().session("test").unwrap();
    let signature = session.db.lock().unwrap().restore_schema(&table).unwrap();
    let event = Event {
        id: uuid::Uuid::new_v4().to_string(),
        watch_id: "capture-test".into(),
        connection_id: "test".into(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        event_type: kind.into(),
        summary: "Fixture observation".into(),
        changes: vec![],
        before_state: before,
        after_state: after,
        record: Some(RecordRef {
            connection_id: "test".into(),
            table,
            key,
        }),
        capture: "full".into(),
        restore_source: Some(RestoreSource {
            watch_kind: "record".into(),
            schema_fingerprint: signature,
            complete,
        }),
    };
    app.state::<AppState>().storage.event(&event).unwrap();
    event
}
fn observed(values: &[(&str, Value)]) -> Vec<ObservedField> {
    values
        .iter()
        .map(|(column, value)| ObservedField {
            column: (*column).into(),
            value: value.clone(),
        })
        .collect()
}
#[tokio::test]
async fn captured_restore_is_atomic_conflict_checked_and_preserves_excluded_fields() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE tracked(tenant TEXT NOT NULL,n INTEGER NOT NULL,label TEXT NOT NULL,secret_token TEXT,PRIMARY KEY(tenant,n)); INSERT INTO tracked VALUES('t',1,'new','never-copy-this');").unwrap();
    connect(&app, &path, false);
    let table = TableRef {
        schema: "".into(),
        name: "tracked".into(),
        kind: "table".into(),
    };
    let key = std::collections::BTreeMap::from([
        ("tenant".into(), Value::Text("t".into())),
        ("n".into(), Value::Integer("1".into())),
    ]);
    let before = observed(&[
        ("tenant", Value::Text("t".into())),
        ("n", Value::Integer("1".into())),
        ("label", Value::Text("old".into())),
    ]);
    let after = observed(&[
        ("tenant", Value::Text("t".into())),
        ("n", Value::Integer("1".into())),
        ("label", Value::Text("new".into())),
    ]);
    let event = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordChanged",
        Some(before.clone()),
        Some(after.clone()),
        false,
    );
    let review = call(&app, "preview_restore", json!({"eventId":event.id})).unwrap();
    assert!(!review.to_string().contains("never-copy-this"));
    external
        .execute("UPDATE tracked SET label='third'", [])
        .unwrap();
    assert_eq!(
        call(
            &app,
            "commit_restore",
            json!({"connectionId":"test","token":review["token"],"operationId":"conflicted"})
        )
        .unwrap_err()
        .code,
        "RESTORE_CONFLICT"
    );
    assert_eq!(
        external
            .query_row("SELECT label FROM tracked", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "third"
    );
    external
        .execute("UPDATE tracked SET label='new'", [])
        .unwrap();
    let review = call(&app, "preview_restore", json!({"eventId":event.id})).unwrap();
    let restored = call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":review["token"],"operationId":"restore-ok"}),
    )
    .unwrap();
    assert_eq!(restored["success"], true);
    assert_eq!(
        external
            .query_row("SELECT label FROM tracked", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "old"
    );
    assert_eq!(
        external
            .query_row("SELECT secret_token FROM tracked", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "never-copy-this"
    );
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":event.id})).unwrap()["code"],
        "RESTORE_APPLIED"
    );
    assert_eq!(
        call(
            &app,
            "commit_restore",
            json!({"connectionId":"test","token":review["token"],"operationId":"twice"})
        )
        .unwrap_err()
        .code,
        "REVIEW_EXPIRED"
    );
    let mut legacy = event.clone();
    legacy.id = uuid::Uuid::new_v4().to_string();
    legacy.restore_source = None;
    app.state::<AppState>().storage.event(&legacy).unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":legacy.id})).unwrap()["code"],
        "RESTORE_LEGACY"
    );
    let appeared = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordAppeared",
        None,
        Some(before.clone()),
        false,
    );
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":appeared.id})).unwrap()["code"],
        "RESTORE_CAPTURE"
    );
    let mut query = event.clone();
    query.id = uuid::Uuid::new_v4().to_string();
    query.restore_source.as_mut().unwrap().watch_kind = "query".into();
    app.state::<AppState>().storage.event(&query).unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":query.id})).unwrap()["code"],
        "RESTORE_SOURCE"
    );
    external
        .execute("UPDATE tracked SET label='new'", [])
        .unwrap();
    let guarded = captured_event(
        &app,
        table,
        key,
        "recordChanged",
        Some(before),
        Some(after),
        false,
    );
    let pending = call(&app, "preview_restore", json!({"eventId":guarded.id})).unwrap();
    external.execute_batch("CREATE TRIGGER modify_tracked AFTER UPDATE ON tracked BEGIN UPDATE tracked SET secret_token='side effect' WHERE n=NEW.n; END;").unwrap();
    assert_eq!(
        call(
            &app,
            "commit_restore",
            json!({"connectionId":"test","token":pending["token"],"operationId":"blocked-trigger"})
        )
        .unwrap_err()
        .code,
        "RESTORE_SIDE_EFFECTS"
    );
    assert_eq!(
        external
            .query_row("SELECT secret_token FROM tracked", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "never-copy-this"
    );
    external
        .execute_batch("DROP TRIGGER modify_tracked")
        .unwrap();
    let pending = call(&app, "preview_restore", json!({"eventId":guarded.id})).unwrap();
    call(&app, "clear_events", json!({"watchId":"capture-test"})).unwrap();
    assert_eq!(
        call(
            &app,
            "commit_restore",
            json!({"connectionId":"test","token":pending["token"],"operationId":"expired-history"})
        )
        .unwrap_err()
        .code,
        "REVIEW_EXPIRED"
    );
    let mut missing_receipt = event.clone();
    missing_receipt.id = uuid::Uuid::new_v4().to_string();
    app.state::<AppState>()
        .storage
        .event(&missing_receipt)
        .unwrap();
    let review = call(
        &app,
        "preview_restore",
        json!({"eventId":missing_receipt.id}),
    )
    .unwrap();
    app.state::<AppState>()
        .storage
        .db
        .lock()
        .unwrap()
        .execute_batch("DROP TABLE documents")
        .unwrap();
    let result = call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":review["token"],"operationId":"receipt-failed"}),
    )
    .unwrap();
    assert_eq!(result["success"], true);
    assert!(result["warning"].as_str().unwrap().contains("committed"));
    assert_eq!(
        external
            .query_row("SELECT label FROM tracked", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "old"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test]
async fn record_existence_restore_handles_generated_values_and_schema_guards() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE tracked(id INTEGER PRIMARY KEY,label TEXT NOT NULL,computed TEXT GENERATED ALWAYS AS(label||'!') STORED);").unwrap();
    connect(&app, &path, false);
    let table = TableRef {
        schema: "".into(),
        name: "tracked".into(),
        kind: "table".into(),
    };
    let key = std::collections::BTreeMap::from([("id".into(), Value::Integer("7".into()))]);
    let fields = observed(&[
        ("id", Value::Integer("7".into())),
        ("label", Value::Text("old".into())),
        ("computed", Value::Text("old!".into())),
    ]);
    let event = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordDisappeared",
        Some(fields.clone()),
        None,
        true,
    );
    let preview = call(&app, "preview_restore", json!({"eventId":event.id})).unwrap();
    assert!(!preview["sql"].as_str().unwrap().contains("computed"));
    call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":preview["token"],"operationId":"recreate"}),
    )
    .unwrap();
    assert_eq!(
        external
            .query_row("SELECT computed FROM tracked WHERE id=7", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "old!"
    );
    let appeared = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordAppeared",
        None,
        Some(fields.clone()),
        true,
    );
    external.execute_batch("CREATE TABLE child_cascade(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES tracked(id) ON DELETE CASCADE)").unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":appeared.id})).unwrap()["code"],
        "RESTORE_SIDE_EFFECTS"
    );
    external.execute_batch("DROP TABLE child_cascade; CREATE TABLE child_restrict(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES tracked(id)); INSERT INTO child_restrict VALUES(1,7);").unwrap();
    let blocked = call(&app, "preview_restore", json!({"eventId":appeared.id})).unwrap();
    assert_eq!(call(&app,"commit_restore",json!({"connectionId":"test","token":blocked["token"],"operationId":"constraint-rollback"})).unwrap_err().code,"SQLITE_CONSTRAINT");
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM tracked", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    external.execute_batch("DROP TABLE child_restrict").unwrap();
    let preview = call(&app, "preview_restore", json!({"eventId":appeared.id})).unwrap();
    call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":preview["token"],"operationId":"remove-appeared"}),
    )
    .unwrap();
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM tracked", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let event = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordDisappeared",
        Some(fields.clone()),
        None,
        true,
    );
    external
        .execute_batch("INSERT INTO tracked(id,label) VALUES(7,'new')")
        .unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":event.id})).unwrap()["code"],
        "RESTORE_CONFLICT"
    );
    external.execute_batch("DELETE FROM tracked").unwrap();
    let event = captured_event(
        &app,
        table,
        key,
        "recordDisappeared",
        Some(fields),
        None,
        true,
    );
    external
        .execute_batch("ALTER TABLE tracked ADD COLUMN new_field TEXT")
        .unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":event.id})).unwrap()["code"],
        "RESTORE_SCHEMA"
    );
    call(
        &app,
        "set_write_access",
        json!({"id":"test","enabled":false}),
    )
    .unwrap();
    assert_eq!(
        call(&app, "restore_eligibility", json!({"eventId":event.id})).unwrap()["code"],
        "READ_ONLY"
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test]
async fn diagnostics_preserve_parameters_reject_writes_and_report_partial_measurements() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external.execute_batch("CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT); CREATE INDEX data_name ON data(name); INSERT INTO data VALUES(1,'one'),(2,'two'),(3,'three');").unwrap();
    connect(&app, &path, false);
    let estimate=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM data WHERE id=?1","params":[{"kind":"integer","value":"2"}],"mode":"estimate","operationId":"estimate"})).unwrap();
    assert_eq!(estimate["engine"], "sqlite");
    assert!(estimate["costUnit"].is_null());
    assert!(!estimate["plan"]["rows"].as_array().unwrap().is_empty());
    let measured=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM data","mode":"measure","operationId":"measure"})).unwrap();
    assert_eq!(measured["rowsConsumed"], 3);
    assert_eq!(measured["complete"], true);
    let partial=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<2000) SELECT n FROM r","mode":"measure","operationId":"partial"})).unwrap();
    assert_eq!(partial["complete"], false);
    assert_eq!(partial["rowsConsumed"], 1000);
    for sql in [
        "UPDATE data SET name='bad'",
        "SELECT 1;DELETE FROM data",
        "WITH x AS (SELECT 1) DELETE FROM data",
    ] {
        assert!(
            call(
                &app,
                "diagnose_query",
                json!({"connectionId":"test","sql":sql,"mode":"measure","operationId":"write"})
            )
            .is_err()
        );
    }
    assert_eq!(
        external
            .query_row("SELECT COUNT(*) FROM data", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM data WHERE id=?1","mode":"estimate","operationId":"missing-param"})).is_err());
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
async fn diagnostics_timeout_leaves_connection_usable() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute("CREATE TABLE data(id INTEGER PRIMARY KEY)", [])
        .unwrap();
    connect(&app, &path, false);
    let settings = ApplicationSettings {
        query_timeout: 1,
        ..ApplicationSettings::default()
    };
    call(
        &app,
        "save_settings",
        serde_json::to_value(settings).unwrap(),
    )
    .unwrap();
    let error=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n) SELECT SUM(v) FROM n","mode":"measure","operationId":"timeout-plan"})).unwrap_err();
    assert_eq!(error.code, "SQLITE_INTERRUPTED");
    assert!(
        app.state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .is_empty()
    );
    assert!(call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT 1","mode":"estimate","operationId":"after-timeout"})).is_ok());
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[test]
fn queued_diagnostics_can_be_cancelled_before_execution() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute("CREATE TABLE data(id INTEGER PRIMARY KEY)", [])
        .unwrap();
    connect(&app, &path, false);
    let session = app.state::<AppState>().session("test").unwrap();
    let held = session.db.lock().unwrap();
    let handle = app.handle().clone();
    let worker = std::thread::spawn(move || {
        dispatch(
            handle,
            "diagnose_query",
            json!({"connectionId":"test","sql":"SELECT * FROM data","mode":"measure","operationId":"queued-diag"}),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(operation) = app
            .state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .get("queued-diag")
        {
            operation.cancel();
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    drop(held);
    assert_eq!(worker.join().unwrap().unwrap_err().code, "CANCELLED");
    assert!(
        app.state::<AppState>()
            .operations
            .lock()
            .unwrap()
            .is_empty()
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test]
#[ignore = "Requires libpq and the disposable PostgreSQL >=12 fixture on port 55432"]
async fn postgres_restore_and_diagnostics_fixture() {
    let (app, path, internal) = app();
    call(&app,"connect",json!({"id":"test","name":"Disposable PG","driver":"postgres","environment":"development","host":"127.0.0.1","port":55432,"database":"kitsune_test","username":"kitsune_test","password":"kitsune_test","sslMode":"disable","create":false,"readOnly":false})).unwrap();
    let table = TableRef {
        schema: "public".into(),
        name: format!("kitsune_restore_{}", uuid::Uuid::new_v4().simple()),
        kind: "table".into(),
    };
    let qualified = crate::database::qualified(&table);
    let session = app.state::<AppState>().session("test").unwrap();
    {
        let mut db = session.db.lock().unwrap();
        assert_eq!(
            db.query(
                "SELECT marker FROM public.kitsune_fixture_identity",
                &[],
                1,
                true,
                5
            )
            .unwrap()
            .rows[0][0],
            Value::Text("kitsune-disposable-network-v1".into()),
            "Refusing to mutate a non-fixture database"
        );
        db.query(&format!("CREATE TABLE {qualified}(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label TEXT NOT NULL,computed TEXT GENERATED ALWAYS AS(label||'!') STORED)"),&[],10,false,5).unwrap();
        db.query(
            &format!("INSERT INTO {qualified}(label) VALUES('new')"),
            &[],
            10,
            false,
            5,
        )
        .unwrap();
    }
    let key = std::collections::BTreeMap::from([("id".into(), Value::Integer("1".into()))]);
    let before = observed(&[
        ("id", Value::Integer("1".into())),
        ("label", Value::Text("old".into())),
        ("computed", Value::Text("old!".into())),
    ]);
    let after = observed(&[
        ("id", Value::Integer("1".into())),
        ("label", Value::Text("new".into())),
        ("computed", Value::Text("new!".into())),
    ]);
    let event = captured_event(
        &app,
        table.clone(),
        key.clone(),
        "recordChanged",
        Some(before.clone()),
        Some(after),
        true,
    );
    let review = call(&app, "preview_restore", json!({"eventId":event.id})).unwrap();
    call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":review["token"],"operationId":"pg-change"}),
    )
    .unwrap();
    {
        let mut db = session.db.lock().unwrap();
        assert_eq!(
            db.query(
                &format!("SELECT computed FROM {qualified}"),
                &[],
                10,
                true,
                5
            )
            .unwrap()
            .rows[0][0],
            Value::Text("old!".into())
        );
        db.query(&format!("DELETE FROM {qualified}"), &[], 10, false, 5)
            .unwrap();
    }
    let gone = captured_event(
        &app,
        table.clone(),
        key,
        "recordDisappeared",
        Some(before),
        None,
        true,
    );
    let review = call(&app, "preview_restore", json!({"eventId":gone.id})).unwrap();
    assert!(
        review["sql"]
            .as_str()
            .unwrap()
            .contains("OVERRIDING SYSTEM VALUE")
    );
    call(
        &app,
        "commit_restore",
        json!({"connectionId":"test","token":review["token"],"operationId":"pg-recreate"}),
    )
    .unwrap();
    for mode in ["estimate", "measure"] {
        let result=call(&app,"diagnose_query",json!({"connectionId":"test","sql":format!("SELECT * FROM {qualified} WHERE id=$1"),"params":[{"kind":"integer","value":"1"}],"mode":mode,"operationId":format!("pg-{mode}")})).unwrap();
        assert_eq!(result["costUnit"], "planner units");
        assert!(result["structuredPlan"].is_array());
    }
    session
        .db
        .lock()
        .unwrap()
        .query(&format!("DROP TABLE {qualified}"), &[], 10, false, 5)
        .unwrap();
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(session);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grouped_timed_watches_stop_and_layouts_persist() {
    let (app, path, internal) = app();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute_batch(include_str!("../../tests/fixtures/sqlite.sql"))
        .unwrap();
    connect(&app, &path, false);
    call(&app,"save_ui_state",json!({"key":"grid:test:orders","value":{"hidden":["status"],"order":["id","status"],"widths":{"status":220}}})).unwrap();
    assert_eq!(
        call(&app, "ui_state", json!({"key":"grid:test:orders"})).unwrap()["widths"]["status"],
        220
    );
    assert_eq!(
        call(&app, "ui_state", json!({"key":"grid:other:orders"})).unwrap(),
        Json::Null
    );
    for id in ["timed-a", "timed-b"] {
        call(&app,"save_watch",json!({"id":id,"name":id,"connectionId":"test","kind":"record","table":record()["table"],"key":record()["key"],"sql":"","intervalSeconds":2,"capture":"metadata","notifications":false,"filters":[],"excludedColumns":[],"durationSeconds":10,"groupName":"Order investigation"})).unwrap();
    }
    let result = call(
        &app,
        "watch_group_action",
        json!({"group":"Order investigation","action":"resume"}),
    )
    .unwrap();
    assert_eq!(result["completed"], 2);
    assert_eq!(result["errors"], json!([]));
    let state = app.state::<AppState>();
    let running = state.storage.list::<Watch>("watches").unwrap();
    assert!(
        running
            .iter()
            .all(|w| w.status == "running" && w.deadline_at.is_some())
    );
    call(
        &app,
        "watch_group_action",
        json!({"group":"Order investigation","action":"pause"}),
    )
    .unwrap();
    assert!(
        state
            .storage
            .list::<Watch>("watches")
            .unwrap()
            .iter()
            .all(|w| w.status == "paused")
    );
    call(
        &app,
        "watch_action",
        json!({"id":"timed-a","action":"resume"}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(14);
    loop {
        let watch = state
            .storage
            .list::<Watch>("watches")
            .unwrap()
            .into_iter()
            .find(|w| w.id == "timed-a")
            .unwrap();
        if watch.status == "stopped" {
            break;
        }
        assert!(
            Instant::now() < until,
            "Timed watch did not stop at its deadline"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!state.tasks.lock().unwrap().contains_key("timed-a"));
    let events = state.storage.events(Some("timed-a".into()), 100).unwrap();
    assert!(
        events
            .iter()
            .any(|e| e.event_type == "watchStopped" && e.summary.contains("Timed watch completed"))
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let storage = Storage::open(&internal).unwrap();
    assert_eq!(
        storage.list::<Json>("ui_state").unwrap()[0]["widths"]["status"],
        220
    );
    drop(storage);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

fn mysql_editor(
    app: &tauri::App<tauri::test::MockRuntime>,
    tab: &str,
    sql: &str,
    script: bool,
) -> Json {
    let mut payload = json!({"connectionId":"test","tabId":tab,"sql":sql,"script":script,"operationId":uuid::Uuid::new_v4().to_string()});
    let result = call(app, "execute", payload.clone());
    let response = match result {
        Err(Error { code, .. }) if code == "CONFIRM_REQUIRED" => {
            let review = call(app, "review_query", payload.clone()).unwrap();
            payload["confirmationToken"] = review["token"].clone();
            call(app, "execute", payload).unwrap()
        }
        Ok(value) => value,
        Err(error) => panic!("Native SQL failed: {error:?}"),
    };
    assert!(
        response["error"].is_null(),
        "Native SQL error: {}",
        response["error"]
    );
    response
}

// Fixed loopback endpoints belong only to compose.engines.yaml. Never use a user connection here.
async fn network_mysql_workflow(port: u16) {
    let (app, path, internal) = app();
    let payload = json!({"id":"test","name":"Disposable network fixture","driver":"mysql","environment":"development","host":"127.0.0.1","port":port,"database":"kitsune_test","username":"kitsune_test","password":"kitsune_test","sslMode":"require","readOnly":false});
    let config: ConnectionConfig = serde_json::from_value(payload.clone()).unwrap();
    let mut external = crate::database::Database::open(&config, &internal, false).unwrap();
    assert_eq!(
        external
            .query(
                "SELECT marker FROM kitsune_fixture_identity",
                &[],
                1,
                true,
                5
            )
            .unwrap()
            .rows[0][0],
        Value::Text("kitsune-disposable-network-v1".into()),
        "Refusing to mutate a non-fixture database"
    );
    let order_table = TableRef {
        schema: "kitsune_test".into(),
        name: "orders".into(),
        kind: "table".into(),
    };
    crate::tests::assert_keyset_paging(&mut external, order_table.clone(), true);
    crate::tests::assert_keyset_paging(
        &mut external,
        TableRef {
            schema: "kitsune_test".into(),
            name: "order_items".into(),
            kind: "table".into(),
        },
        true,
    );
    external.estimate_rows(&order_table).unwrap();
    external.index_advice(&order_table).unwrap();
    external
        .query(
            "UPDATE orders SET status='pending' WHERE id=5821",
            &[],
            1,
            false,
            5,
        )
        .unwrap();
    // The fixture requires encrypted transport and has an intentionally untrusted self-signed cert.
    let mut verify = config.clone();
    verify.ssl_mode = "verify-full".into();
    assert!(
        matches!(crate::database::Database::open(&verify,&internal,false),Err(Error{code,..}) if code=="TLS_CERTIFICATE"),
        "verify-full must reject an untrusted certificate without downgrading"
    );
    verify.tls_ca_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.kitsune-engine-tests/tls/ca.pem")
        .to_string_lossy()
        .into_owned();
    let mut trusted = crate::database::Database::open(&verify, &internal, false)
        .expect("trusted fixture CA must verify the TLS handshake");
    assert_eq!(
        trusted
            .query("SELECT 1", &[], 1, true, 5)
            .unwrap()
            .rows
            .len(),
        1
    );
    let mut mutual = verify.clone();
    mutual.username = "kitsune_mtls".into();
    assert!(
        crate::database::Database::open(&mutual, &internal, false).is_err(),
        "client certificate was not required"
    );
    let tls_directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.kitsune-engine-tests/tls");
    mutual.tls_cert_path = tls_directory
        .join("client.pem")
        .to_string_lossy()
        .into_owned();
    mutual.tls_key_path = tls_directory
        .join("client-key.pem")
        .to_string_lossy()
        .into_owned();
    let mut mutual_db = crate::database::Database::open(&mutual, &internal, false)
        .expect("client certificate authentication must work");
    assert_eq!(
        mutual_db
            .query("SELECT 1", &[], 1, true, 5)
            .unwrap()
            .rows
            .len(),
        1
    );
    let mut unencrypted = config.clone();
    unencrypted.ssl_mode = "disable".into();
    assert!(
        crate::database::Database::open(&unencrypted, &internal, false).is_err(),
        "fixture accepted an unencrypted connection"
    );
    let connected = call(&app, "connect", payload.clone()).unwrap();
    assert_eq!(connected["capabilities"]["supportsTransactionalDdl"], false);
    assert_eq!(connected["capabilities"]["supportsHistoricalRestore"], true);
    let target = json!({"connectionId":"test","table":{"schema":"kitsune_test","name":"orders","kind":"table"},"key":{"id":{"kind":"integer","value":"5821"}}});
    let inspected = call(&app, "record", target.clone()).unwrap();
    let relationships = inspected["relationships"].as_array().unwrap();
    assert!(
        relationships
            .iter()
            .any(|r| r["direction"] == "outgoing" && r["foreignKey"]["to"]["name"] == "customers")
    );
    assert!(
        relationships
            .iter()
            .any(|r| r["direction"] == "incoming"
                && r["foreignKey"]["from"]["name"] == "order_items")
    );
    let values = inspected["result"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .zip(inspected["result"]["rows"][0].as_array().unwrap())
        .map(|(c, v)| (c.as_str().unwrap().to_owned(), v.clone()))
        .collect::<serde_json::Map<_, _>>();
    for relation in relationships {
        let expanded=call(&app,"expand",json!({"connectionId":"test","foreignKey":relation["foreignKey"],"direction":relation["direction"],"values":values})).unwrap();
        assert!(!expanded["result"]["rows"].as_array().unwrap().is_empty());
    }
    let exact = external
        .query(
            "SELECT id,amount,empty_text,null_text,payload FROM exact_values",
            &[],
            10,
            true,
            5,
        )
        .unwrap();
    assert_eq!(
        exact.rows[0][0],
        Value::Integer("18446744073709551615".into())
    );
    assert_eq!(
        exact.rows[0][1],
        Value::Decimal("12345678901234567890.12345678901234567890".into())
    );
    assert_eq!(exact.rows[0][2], Value::Text(String::new()));
    assert_eq!(exact.rows[0][3], Value::Null);
    assert_eq!(exact.rows[0][4], Value::Binary("AP+A".into()));
    assert!(
        external
            .query(
                "UPDATE orders SET status='forbidden' WHERE id=5821",
                &[],
                1,
                true,
                5
            )
            .is_err()
    );
    let composite=call(&app,"metadata",json!({"connectionId":"test","table":{"schema":"kitsune_test","name":"composite_parent","kind":"table"}})).unwrap();
    assert_eq!(
        composite["columns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["pk"].as_i64().unwrap() > 0)
            .count(),
        2
    );
    let diagnostic=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM orders WHERE id=?1","params":[{"kind":"integer","value":"5821"}],"mode":"estimate","operationId":"mysql-network-plan"})).unwrap();
    assert_eq!(diagnostic["engine"], "mysql");
    assert!(diagnostic["structuredPlan"].is_object());
    call(&app,"save_watch",json!({"id":"network-order","name":"Network order","connectionId":"test","kind":"record","table":target["table"],"key":target["key"],"intervalSeconds":2,"capture":"full","notifications":false})).unwrap();
    call(
        &app,
        "watch_action",
        json!({"id":"network-order","action":"start"}),
    )
    .unwrap();
    async fn baseline(
        app: &tauri::App<tauri::test::MockRuntime>,
        previous: Option<String>,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let watches = call(app, "watches", json!({})).unwrap();
            let observed = watches
                .as_array()
                .unwrap()
                .iter()
                .find(|w| w["id"] == "network-order")
                .and_then(|w| w["lastObserved"].as_str());
            if let Some(observed) = observed
                && Some(observed) != previous.as_deref()
            {
                return observed.into();
            }
            assert!(
                Instant::now() < deadline,
                "Network watch baseline timed out: {watches}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    baseline(&app, None).await;
    external
        .query(
            "UPDATE orders SET status=?1 WHERE id=?2",
            &[
                Value::Text("captured".into()),
                Value::Integer("5821".into()),
            ],
            1,
            false,
            5,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let events = call(&app, "events", json!({"watchId":"network-order"})).unwrap();
        if let Some(event) = events
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["eventType"] == "recordChanged")
        {
            assert!(
                event["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["column"] == "status"
                        && c["before"]["value"] == "pending"
                        && c["after"]["value"] == "captured")
            );
            assert!(!event.to_string().contains("fixture-secret-not-for-history"));
            call(
                &app,
                "watch_action",
                json!({"id":"network-order","action":"pause"}),
            )
            .unwrap();
            let review = call(&app, "preview_restore", json!({"eventId":event["id"]}))
                .expect("full-value MySQL observation must support a reviewed restore");
            call(&app,"commit_restore",json!({"connectionId":"test","token":review["token"],"operationId":"mysql-restored-event"})).unwrap();
            assert_eq!(
                external
                    .query("SELECT status FROM orders WHERE id=5821", &[], 1, true, 5)
                    .unwrap()
                    .rows[0][0],
                Value::Text("pending".into())
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "No externally modified record event was captured"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let paused = call(
        &app,
        "watch_action",
        json!({"id":"network-order","action":"pause"}),
    )
    .unwrap();
    call(
        &app,
        "watch_action",
        json!({"id":"network-order","action":"resume"}),
    )
    .unwrap();
    baseline(&app, paused["lastObserved"].as_str().map(str::to_owned)).await;
    call(
        &app,
        "watch_action",
        json!({"id":"network-order","action":"pause"}),
    )
    .unwrap();
    let started = Instant::now();
    let timed = external
        .query("SELECT SLEEP(30)", &[], 1, true, 1)
        .unwrap_err();
    assert_eq!(timed.code, "QUERY_TIMEOUT");
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "Server timeout cancellation exceeded 6 seconds"
    );
    assert_eq!(
        external.query("SELECT 1", &[], 1, true, 5).unwrap().rows[0][0],
        Value::Integer("1".into())
    );
    let interrupt = external.interrupt().unwrap();
    let worker = std::thread::spawn(move || {
        let result = external.query("SELECT SLEEP(30)", &[], 1, true, 30);
        (external, result)
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    interrupt.cancel();
    let (mut external, cancelled) = worker.join().unwrap();
    assert_eq!(cancelled.unwrap_err().code, "INTERRUPTED");
    assert!(external.query("SELECT 1", &[], 1, true, 5).is_ok());

    let begin = mysql_editor(&app, "tx-a", "START TRANSACTION", false);
    assert_eq!(begin["transactionState"], "active");
    mysql_editor(
        &app,
        "tx-a",
        "UPDATE orders SET status='uncommitted' WHERE id=5821",
        false,
    );
    let isolated = mysql_editor(
        &app,
        "tx-b",
        "SELECT status FROM orders WHERE id=5821",
        false,
    );
    assert_ne!(isolated["results"][0]["rows"][0][0]["value"], "uncommitted");
    assert_eq!(
        call(&app, "bootstrap", json!({})).unwrap()["transactions"]["tx-a"],
        "active"
    );
    assert_eq!(
        call(
            &app,
            "close_editor_session",
            json!({"connectionId":"test","tabId":"tx-a"})
        )
        .unwrap_err()
        .code,
        "CONFIRM_REQUIRED"
    );
    assert_eq!(
        mysql_editor(&app, "tx-a", "ROLLBACK", false)["transactionState"],
        "idle"
    );
    mysql_editor(&app, "tx-a", "START TRANSACTION", false);
    mysql_editor(
        &app,
        "tx-a",
        "UPDATE orders SET status='committed' WHERE id=5821",
        false,
    );
    assert_eq!(
        mysql_editor(&app, "tx-a", "COMMIT", false)["transactionState"],
        "idle"
    );
    assert_eq!(
        external
            .query("SELECT status FROM orders WHERE id=5821", &[], 1, true, 5)
            .unwrap()
            .rows[0][0],
        Value::Text("committed".into())
    );
    mysql_editor(
        &app,
        "tx-a",
        "DROP TABLE IF EXISTS kitsune_native_sql",
        false,
    );
    mysql_editor(&app, "tx-a", "START TRANSACTION", false);
    let ddl = mysql_editor(
        &app,
        "tx-a",
        "CREATE TABLE kitsune_native_sql(id INT PRIMARY KEY, label VARCHAR(50)) ENGINE=InnoDB",
        false,
    );
    assert_eq!(ddl["transactionState"], "idle");
    assert!(ddl["warning"].as_str().unwrap().contains("implicit commit"));
    assert_eq!(ddl["schemaChanged"], true);
    mysql_editor(
        &app,
        "tx-a",
        "ALTER TABLE kitsune_native_sql ADD amount DECIMAL(30,10)",
        false,
    );
    mysql_editor(
        &app,
        "tx-a",
        "CREATE INDEX kitsune_label ON kitsune_native_sql(label)",
        false,
    );
    mysql_editor(
        &app,
        "tx-a",
        "DROP PROCEDURE IF EXISTS kitsune_results",
        false,
    );
    let routine = "DELIMITER $$\nCREATE PROCEDURE kitsune_results() BEGIN SELECT 'first' AS label; SELECT 2 AS number; END$$\nDELIMITER ;\nCALL kitsune_results();";
    let called = mysql_editor(&app, "tx-a", routine, true);
    assert!(
        called["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["rows"][0][0]["value"] == "first")
    );
    assert!(
        called["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["rows"][0][0]["value"] == "2")
    );
    mysql_editor(
        &app,
        "tx-a",
        "UPDATE orders o JOIN payments p ON p.order_id=o.id SET o.status='multi-table',p.status='multi-table' WHERE o.id=5821",
        false,
    );
    mysql_editor(&app, "tx-a", "DROP PROCEDURE kitsune_results", false);
    mysql_editor(&app, "tx-a", "DROP TABLE kitsune_native_sql", false);
    mysql_editor(&app, "tx-a", "START TRANSACTION", false);
    mysql_editor(
        &app,
        "tx-a",
        "UPDATE orders SET status='discard-me' WHERE id=5821",
        false,
    );
    call(
        &app,
        "close_editor_session",
        json!({"connectionId":"test","tabId":"tx-a","confirmed":true}),
    )
    .unwrap();
    assert_ne!(
        external
            .query("SELECT status FROM orders WHERE id=5821", &[], 1, true, 5)
            .unwrap()
            .rows[0][0],
        Value::Text("discard-me".into())
    );
    mysql_editor(&app, "tx-a", "START TRANSACTION", false);
    let failed = call(&app,"execute",json!({"connectionId":"test","tabId":"tx-a","sql":"SELECT * FROM kitsune_missing_fixture_table","operationId":"lost-native-tx"})).unwrap();
    assert!(!failed["error"].is_null());
    assert_eq!(failed["transactionState"], "lost");
    assert_eq!(
        call(
            &app,
            "editor_status",
            json!({"connectionId":"test","tabId":"tx-a"})
        )
        .unwrap()["transactionState"],
        "lost"
    );
    assert_eq!(call(&app,"execute",json!({"connectionId":"test","tabId":"tx-a","sql":"SELECT 1","operationId":"lost-continuation"})).unwrap_err().code,"TRANSACTION_LOST");
    call(
        &app,
        "close_editor_session",
        json!({"connectionId":"test","tabId":"tx-a","confirmed":true}),
    )
    .unwrap();
    mysql_editor(&app, "tx-a", "SELECT 1", false);
    let reviewed = call(&app,"review_query",json!({"connectionId":"test","tabId":"tx-a","sql":"UPDATE orders SET status='cross-tab' WHERE id=5821"})).unwrap();
    assert_eq!(call(&app,"execute",json!({"connectionId":"test","tabId":"tx-b","sql":"UPDATE orders SET status='cross-tab' WHERE id=5821","confirmationToken":reviewed["token"],"operationId":"cross-tab-token"})).unwrap_err().code,"CONFIRM_REQUIRED");
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    call(&app, "connect", payload).unwrap();
    assert_eq!(
        call(
            &app,
            "browse",
            json!({"connectionId":"test","table":target["table"],"limit":1})
        )
        .unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires MySQL 8.4 TLS fixture from bun run engines:up on loopback port 53306"]
async fn mysql_network_workflow_fixture() {
    network_mysql_workflow(53306).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires MariaDB 11.4 TLS fixture from bun run engines:up on loopback port 53307"]
async fn mariadb_network_workflow_fixture() {
    network_mysql_workflow(53307).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SQL Server fixture from bun run engines:up --sqlserver on loopback port 51433"]
async fn sqlserver_network_workflow_fixture() {
    let (app, path, internal) = app();
    let payload = json!({"id":"test","name":"Disposable SQL Server","driver":"mssql","environment":"development","host":"127.0.0.1","port":51433,"database":"kitsune_test","username":"kitsune_test","password":"Kitsune_fixture_rw_42!","sslMode":"require","readOnly":false});
    let cfg: ConnectionConfig = serde_json::from_value(payload.clone()).unwrap();
    let mut external = crate::database::Database::open(&cfg, &internal, false).unwrap();
    assert_eq!(
        external
            .query(
                "SELECT marker FROM dbo.kitsune_fixture_identity",
                &[],
                1,
                true,
                5
            )
            .unwrap()
            .rows[0][0],
        Value::Text("kitsune-disposable-network-v1".into())
    );
    let order_table = TableRef {
        schema: "dbo".into(),
        name: "orders".into(),
        kind: "table".into(),
    };
    crate::tests::assert_keyset_paging(&mut external, order_table.clone(), false);
    crate::tests::assert_keyset_paging(
        &mut external,
        TableRef {
            schema: "dbo".into(),
            name: "order_items".into(),
            kind: "table".into(),
        },
        false,
    );
    external.estimate_rows(&order_table).unwrap();
    external.index_advice(&order_table).unwrap();
    external
        .query(
            "UPDATE dbo.orders SET status=?1 WHERE id=?2",
            &[Value::Text("pending".into()), Value::Integer("5821".into())],
            1,
            false,
            10,
        )
        .unwrap();
    let mut readonly = cfg.clone();
    readonly.read_only = true;
    assert!(
        matches!(crate::database::Database::open(&readonly,&internal,false),Err(Error{code,..}) if code=="READ_ONLY_CREDENTIALS")
    );
    readonly.username = "kitsune_readonly".into();
    readonly.password = "Kitsune_fixture_ro_42!".into();
    let mut reader = crate::database::Database::open(&readonly, &internal, false).unwrap();
    assert!(
        reader
            .query("SELECT * FROM dbo.orders", &[], 100, true, 10)
            .is_ok()
    );
    assert!(
        reader
            .query("UPDATE dbo.orders SET status='bad'", &[], 1, false, 10)
            .is_err()
    );
    let mut verify = cfg.clone();
    verify.ssl_mode = "verify-full".into();
    assert!(crate::database::Database::open(&verify, &internal, false).is_err());
    call(&app, "connect", payload.clone()).unwrap();
    let target = json!({"connectionId":"test","table":{"schema":"dbo","name":"orders","kind":"table"},"key":{"id":{"kind":"integer","value":"5821"}}});
    let record = call(&app, "record", target.clone()).unwrap();
    assert_eq!(record["result"]["rows"].as_array().unwrap().len(), 1);
    assert!(
        record["relationships"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["foreignKey"]["to"]["name"] == "customers")
    );
    assert!(
        record["relationships"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["foreignKey"]["from"]["name"] == "order_items")
    );
    let values = record["result"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .zip(record["result"]["rows"][0].as_array().unwrap())
        .map(|(k, v)| (k.as_str().unwrap().to_owned(), v.clone()))
        .collect::<serde_json::Map<_, _>>();
    for r in record["relationships"].as_array().unwrap() {
        let expanded=call(&app,"expand",json!({"connectionId":"test","foreignKey":r["foreignKey"],"direction":r["direction"],"values":values})).unwrap();
        assert!(!expanded["result"]["rows"].as_array().unwrap().is_empty());
    }
    let exact=external.query("SELECT CAST(9223372036854775807 AS bigint),CAST(-0.00000000000000000001 AS decimal(38,20)),CAST(0x00FF80 AS varbinary(max)),CAST(NULL AS nvarchar(1)),CAST('' AS nvarchar(1)),CAST('2026-01-01' AS date)",&[],1,true,10).unwrap();
    assert_eq!(
        exact.rows[0][0],
        Value::Integer("9223372036854775807".into())
    );
    assert_eq!(
        exact.rows[0][1],
        Value::Decimal("-0.00000000000000000001".into())
    );
    assert_eq!(exact.rows[0][2], Value::Binary("AP+A".into()));
    assert_eq!(exact.rows[0][3], Value::Null);
    assert_eq!(exact.rows[0][4], Value::Text("".into()));
    assert_eq!(exact.rows[0][5], Value::Date("2026-01-01".into()));
    let composite=call(&app,"metadata",json!({"connectionId":"test","table":{"schema":"dbo","name":"composite_parent","kind":"table"}})).unwrap();
    assert_eq!(
        composite["columns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["pk"].as_i64().unwrap() > 0)
            .count(),
        2
    );
    call(&app,"update_cell",json!({"record":target,"column":"status","before":{"kind":"text","value":"pending"},"value":{"kind":"text","value":"edited"},"confirmed":true})).unwrap();
    assert!(call(&app,"update_cell",json!({"record":target,"column":"status","before":{"kind":"text","value":"pending"},"value":{"kind":"text","value":"stale"},"confirmed":true})).is_err());
    let diag=call(&app,"diagnose_query",json!({"connectionId":"test","sql":"SELECT * FROM dbo.orders WHERE id=?1","params":[{"kind":"integer","value":"5821"}],"mode":"estimate","operationId":"mssql-plan"})).unwrap();
    assert_eq!(diag["engine"], "mssql");
    assert!(diag["plan"]["rows"].to_string().contains("ShowPlanXML"));
    call(&app,"save_watch",json!({"id":"mssql-watch","name":"SQL Server order","connectionId":"test","kind":"record","table":target["table"],"key":target["key"],"intervalSeconds":2,"capture":"full"})).unwrap();
    call(
        &app,
        "watch_action",
        json!({"id":"mssql-watch","action":"start"}),
    )
    .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let w = call(&app, "watches", json!({})).unwrap();
        if !w[0]["lastObserved"].is_null() {
            break;
        }
        assert!(
            Instant::now() < until,
            "SQL Server watch did not establish baseline: {w}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    external
        .query(
            "UPDATE dbo.orders SET status=?1 WHERE id=?2",
            &[
                Value::Text("observed".into()),
                Value::Integer("5821".into()),
            ],
            1,
            false,
            10,
        )
        .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let e = call(&app, "events", json!({"watchId":"mssql-watch"})).unwrap();
        if e.as_array()
            .unwrap()
            .iter()
            .any(|e| e["eventType"] == "recordChanged")
        {
            break;
        }
        assert!(
            Instant::now() < until,
            "SQL Server watch did not capture external change"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    call(
        &app,
        "watch_action",
        json!({"id":"mssql-watch","action":"pause"}),
    )
    .unwrap();
    let review=call(&app,"preview_table_mutation",json!({"connectionId":"test","table":target["table"],"kind":"update","column":"status","value":{"kind":"text","value":"bulk"},"rows":[{"key":target["key"],"before":{"kind":"text","value":"observed"}}]})).unwrap();
    call(
        &app,
        "commit_table_mutation",
        json!({"connectionId":"test","token":review["token"]}),
    )
    .unwrap();
    let heavy = "SELECT COUNT_BIG(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c CROSS JOIN sys.all_objects d";
    let start = Instant::now();
    assert_eq!(
        external.query(heavy, &[], 1, true, 1).unwrap_err().code,
        "QUERY_TIMEOUT"
    );
    assert!(start.elapsed() < Duration::from_secs(6));
    assert!(external.query("SELECT 1", &[], 1, true, 10).is_ok());
    let interrupt = external.interrupt().unwrap();
    let worker = std::thread::spawn(move || {
        let r = external.query(heavy, &[], 1, true, 30);
        (external, r)
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    interrupt.cancel();
    let (mut external, cancelled) = worker.join().unwrap();
    assert_eq!(cancelled.unwrap_err().code, "INTERRUPTED");
    assert!(external.query("SELECT 1", &[], 1, true, 10).is_ok());
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    call(&app, "connect", payload).unwrap();
    assert!(call(&app, "record", target).is_ok());
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    drop(reader);
    drop(external);
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bootstrap_preserves_current_session_write_mode() {
    let (app, path, internal) = app();
    rusqlite::Connection::open(&path).unwrap();
    connect(&app, &path, false);
    assert_eq!(
        call(&app, "bootstrap", json!({})).unwrap()["readOnly"]["test"],
        false
    );
    call(
        &app,
        "set_write_access",
        json!({"id":"test","enabled":false}),
    )
    .unwrap();
    let bootstrap = call(&app, "bootstrap", json!({})).unwrap();
    assert_eq!(bootstrap["readOnly"]["test"], true);
    assert_eq!(bootstrap["connections"][0]["readOnly"], false);
    call(
        &app,
        "set_write_access",
        json!({"id":"test","enabled":true,"confirmed":true}),
    )
    .unwrap();
    assert_eq!(
        call(&app, "bootstrap", json!({})).unwrap()["readOnly"]["test"],
        false
    );
    call(&app, "disconnect", json!({"id":"test"})).unwrap();
    let bootstrap = call(&app, "bootstrap", json!({})).unwrap();
    assert_eq!(bootstrap["readOnly"], json!({}));
    assert_eq!(bootstrap["active"], json!([]));
    drop(app);
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(internal);
}
