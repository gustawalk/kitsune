use crate::{
    database::{record_filters, record_key},
    model::*,
    state::AppState,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
#[derive(Clone)]
pub struct Snapshot {
    pub source: Option<RestoreSource>,
    pub columns: Vec<String>,
    pub records: BTreeMap<String, (Vec<Value>, Option<RecordRef>)>,
}
pub fn sensitive_column(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["password", "secret", "token", "private_key", "ssn"]
        .iter()
        .any(|pattern| name.contains(pattern))
}
pub fn snapshot(
    watch: &Watch,
    result: ResultSet,
    metadata: Option<&Metadata>,
) -> Result<Snapshot, Error> {
    if result.truncated || result.rows.len() > 1000 {
        return Err(Error::new(
            "WATCH_SCOPE",
            "Observation exceeds 1,000 rows. Narrow the scope; no differences were recorded.",
        ));
    }
    let size = serde_json::to_vec(&result.rows)
        .map_err(|_| Error::new("SERIALIZATION", "Observation could not be encoded."))?
        .len();
    if size > 5 * 1024 * 1024 {
        return Err(Error::new(
            "WATCH_SCOPE",
            "Observation exceeds 5 MiB. Exclude large columns or narrow the scope.",
        ));
    }
    let included: Vec<usize> = result
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            !sensitive_column(c)
                && !watch
                    .excluded_columns
                    .iter()
                    .any(|x| x.eq_ignore_ascii_case(c))
        })
        .map(|(i, _)| i)
        .collect();
    let mut labels = std::collections::BTreeSet::new();
    let columns: Vec<String> = included
        .iter()
        .map(|i| {
            let name = &result.columns[*i];
            let mut label = if result.columns.iter().filter(|c| *c == name).count() > 1 {
                format!("{name} [column {}]", i + 1)
            } else {
                name.clone()
            };
            while !labels.insert(label.clone()) {
                label.push('_');
            }
            label
        })
        .collect();
    let mut records = BTreeMap::new();
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for row in &result.rows {
        let key = metadata
            .map(|m| record_key(m, row, &result.columns))
            .unwrap_or_default();
        if metadata.is_some() && key.is_empty() {
            return Err(Error::new(
                "WATCH_IDENTITY",
                "The query result is missing a complete, non-null unique key. Include all key columns or choose no identity table.",
            ));
        }
        let values = included.iter().map(|i| row[*i].clone()).collect::<Vec<_>>();
        let identity = if key.is_empty() {
            serde_json::to_string(&values)
        } else {
            serde_json::to_string(&key)
        }
        .map_err(|_| Error::new("SERIALIZATION", "Cannot identify observation."))?;
        let number = counts.entry(identity.clone()).or_default();
        *number += 1;
        if !key.is_empty() && *number > 1 {
            return Err(Error::new(
                "WATCH_IDENTITY",
                "Configured primary key is not unique in this query result. Remove the identity table or narrow the query.",
            ));
        }
        let record = if key.is_empty()
            || key.keys().any(|k| {
                sensitive_column(k)
                    || watch
                        .excluded_columns
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(k))
            }) {
            None
        } else {
            watch.table.as_ref().map(|table| RecordRef {
                connection_id: watch.connection_id.clone(),
                table: table.clone(),
                key,
            })
        };
        records.insert(format!("{identity}#{number}"), (values, record));
    }
    Ok(Snapshot {
        columns,
        records,
        source: None,
    })
}
pub fn differences(watch: &Watch, before: &Snapshot, after: &Snapshot) -> Vec<Event> {
    let ids = before
        .records
        .keys()
        .chain(after.records.keys())
        .collect::<BTreeSet<_>>();
    let mut events = vec![];
    for id in ids {
        let old = before.records.get(id);
        let new = after.records.get(id);
        if old.map(|r| &r.0) == new.map(|r| &r.0) && before.columns == after.columns {
            continue;
        }
        let record = new.or(old).and_then(|r| r.1.clone());
        let event_type = match (old, new) {
            (None, _) => {
                if watch.kind == "record" {
                    "recordAppeared"
                } else {
                    "resultEntered"
                }
            }
            (_, None) => {
                if watch.kind == "record" {
                    "recordDisappeared"
                } else {
                    "resultLeft"
                }
            }
            _ => "recordChanged",
        };
        let names = before
            .columns
            .iter()
            .chain(after.columns.iter())
            .collect::<BTreeSet<_>>();
        let mut changes = vec![];
        for name in names {
            let a = before
                .columns
                .iter()
                .position(|c| c == name)
                .and_then(|i| old.and_then(|r| r.0.get(i)));
            let b = after
                .columns
                .iter()
                .position(|c| c == name)
                .and_then(|i| new.and_then(|r| r.0.get(i)));
            if a != b {
                changes.push(Change {
                    column: name.clone(),
                    before: if watch.capture == "full" {
                        a.cloned()
                    } else {
                        None
                    },
                    after: if watch.capture == "full" {
                        b.cloned()
                    } else {
                        None
                    },
                });
            }
        }
        events.push(Event {
            restore_source: if watch.capture == "full" && before.source == after.source {
                after.source.clone()
            } else {
                None
            },
            id: uuid::Uuid::new_v4().to_string(),
            watch_id: watch.id.clone(),
            connection_id: watch.connection_id.clone(),
            observed_at: chrono::Utc::now().to_rfc3339(),
            event_type: event_type.into(),
            summary: match event_type {
                "recordAppeared" => "Record appeared since the previous observation.".into(),
                "recordDisappeared" => "Record disappeared since the previous observation.".into(),
                "resultEntered" => {
                    "Row entered the watched result; no previous matching row.".into()
                }
                "resultLeft" => "Row left the watched result; no newer matching row.".into(),
                _ => format!(
                    "{} field{} observed changing",
                    changes.len(),
                    if changes.len() == 1 { "" } else { "s" }
                ),
            },
            before_state: if watch.capture == "full" {
                old.map(|row| {
                    before
                        .columns
                        .iter()
                        .cloned()
                        .zip(row.0.iter().cloned())
                        .map(|(column, value)| ObservedField { column, value })
                        .collect()
                })
            } else {
                None
            },
            after_state: if watch.capture == "full" {
                new.map(|row| {
                    after
                        .columns
                        .iter()
                        .cloned()
                        .zip(row.0.iter().cloned())
                        .map(|(column, value)| ObservedField { column, value })
                        .collect()
                })
            } else {
                None
            },
            changes,
            record: if watch.capture == "full" {
                record
            } else {
                None
            },
            capture: watch.capture.clone(),
        });
    }
    events
}
pub fn lifecycle(w: &Watch, kind: &str, summary: &str) -> Event {
    Event {
        restore_source: None,
        id: uuid::Uuid::new_v4().to_string(),
        watch_id: w.id.clone(),
        connection_id: w.connection_id.clone(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        event_type: kind.into(),
        summary: summary.into(),
        changes: vec![],
        before_state: None,
        after_state: None,
        record: None,
        capture: w.capture.clone(),
    }
}
async fn expires(deadline: Option<tokio::time::Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await
    } else {
        std::future::pending::<()>().await
    }
}
pub async fn run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    mut watch: Watch,
    stop: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
    interrupt: Arc<std::sync::Mutex<Option<Arc<crate::database::Interrupt>>>>,
) {
    let state = app.state::<AppState>();
    let mut baseline = None;
    let mut failures = 0u32;
    let deadline = watch
        .duration_seconds
        .map(|seconds| tokio::time::Instant::now() + Duration::from_secs(seconds));
    let mut expired = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let session = match state.session(&watch.connection_id) {
            Ok(s) => s,
            Err(_) => break,
        };
        let connection_permit = tokio::select! {p=session.monitor_permit.clone().acquire_owned()=>match p{Ok(p)=>p,Err(_)=>break},_=wake.notified()=>break,_=expires(deadline)=>{expired=true;break}};
        let permit = tokio::select! {p=state.permits.clone().acquire_owned()=>match p{Ok(p)=>p,Err(_)=>break},_=wake.notified()=>break,_=expires(deadline)=>{expired=true;break}};
        let config = watch.clone();
        let operation_interrupt = interrupt.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let mut db = match session.monitor.try_lock() {
                Ok(db) => db,
                Err(_) => {
                    return Err(Error::new(
                        "WATCH_BUSY",
                        "Another watch is observing this connection.",
                    ));
                }
            };
            if !session.connected.load(Ordering::SeqCst) {
                return Err(Error::new("NOT_CONNECTED", "Connection closed."));
            }
            if let Ok(mut handle) = operation_interrupt.lock() {
                *handle = db.interrupt();
            }
            let metadata = config.table.as_ref().map(|t| db.metadata(t)).transpose()?;
            let result = if config.kind == "query" {
                let sql = crate::safety::validate_sql(&config.sql, true, false)?;
                db.query(&sql, &[], 1001, true, 5)?
            } else {
                let table = config
                    .table
                    .clone()
                    .ok_or_else(|| Error::new("VALIDATION", "Watch table is missing."))?;
                let filters = if config.kind == "record" {
                    record_filters(&config.key)
                } else {
                    config.filters.clone()
                };
                db.browse_with_timeout(
                    &BrowseRequest {
                        filter_groups: config.filter_groups.clone(),
                        group_mode: config.group_mode.clone(),
                        connection_id: config.connection_id.clone(),
                        table,
                        filters,
                        sort: String::new(),
                        descending: false,
                        offset: 0,
                        keyset: false,
                        cursor: None,
                        limit: 1000,
                    },
                    5,
                )?
            };
            let mut observation = snapshot(&config, result, metadata.as_ref())?;
            if config.capture == "full"
                && let Some(metadata) = &metadata
                && (config.kind != "query"
                    || restorable_query(&config.sql, metadata, &session.config.driver))
            {
                observation.source = Some(RestoreSource {
                    watch_kind: config.kind.clone(),
                    schema_fingerprint: db.restore_schema(&metadata.table)?,
                    complete: config.kind != "query"
                        && metadata
                            .columns
                            .iter()
                            .all(|c| observation.columns.contains(&c.name)),
                });
            }
            Ok(observation)
        });
        let observation = tokio::select! {result=&mut worker=>result,_=expires(deadline)=>{expired=true;if let Ok(handle)=interrupt.lock()&&let Some(handle)=handle.as_ref(){handle.cancel();}worker.await}};
        if let Ok(mut handle) = interrupt.lock() {
            *handle = None;
        }
        drop(permit);
        drop(connection_permit);
        if stop.load(Ordering::SeqCst) || expired {
            break;
        }
        let result = observation
            .unwrap_or_else(|_| Err(Error::new("WATCH_FAILED", "Observation task failed.")));
        let mut events = vec![];
        match result {
            Ok(current) => {
                if failures > 0 {
                    events.push(lifecycle(
                        &watch,
                        "observationRecovered",
                        "Observation recovered; comparison starts from a fresh baseline.",
                    ));
                    baseline = None;
                }
                if let Some(previous) = &baseline {
                    events.extend(differences(&watch, previous, &current));
                } else {
                    events.push(lifecycle(
                        &watch,
                        "baselineCaptured",
                        &format!("Baseline ready: {} row(s). Future observations will be compared with this state. No earlier values are available.", current.records.len()),
                    ));
                }
                baseline = Some(current);
                failures = 0;
                watch.last_error = None;
                watch.last_observed = Some(chrono::Utc::now().to_rfc3339());
                watch.status = "running".into();
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                watch.status = "error".into();
                watch.last_error = Some(error.message.clone());
                if failures == 1 {
                    events.push(lifecycle(&watch, "observationFailed", &error.message));
                }
            }
        }
        let _gate = match state.watch_gate.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut storage_failed = false;
        for event in events {
            if state.storage.event(&event).is_ok() {
                watch.event_count += 1;
                let _=app.emit("watch-event",serde_json::json!({"watchId":watch.id,"id":event.id,"notify":watch.notifications && !event.changes.is_empty()}));
            } else {
                storage_failed = true;
                break;
            }
        }
        if storage_failed {
            watch.status = "error".into();
            watch.last_error=Some("Local history could not be saved. Monitoring stopped to avoid losing observations.".into());
            if let Ok(mut errors) = state.watch_errors.lock() {
                errors.insert(
                    watch.id.clone(),
                    watch.last_error.clone().unwrap_or_default(),
                );
            }
            let _ = state.storage.put("watches", &watch.id, &watch);
            break;
        }
        // Do not let a finished observation resurrect a watch paused/deleted during I/O.
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if state.storage.put("watches", &watch.id, &watch).is_err() {
            if let Ok(mut errors) = state.watch_errors.lock() {
                errors.insert(
                    watch.id.clone(),
                    "Local watch state could not be saved. Monitoring stopped.".into(),
                );
            }
            break;
        }
        let settings = state
            .storage
            .list::<ApplicationSettings>("settings")
            .ok()
            .and_then(|v| v.into_iter().next())
            .unwrap_or_default();
        let days = settings.retention_days;
        let count = settings.max_events;
        let bytes = settings.storage_mi_b * 1024 * 1024;
        if state.storage.retain(days, count, bytes).is_err() {
            if let Ok(mut errors) = state.watch_errors.lock() {
                errors.insert(
                    watch.id.clone(),
                    "History cleanup failed. Monitoring stopped to preserve storage limits.".into(),
                );
            }
            break;
        }
        drop(_gate);
        let delay = watch
            .interval_seconds
            .saturating_mul(1u64 << failures.min(6))
            .min(300);
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(delay))=>{},_=wake.notified()=>break,_=expires(deadline)=>{expired=true;break}};
    }
    if expired {
        let _gate = state.watch_gate.lock();
        let removed_current_task = !stop.load(Ordering::SeqCst)
            && state.tasks.lock().is_ok_and(|mut tasks| {
                let owns_task = tasks
                    .get(&watch.id)
                    .is_some_and(|task| Arc::ptr_eq(&task.stop, &stop));
                if owns_task {
                    tasks.remove(&watch.id);
                }
                owns_task
            });
        if removed_current_task {
            watch.status = "stopped".into();
            watch.last_error = None;
            // Publish terminal status only after task cleanup and the lifecycle event.
            // Readers can observe storage without taking watch_gate.
            let _ = state.storage.event(&lifecycle(
                &watch,
                "watchStopped",
                "Timed watch completed. Changes after this point are not observed.",
            ));
            let _ = state.storage.put("watches", &watch.id, &watch);
            let _ = app.emit("watch-status", &watch.id);
        }
    }
    if let Ok(mut tasks) = state.tasks.lock()
        && tasks
            .get(&watch.id)
            .is_some_and(|task| Arc::ptr_eq(&task.stop, &stop))
    {
        tasks.remove(&watch.id);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn watch() -> Watch {
        Watch {
            filter_groups: vec![],
            group_mode: "all".into(),
            group_name: String::new(),
            duration_seconds: None,
            started_at: None,
            deadline_at: None,
            id: "w".into(),
            name: "Orders".into(),
            connection_id: "c".into(),
            kind: "query".into(),
            table: None,
            key: BTreeMap::new(),
            filters: vec![],
            sql: "select 1".into(),
            interval_seconds: 5,
            capture: "full".into(),
            production_capture_authorized: false,
            excluded_columns: vec![],
            notifications: false,
            status: "paused".into(),
            last_observed: None,
            last_error: None,
            event_count: 0,
        }
    }
    fn result(rows: Vec<Vec<Value>>) -> ResultSet {
        ResultSet {
            columns: vec!["n".into()],
            rows,
            ..ResultSet::empty()
        }
    }
    #[test]
    fn reordered_multisets_have_no_events() {
        let w = watch();
        let a = snapshot(
            &w,
            result(vec![
                vec![Value::Integer("1".into())],
                vec![Value::Integer("2".into())],
            ]),
            None,
        )
        .unwrap();
        let b = snapshot(
            &w,
            result(vec![
                vec![Value::Integer("2".into())],
                vec![Value::Integer("1".into())],
            ]),
            None,
        )
        .unwrap();
        assert!(differences(&w, &a, &b).is_empty());
    }
    #[test]
    fn duplicates_and_types_are_significant() {
        let w = watch();
        let a = snapshot(
            &w,
            result(vec![
                vec![Value::Integer("1".into())],
                vec![Value::Integer("1".into())],
            ]),
            None,
        )
        .unwrap();
        let b = snapshot(&w, result(vec![vec![Value::Text("1".into())]]), None).unwrap();
        assert_eq!(differences(&w, &a, &b).len(), 3);
    }
    #[test]
    fn metadata_capture_never_contains_values() {
        let mut w = watch();
        w.capture = "metadata".into();
        let a = snapshot(&w, result(vec![]), None).unwrap();
        let b = snapshot(&w, result(vec![vec![Value::Text("secret".into())]]), None).unwrap();
        let e = differences(&w, &a, &b);
        assert!(!serde_json::to_string(&e).unwrap().contains("secret"));
    }
    #[test]
    fn excluded_columns_do_not_generate_changes() {
        let mut w = watch();
        w.excluded_columns = vec!["n".into()];
        let a = snapshot(&w, result(vec![vec![Value::Text("before".into())]]), None).unwrap();
        let b = snapshot(&w, result(vec![vec![Value::Text("after".into())]]), None).unwrap();
        assert!(differences(&w, &a, &b).is_empty());
    }
    #[test]
    fn configured_query_identity_requires_all_composite_key_columns() {
        let mut watch = watch();
        let table = TableRef {
            schema: "".into(),
            name: "records".into(),
            kind: "table".into(),
        };
        watch.table = Some(table.clone());
        let metadata = Metadata {
            table,
            columns: vec![
                Column {
                    name: "n".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    default_value: None,
                    pk: 1,
                    enum_type: None,
                },
                Column {
                    name: "part".into(),
                    data_type: "TEXT".into(),
                    nullable: false,
                    default_value: None,
                    pk: 2,
                    enum_type: None,
                },
            ],
            foreign_keys: vec![],
            indexes: vec![],
            enums: vec![],
        };
        let missing = result(vec![vec![Value::Integer("1".into())]]);
        match snapshot(&watch, missing, Some(&metadata)) {
            Err(error) => assert_eq!(error.code, "WATCH_IDENTITY"),
            Ok(_) => panic!("Missing composite key must not fall back to membership"),
        };
        let complete = ResultSet {
            columns: vec!["n".into(), "part".into()],
            rows: vec![vec![Value::Integer("1".into()), Value::Text("a".into())]],
            ..ResultSet::empty()
        };
        assert_eq!(
            snapshot(&watch, complete, Some(&metadata))
                .unwrap()
                .records
                .len(),
            1
        );
    }
    #[test]
    fn overflow_is_not_a_deletion() {
        let w = watch();
        let mut r = result(vec![]);
        r.truncated = true;
        assert!(snapshot(&w, r, None).is_err());
    }
}

#[cfg(test)]
mod capture_regressions {
    use super::*;
    fn watch() -> Watch {
        Watch {
            filter_groups: vec![],
            group_mode: "all".into(),
            group_name: String::new(),
            duration_seconds: None,
            started_at: None,
            deadline_at: None,
            id: "w".into(),
            name: "test".into(),
            connection_id: "c".into(),
            kind: "query".into(),
            table: None,
            key: BTreeMap::new(),
            filters: vec![],
            sql: "select 1".into(),
            interval_seconds: 2,
            capture: "full".into(),
            production_capture_authorized: false,
            excluded_columns: vec![],
            notifications: false,
            status: "paused".into(),
            last_observed: None,
            last_error: None,
            event_count: 0,
        }
    }
    #[test]
    fn query_capture_excludes_secret_patterns_and_keeps_duplicate_names() {
        let w = watch();
        let result = ResultSet {
            columns: vec!["id".into(), "id".into(), "api_token".into()],
            rows: vec![vec![
                Value::Integer("1".into()),
                Value::Integer("2".into()),
                Value::Text("never-save-this".into()),
            ]],
            ..ResultSet::empty()
        };
        let after = snapshot(&w, result, None).unwrap();
        let before = snapshot(&w, ResultSet::empty(), None).unwrap();
        let events = differences(&w, &before, &after);
        let text = serde_json::to_string(&events).unwrap();
        assert!(!text.contains("never-save-this"));
        assert!(!text.contains("api_token"));
        assert_eq!(events[0].after_state.as_ref().unwrap().len(), 2);
        assert_ne!(
            events[0].after_state.as_ref().unwrap()[0].column,
            events[0].after_state.as_ref().unwrap()[1].column
        );
    }
}

/// Only direct, schema-qualified base-table columns may become write-back history.
/// Query membership still never proves a database insert/delete.
fn restorable_query(sql: &str, metadata: &Metadata, driver: &str) -> bool {
    use sqlparser::{
        ast::{Expr, GroupByExpr, SelectItem, SetExpr, Statement, TableFactor},
        dialect::{
            Dialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
        },
        parser::Parser,
    };
    let dialect: Box<dyn Dialect> = match driver {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" => Box::new(MySqlDialect {}),
        "mssql" => Box::new(MsSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => Box::new(GenericDialect {}),
    };
    let Ok(statements) = Parser::parse_sql(dialect.as_ref(), sql) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return false;
    };
    if query.with.is_some()
        || query.for_clause.is_some()
        || query.format_clause.is_some()
        || query.settings.is_some()
        || !query.pipe_operators.is_empty()
        || select.from.len() != 1
        || !select.from[0].joins.is_empty()
        || select.distinct.is_some()
        || select.into.is_some()
        || !select.lateral_views.is_empty()
        || select.having.is_some()
        || select.qualify.is_some()
        || select.value_table_mode.is_some()
        || select.connect_by.is_some()
        || select.exclude.is_some()
        || !matches!(&select.group_by, GroupByExpr::Expressions(v,m) if v.is_empty() && m.is_empty())
    {
        return false;
    }
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        with_ordinality,
        partitions,
        json_path,
        sample,
        ..
    } = &select.from[0].relation
    else {
        return false;
    };
    if args.is_some()
        || !with_hints.is_empty()
        || version.is_some()
        || *with_ordinality
        || !partitions.is_empty()
        || json_path.is_some()
        || sample.is_some()
        || alias.as_ref().is_some_and(|a| !a.columns.is_empty())
    {
        return false;
    }
    let parts: Option<Vec<_>> = name
        .0
        .iter()
        .map(|p| p.as_ident().map(|i| i.value.as_str()))
        .collect();
    let expected: Vec<_> = [metadata.table.schema.as_str(), metadata.table.name.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    if parts.as_deref() != Some(expected.as_slice()) {
        return false;
    }
    select.projection.iter().all(|p| match p {
        SelectItem::Wildcard(options) => *options == Default::default(),
        SelectItem::UnnamedExpr(Expr::Identifier(i)) => {
            metadata.columns.iter().any(|c| c.name == i.value)
        }
        SelectItem::UnnamedExpr(Expr::CompoundIdentifier(parts)) => parts
            .last()
            .is_some_and(|i| metadata.columns.iter().any(|c| c.name == i.value)),
        _ => false,
    })
}

#[cfg(test)]
mod query_restore_tests {
    use super::*;
    #[test]
    fn only_direct_base_table_projections_are_restorable() {
        let metadata:Metadata=serde_json::from_value(serde_json::json!({"table":{"schema":"public","name":"boards","kind":"table"},"columns":[{"name":"id","dataType":"integer","nullable":false,"defaultValue":null,"pk":1},{"name":"title","dataType":"text","nullable":false,"defaultValue":null,"pk":0}],"indexes":[],"foreignKeys":[],"enums":[]})).unwrap();
        for sql in [
            "SELECT * FROM public.boards",
            "SELECT * FROM \"public\".\"boards\"",
            "SELECT id,title FROM public.boards WHERE id=1",
            "SELECT b.id,b.title FROM public.boards b ORDER BY b.id",
        ] {
            assert!(restorable_query(sql, &metadata, "postgres"), "{sql}");
        }
        assert!(restorable_query(
            "SELECT * FROM `public`.`boards`",
            &metadata,
            "mysql"
        ));
        assert!(restorable_query(
            "SELECT * FROM [public].[boards]",
            &metadata,
            "mssql"
        ));
        for sql in [
            "SELECT * FROM boards",
            "SELECT * FROM public.other",
            "SELECT id,upper(title) AS title FROM public.boards",
            "SELECT id,title AS renamed FROM public.boards",
            "SELECT b.* FROM public.boards b JOIN public.other x ON b.id=x.id",
            "SELECT id,count(*) FROM public.boards GROUP BY id",
            "WITH b AS(SELECT * FROM public.boards) SELECT * FROM b",
            "SELECT * FROM public.boards UNION SELECT * FROM public.boards",
            "SELECT missing FROM public.boards",
            "SELECT * FROM public.boards FOR JSON AUTO",
        ] {
            assert!(!restorable_query(sql, &metadata, "postgres"), "{sql}");
        }
    }
}
