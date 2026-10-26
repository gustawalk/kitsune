use crate::{database::*, model::*, storage::Storage};
use std::collections::BTreeMap;
fn config(path: String) -> ConnectionConfig {
    ConnectionConfig {
        id: "test".into(),
        name: "Test".into(),
        driver: "sqlite".into(),
        environment: "development".into(),
        path,
        host: String::new(),
        port: 5432,
        database: String::new(),
        username: String::new(),
        password: "do-not-persist".into(),
        ssl_mode: "prefer".into(),
        read_only: false,
        create: true,
    }
}
fn temp_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("kitsune-test-{}.sqlite3", uuid::Uuid::new_v4()))
}
#[test]
fn saved_config_has_no_password() {
    let c = config("test.sqlite".into());
    let encoded = serde_json::to_string(&c).unwrap();
    assert!(!encoded.contains("do-not-persist"));
    assert!(!encoded.contains("password"));
    assert!(config(String::new()).validate().is_err());
}
#[test]
fn sqlite_end_to_end_metadata_composite_identity_and_safe_values() {
    let path = temp_path();
    let mut c = config(path.to_string_lossy().into());
    let mut db = Database::open(&c, &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE parent(a INTEGER,b TEXT,PRIMARY KEY(a,b))",
        &[],
        100,
        false,
        30,
    )
    .unwrap();
    db.query(
        "CREATE TABLE child(x INTEGER,y TEXT,payload BLOB,FOREIGN KEY(x,y) REFERENCES parent(a,b))",
        &[],
        100,
        false,
        30,
    )
    .unwrap();
    db.query(
        "INSERT INTO parent VALUES(9223372036854775807,'')",
        &[],
        100,
        false,
        30,
    )
    .unwrap();
    let table = TableRef {
        schema: String::new(),
        name: "parent".into(),
        kind: "table".into(),
    };
    let metadata = db.metadata(&table).unwrap();
    assert_eq!(metadata.columns.iter().filter(|c| c.pk > 0).count(), 2);
    let result = db
        .browse(&BrowseRequest {
            filter_groups: vec![],
            group_mode: "all".into(),
            connection_id: "test".into(),
            table,
            filters: vec![],
            sort: String::new(),
            descending: false,
            offset: 0,
            limit: 100,
        })
        .unwrap();
    assert_eq!(
        result.rows[0][0],
        Value::Integer("9223372036854775807".into())
    );
    assert_eq!(result.rows[0][1], Value::Text(String::new()));
    assert_eq!(
        record_key(&metadata, &result.rows[0], &result.columns).len(),
        2
    );
    let child = db
        .metadata(&TableRef {
            schema: String::new(),
            name: "child".into(),
            kind: "table".into(),
        })
        .unwrap();
    assert_eq!(child.foreign_keys[0].columns.len(), 2);
    assert!(db.query("DELETE FROM parent", &[], 100, true, 30).is_err());
    assert!(
        db.query("ATTACH ':memory:' AS other", &[], 100, false, 30)
            .is_err()
    );
    c.create = false;
    c.read_only = true;
    let mut readonly = Database::open(&c, &temp_path(), true).unwrap();
    assert!(
        readonly
            .query("INSERT INTO parent VALUES(2,'x')", &[], 100, false, 30)
            .is_err()
    );
    drop(db);
    drop(readonly);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn bounded_browsing_and_parameterized_filters() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE sample(id INTEGER PRIMARY KEY,label TEXT)",
        &[],
        100,
        false,
        30,
    )
    .unwrap();
    for n in 0..5 {
        db.query(
            "INSERT INTO sample VALUES(?1,?2)",
            &[
                Value::Integer(n.to_string()),
                Value::Text("' OR 1=1 --".into()),
            ],
            100,
            false,
            30,
        )
        .unwrap();
    }
    let mut req = BrowseRequest {
        filter_groups: vec![],
        group_mode: "all".into(),
        connection_id: "test".into(),
        table: TableRef {
            schema: "".into(),
            name: "sample".into(),
            kind: "table".into(),
        },
        filters: vec![],
        sort: String::new(),
        descending: false,
        offset: 0,
        limit: 2,
    };
    let result = db.browse(&req).unwrap();
    assert_eq!(result.rows.len(), 2);
    assert!(result.truncated);
    req.filters = vec![Filter {
        column: "label".into(),
        operator: "eq".into(),
        value: Value::Text("missing' OR 1=1 --".into()),
    }];
    assert!(db.browse(&req).unwrap().rows.is_empty());
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn retention_and_event_clear() {
    let path = temp_path();
    let storage = Storage::open(&path).unwrap();
    for i in 0..5 {
        let event = Event {
            restore_source: None,
            id: i.to_string(),
            watch_id: "w".into(),
            connection_id: "c".into(),
            observed_at: chrono::Utc::now().to_rfc3339(),
            event_type: "recordChanged".into(),
            summary: "changed".into(),
            changes: vec![],
            before_state: None,
            after_state: None,
            record: None,
            capture: "metadata".into(),
        };
        storage.event(&event).unwrap();
    }
    storage.retain(30, 2, 100000).unwrap();
    assert_eq!(storage.events(None, 100).unwrap().len(), 2);
    storage.clear_events(Some("w".into())).unwrap();
    assert!(storage.events(None, 100).unwrap().is_empty());
    drop(storage);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn type_aware_values_and_pg_decoding() {
    assert_ne!(Value::Null, Value::Text("".into()));
    assert_ne!(Value::Integer("0".into()), Value::Text("0".into()));
    assert_eq!(
        postgres::decode(1700, "99999999999999999999.123456789".into()),
        Value::Decimal("99999999999999999999.123456789".into())
    );
    let mut key = BTreeMap::new();
    key.insert("a", Value::Integer("1".into()));
    key.insert("b", Value::Text("2".into()));
    assert_eq!(
        record_filters(&key.into_iter().map(|(k, v)| (k.into(), v)).collect()).len(),
        2
    );
}

#[test]
#[ignore = "Requires libpq and the disposable PostgreSQL fixture from docker compose up -d"]
fn postgres_live_fixture() {
    let mut config = config(String::new());
    config.driver = "postgres".into();
    config.host = "127.0.0.1".into();
    config.port = 55432;
    config.database = "kitsune_test".into();
    config.username = "kitsune_test".into();
    config.password = "kitsune_test".into();
    config.ssl_mode = "disable".into();
    config.create = false;
    let mut db = Database::open(&config, &temp_path(), false).unwrap();
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
        "Refusing to test a non-fixture database"
    );
    let table = TableRef {
        schema: "public".into(),
        name: "orders".into(),
        kind: "table".into(),
    };
    let metadata = db.metadata(&table).unwrap();
    assert!(metadata.columns.iter().any(|c| c.name == "id" && c.pk > 0));
    assert!(
        metadata
            .foreign_keys
            .iter()
            .any(|f| f.to.name == "customers")
    );
    let result = db
        .query(
            "SELECT total,metadata FROM public.orders WHERE id=$1",
            &[Value::Integer("5822".into())],
            100,
            true,
            5,
        )
        .unwrap();
    assert_eq!(
        result.rows[0][0],
        Value::Decimal("99999999999999999.123456789".into())
    );
    assert!(matches!(result.rows[0][1], Value::Json(_)));
    assert!(db.query("WITH removed AS (DELETE FROM public.orders WHERE id=5822 RETURNING *) SELECT * FROM removed",&[],100,true,5).is_err());
    let result = db
        .query(
            "SELECT receipt FROM public.payments WHERE receipt=$1",
            &[Value::Binary("AP+A".into())],
            100,
            true,
            5,
        )
        .unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0], Value::Binary("AP+A".into()));
    let composite = db
        .metadata(&TableRef {
            schema: "public".into(),
            name: "order_items".into(),
            kind: "table".into(),
        })
        .unwrap();
    assert_eq!(composite.columns.iter().filter(|c| c.pk > 0).count(), 2);
}

#[test]
fn eligible_unique_keys_and_metadata_refresh() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE unique_records(code TEXT NOT NULL UNIQUE,label TEXT)",
        &[],
        100,
        false,
        5,
    )
    .unwrap();
    db.query(
        "INSERT INTO unique_records VALUES('A','first')",
        &[],
        100,
        false,
        5,
    )
    .unwrap();
    let table = TableRef {
        schema: String::new(),
        name: "unique_records".into(),
        kind: "table".into(),
    };
    let metadata = db.metadata(&table).unwrap();
    assert_eq!(identity_columns(&metadata), vec!["code"]);
    let result = db
        .query("SELECT code,label FROM unique_records", &[], 100, true, 5)
        .unwrap();
    assert_eq!(
        record_key(&metadata, &result.rows[0], &result.columns).get("code"),
        Some(&Value::Text("A".into()))
    );
    assert!(record_key(&metadata, &[Value::Text("first".into())], &["label".into()]).is_empty());
    db.query(
        "CREATE TABLE partial_keys(code TEXT NOT NULL,active INTEGER)",
        &[],
        100,
        false,
        5,
    )
    .unwrap();
    db.query(
        "CREATE UNIQUE INDEX active_code ON partial_keys(code) WHERE active=1",
        &[],
        100,
        false,
        5,
    )
    .unwrap();
    let partial = db
        .metadata(&TableRef {
            schema: String::new(),
            name: "partial_keys".into(),
            kind: "table".into(),
        })
        .unwrap();
    assert!(identity_columns(&partial).is_empty());
    let initial = db.tables().unwrap().len();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute("CREATE TABLE later(id INTEGER PRIMARY KEY)", [])
        .unwrap();
    assert_eq!(db.tables().unwrap().len(), initial);
    db.refresh_metadata();
    assert_eq!(db.tables().unwrap().len(), initial + 1);
    drop(external);
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn sqlite_interrupt_leaves_connection_usable() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    let handle = db.interrupt().unwrap();
    let worker = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        handle.cancel();
    });
    let start = std::time::Instant::now();
    let result=db.query("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT SUM(x) FROM n",&[],1,true,5);
    assert!(result.is_err());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    worker.join().unwrap();
    assert_eq!(
        db.query("SELECT 1", &[], 1, true, 5).unwrap().rows[0][0],
        Value::Integer("1".into())
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn corrupted_metadata_is_preserved() {
    let path = temp_path();
    let bytes = b"not a sqlite database - preserve this evidence";
    std::fs::write(&path, bytes).unwrap();
    assert!(Storage::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn settings_are_typed_and_bounded() {
    let mut settings = ApplicationSettings::default();
    assert!(settings.validate().is_ok());
    settings.poll_interval = 0;
    assert!(settings.validate().is_err());
    assert!(
        serde_json::from_value::<ApplicationSettings>(serde_json::json!({"storageMiB":-1}))
            .is_err()
    );
}

#[test]
fn oversized_capture_downgrades_to_metadata_and_pages_are_bounded() {
    let path = temp_path();
    let storage = Storage::open(&path).unwrap();
    let event = Event {
        restore_source: None,
        id: "big".into(),
        watch_id: "w".into(),
        connection_id: "c".into(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        event_type: "recordChanged".into(),
        summary: "changed".into(),
        changes: vec![Change {
            column: "payload".into(),
            before: None,
            after: Some(Value::Text("private-payload".repeat(100000))),
        }],
        before_state: None,
        after_state: None,
        record: None,
        capture: "full".into(),
    };
    storage.event(&event).unwrap();
    let stored = storage.events(None, 100).unwrap();
    assert_eq!(stored[0].capture, "metadata");
    assert!(stored[0].changes[0].after.is_none());
    assert!(stored[0].summary.contains("1 MiB"));
    assert!(storage.event_page(None, 100, 1).unwrap().is_empty());
    drop(storage);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn invalid_utf8_text_preserves_original_bytes() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    let row = &db
        .query("SELECT CAST(x'ff80' AS TEXT),x'ff80'", &[], 1, true, 5)
        .unwrap()
        .rows[0];
    assert_eq!(
        row[0],
        Value::Unknown("Invalid UTF-8 text (base64): /4A=".into())
    );
    assert_eq!(row[1], Value::Binary("/4A=".into()));
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn sqlite_schema_nullability_distinguishes_legacy_and_rowid_primary_keys() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    for sql in [
        "CREATE TABLE legacy(a TEXT,b TEXT,PRIMARY KEY(a,b))",
        "CREATE TABLE rowid_alias(id INTEGER PRIMARY KEY)",
        "CREATE TABLE descending(id INTEGER PRIMARY KEY DESC)",
        "CREATE TABLE strict_pk(id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE no_rowid(a TEXT,b TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
    ] {
        db.query(sql, &[], 10, false, 5).unwrap();
    }
    for (name, nullable) in [
        ("legacy", true),
        ("rowid_alias", false),
        ("descending", true),
        ("strict_pk", false),
        ("no_rowid", false),
    ] {
        let metadata = db
            .metadata(&TableRef {
                schema: String::new(),
                name: name.into(),
                kind: "table".into(),
            })
            .unwrap();
        assert_eq!(metadata.columns[0].nullable, nullable, "{name}");
    }
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_editor_errors_explain_quoting_and_unbound_parameters() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE sprints(id TEXT PRIMARY KEY, name TEXT)",
        &[],
        100,
        false,
        30,
    )
    .unwrap();
    db.query(
        "INSERT INTO sprints VALUES(?1,?2)",
        &[
            Value::Text("1ffa67e4-c488-462e-b02e-75a87dae2147".into()),
            Value::Text("original".into()),
        ],
        100,
        false,
        30,
    )
    .unwrap();
    let error = db
        .query(
            "SELECT * FROM \"sprints\" WHERE \"id\" = ?1;",
            &[],
            100,
            true,
            30,
        )
        .unwrap_err();
    assert_eq!(error.code, "SQLITE_PARAMETERS");
    assert!(error.message.contains("expects 1"));
    let error = db.query("update \"sprints\" set 'sprints.name' = \"teste\" where id = \"1ffa67e4-c488-462e-b02e-75a87dae2147\";", &[], 100, false, 30).unwrap_err();
    assert_eq!(error.code, "SQLITE_COLUMN");
    assert!(error.message.contains("single quotes"));
    assert!(!error.message.contains("1ffa67e4"));
    assert!(!error.message.contains("teste"));
    let error = db
        .query("SELEC 'sensitive-value'", &[], 100, true, 30)
        .unwrap_err();
    assert_eq!(error.code, "SQLITE_SYNTAX");
    assert!(!error.message.contains("sensitive-value"));
    let result = db
        .query("SELECT name FROM sprints", &[], 100, true, 30)
        .unwrap();
    assert_eq!(result.rows[0][0], Value::Text("original".into()));
    let result = db.query("UPDATE \"sprints\" SET \"name\" = 'teste' WHERE \"id\" = '1ffa67e4-c488-462e-b02e-75a87dae2147'", &[], 100, false, 30).unwrap();
    assert_eq!(result.affected, 1);
    assert_eq!(
        db.query("SELECT name FROM sprints", &[], 100, true, 30)
            .unwrap()
            .rows[0][0],
        Value::Text("teste".into())
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn sqlite_error_categories_do_not_expose_native_messages() {
    for (native, code) in [
        (rusqlite::ffi::SQLITE_CANTOPEN, "SQLITE_OPEN"),
        (rusqlite::ffi::SQLITE_NOTADB, "SQLITE_FORMAT"),
        (rusqlite::ffi::SQLITE_BUSY, "SQLITE_BUSY"),
        (rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE, "SQLITE_CONSTRAINT"),
    ] {
        let error: Error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(native),
            Some("password=secret /private/database.db".into()),
        )
        .into();
        assert_eq!(error.code, code);
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("/private"));
        assert!(error.message.contains(&native.to_string()));
    }
}

#[test]
fn sqlite_cell_updates_enforce_foreign_keys_without_changing_source_pragmas() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
        &[],
        10,
        false,
        30,
    )
    .unwrap();
    db.query(
        "CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id))",
        &[],
        10,
        false,
        30,
    )
    .unwrap();
    db.query("INSERT INTO parent VALUES(1)", &[], 10, false, 30)
        .unwrap();
    db.query("INSERT INTO child VALUES(2,1)", &[], 10, false, 30)
        .unwrap();
    let record = RecordRef {
        connection_id: "test".into(),
        table: TableRef {
            schema: "".into(),
            name: "child".into(),
            kind: "table".into(),
        },
        key: BTreeMap::from([("id".into(), Value::Integer("2".into()))]),
    };
    let error = db
        .update_cell(
            &record,
            "parent_id",
            &Value::Integer("1".into()),
            &Value::Integer("99".into()),
        )
        .unwrap_err();
    assert_eq!(error.code, "SQLITE_CONSTRAINT");
    assert_eq!(
        db.query("SELECT parent_id FROM child", &[], 10, true, 30)
            .unwrap()
            .rows[0][0],
        Value::Integer("1".into())
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn grouped_filters_preserve_precedence_scope_and_literal_contains() {
    let path = temp_path();
    let mut db =
        Database::open(&config(path.to_string_lossy().into()), &temp_path(), false).unwrap();
    db.query(
        "CREATE TABLE sample(id INTEGER PRIMARY KEY, status TEXT, score INTEGER);",
        &[],
        100,
        false,
        5,
    )
    .unwrap();
    db.query("INSERT INTO sample VALUES(1,'pending',1),(2,'done',9),(3,'pending',9),(4,'100%_literal',9)",&[],100,false,5).unwrap();
    let mut req = BrowseRequest {
        connection_id: "test".into(),
        table: TableRef {
            schema: "".into(),
            name: "sample".into(),
            kind: "table".into(),
        },
        filters: vec![],
        filter_groups: vec![
            FilterGroup {
                mode: "any".into(),
                filters: vec![
                    Filter {
                        column: "status".into(),
                        operator: "eq".into(),
                        value: Value::Text("pending".into()),
                    },
                    Filter {
                        column: "score".into(),
                        operator: "lt".into(),
                        value: Value::Integer("2".into()),
                    },
                ],
            },
            FilterGroup {
                mode: "all".into(),
                filters: vec![Filter {
                    column: "score".into(),
                    operator: "gt".into(),
                    value: Value::Integer("5".into()),
                }],
            },
        ],
        group_mode: "all".into(),
        sort: "".into(),
        descending: false,
        offset: 0,
        limit: 100,
    };
    let ids = |r: ResultSet| {
        r.rows
            .iter()
            .map(|row| row[0].text().unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(db.browse(&req).unwrap()), vec!["3"]);
    req.group_mode = "any".into();
    req.filters = vec![Filter {
        column: "id".into(),
        operator: "lt".into(),
        value: Value::Integer("3".into()),
    }];
    assert_eq!(ids(db.browse(&req).unwrap()), vec!["1", "2"]);
    req.filters.clear();
    req.filter_groups = vec![FilterGroup {
        mode: "all".into(),
        filters: vec![Filter {
            column: "status".into(),
            operator: "contains".into(),
            value: Value::Text("%_".into()),
        }],
    }];
    assert_eq!(ids(db.browse(&req).unwrap()), vec!["4"]);
    req.filter_groups[0].filters[0].operator = "gt".into();
    req.filter_groups[0].filters[0].value = Value::Null;
    assert!(db.browse(&req).is_err());
    req.filter_groups[0].filters[0].column = "id\"; DROP TABLE sample;--".into();
    assert!(db.browse(&req).is_err());
    assert_eq!(
        db.query("SELECT count(*) FROM sample", &[], 1, true, 5)
            .unwrap()
            .rows[0][0]
            .text(),
        Some("4".into())
    );
    drop(db);
    let _ = std::fs::remove_file(path);
}
