use crate::{
    database::{Database, identity_columns, qualified},
    model::*,
    state::{AppState, Approval, OperationGuard, QueryOperation},
};
use serde_json::{Value as Json, json};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
#[derive(Clone)]
pub struct RestoreApproval {
    pub event_id: String,
    pub event_body: String,
}
struct Plan {
    sql: String,
    params: Vec<Value>,
    action: String,
    record: RecordRef,
    current: Vec<ObservedField>,
    proposed: Vec<ObservedField>,
    target: Option<Vec<ObservedField>>,
}
fn error(code: &str, message: &str) -> Error {
    Error::new(code, message)
}
fn bind(pg: bool, n: usize) -> String {
    format!("{}{n}", if pg { "$" } else { "?" })
}
fn safe_value(value: &Value) -> bool {
    match value {
        Value::Array(_) | Value::Unknown(_) => false,
        Value::Float(s) => s.parse::<f64>().is_ok_and(|n| n.is_finite()),
        _ => true,
    }
}
fn same(a: &Value, b: &Value) -> bool {
    a == b
}
fn fields_match(fields: &[ObservedField], row: &[Value], columns: &[String]) -> bool {
    fields.iter().all(|f| {
        columns
            .iter()
            .position(|n| n == &f.column)
            .is_some_and(|i| row.get(i).is_some_and(|v| same(&f.value, v)))
    })
}
fn read_record(
    db: &mut Database,
    record: &RecordRef,
    lock: bool,
    columns: &[String],
) -> Result<ResultSet, Error> {
    let locking = lock && (db.is_postgres() || db.is_mysql());
    let pg = db.is_postgres();
    let mut params = Vec::new();
    let mut parts = Vec::new();
    for (key, value) in &record.key {
        params.push(value.clone());
        parts.push(format!(
            "{} = {}",
            crate::safety::quote(key),
            bind(pg, params.len())
        ));
    }
    db.query(
        &format!(
            "SELECT {} FROM {} WHERE {} LIMIT 2{}",
            columns
                .iter()
                .map(|c| crate::safety::quote(c))
                .collect::<Vec<_>>()
                .join(","),
            qualified(&record.table),
            parts.join(" AND "),
            if locking { " FOR UPDATE" } else { "" }
        ),
        &params,
        2,
        true,
        5,
    )
}
fn plan(db: &mut Database, event: &Event, lock: bool) -> Result<Plan, Error> {
    if !["recordChanged", "recordAppeared", "recordDisappeared"]
        .contains(&event.event_type.as_str())
    {
        return Err(error(
            "RESTORE_SOURCE",
            "Result membership and watcher lifecycle events cannot be restored as database writes.",
        ));
    }
    if event.capture != "full" {
        return Err(error(
            "RESTORE_CAPTURE",
            "Only full-value observations can restore data. Metadata-only history has no saved values.",
        ));
    }
    let source=event.restore_source.as_ref().ok_or_else(||error("RESTORE_LEGACY","This older event has no restore provenance. New full-value observations will record it."))?;
    if !["record", "table"].contains(&source.watch_kind.as_str()) {
        return Err(error(
            "RESTORE_SOURCE",
            "Query projections cannot establish a restorable source record.",
        ));
    }
    let record = event.record.clone().ok_or_else(|| {
        error(
            "RESTORE_IDENTITY",
            "The event has no reliable, captured record identity.",
        )
    })?;
    db.refresh_metadata();
    let metadata = db.metadata(&record.table)?;
    if !db.tables()?.iter().any(|t| {
        t.schema == record.table.schema && t.name == record.table.name && t.kind == "table"
    }) {
        return Err(error("RESTORE_TABLE", "Restore requires a base table."));
    }
    let keys = identity_columns(&metadata);
    if keys.is_empty()
        || keys.len() != record.key.len()
        || keys.iter().any(|k| {
            record
                .key
                .get(k)
                .is_none_or(|v| matches!(v, Value::Null) || !safe_value(v))
        })
    {
        return Err(error(
            "RESTORE_IDENTITY",
            "The captured identity is no longer a complete unique key.",
        ));
    }
    if db.restore_schema(&record.table)? != source.schema_fingerprint {
        return Err(error(
            "RESTORE_SCHEMA",
            "The table schema changed since this observation. Restore is unavailable.",
        ));
    }
    db.restore_protection(&record.table)?;
    let before = event.before_state.as_deref();
    let after = event.after_state.as_deref();
    for fields in [before, after].into_iter().flatten() {
        let mut names = BTreeSet::new();
        for field in fields {
            if !names.insert(&field.column)
                || !metadata.columns.iter().any(|c| c.name == field.column)
                || !safe_value(&field.value)
            {
                return Err(error(
                    "RESTORE_VALUES",
                    "Captured values are incomplete, duplicated, or not safely round-trippable.",
                ));
            }
        }
    }
    let selected_columns: Vec<String> = event
        .before_state
        .iter()
        .flatten()
        .chain(event.after_state.iter().flatten())
        .map(|f| f.column.clone())
        .chain(record.key.keys().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let result = read_record(db, &record, lock, &selected_columns)?;
    if result.rows.len() > 1 {
        return Err(error(
            "RESTORE_IDENTITY",
            "The captured identity no longer selects one record.",
        ));
    }
    let row = result.rows.first();
    let complete = |fields: &[ObservedField]| {
        source.complete
            && fields.len() == metadata.columns.len()
            && metadata
                .columns
                .iter()
                .all(|c| fields.iter().any(|f| f.column == c.name))
    };
    let (generated, always_identity) = db.restore_generated(&record.table)?;
    let pg = db.is_postgres();
    let table = qualified(&record.table);
    let mut params = Vec::new();
    let mut predicates = Vec::new();
    for (key, value) in &record.key {
        params.push(value.clone());
        predicates.push(format!(
            "{} = {}",
            crate::safety::quote(key),
            bind(pg, params.len())
        ));
    }
    let captured: BTreeSet<_> = event
        .before_state
        .iter()
        .flatten()
        .chain(event.after_state.iter().flatten())
        .map(|f| f.column.as_str())
        .collect();
    let current = row
        .map(|row| {
            result
                .columns
                .iter()
                .cloned()
                .zip(row.iter().cloned())
                .filter(|(column, _)| captured.contains(column.as_str()))
                .map(|(column, value)| ObservedField { column, value })
                .collect()
        })
        .unwrap_or_default();
    let (action, sql, proposed, target) = match event.event_type.as_str() {
        "recordChanged" => {
            let (before, after) = (
                before.ok_or_else(|| {
                    error("RESTORE_CAPTURE", "Previous values were not captured.")
                })?,
                after.ok_or_else(|| error("RESTORE_CAPTURE", "Newer values were not captured."))?,
            );
            if before.len() != after.len()
                || before
                    .iter()
                    .any(|f| !after.iter().any(|a| a.column == f.column))
            {
                return Err(error(
                    "RESTORE_SCHEMA",
                    "Captured columns changed during observation.",
                ));
            }
            if row.is_none_or(|r| !fields_match(after, r, &result.columns)) {
                return Err(error(
                    "RESTORE_CONFLICT",
                    "The record changed after this observation or disappeared. No values will be overwritten.",
                ));
            }
            let changed: Vec<_> = before
                .iter()
                .filter(|f| {
                    !generated.contains(&f.column)
                        && after
                            .iter()
                            .any(|a| a.column == f.column && a.value != f.value)
                })
                .collect();
            if changed.is_empty()
                || changed
                    .iter()
                    .any(|f| keys.contains(&f.column) || generated.contains(&f.column))
            {
                return Err(error(
                    "RESTORE_IDENTITY",
                    "Identity or computed-field changes cannot be restored automatically.",
                ));
            }
            let mut assignments = Vec::new();
            for f in &changed {
                params.push(f.value.clone());
                assignments.push(format!(
                    "{} = {}",
                    crate::safety::quote(&f.column),
                    bind(pg, params.len())
                ));
            }
            for f in after {
                if matches!(f.value, Value::Null) {
                    predicates.push(format!("{} IS NULL", crate::safety::quote(&f.column)));
                } else {
                    params.push(f.value.clone());
                    let name = if db.is_mysql() && matches!(f.value, Value::Json(_)) {
                        format!(
                            "CAST({} AS CHAR CHARACTER SET utf8mb4)",
                            crate::safety::quote(&f.column)
                        )
                    } else if pg
                        && metadata
                            .columns
                            .iter()
                            .any(|c| c.name == f.column && c.data_type.eq_ignore_ascii_case("json"))
                    {
                        format!("{}::text", crate::safety::quote(&f.column))
                    } else {
                        crate::safety::quote(&f.column)
                    };
                    predicates.push(format!("{name} = {}", bind(pg, params.len())));
                }
            }
            (
                "update",
                format!(
                    "UPDATE {table} SET {} WHERE {}",
                    assignments.join(", "),
                    predicates.join(" AND ")
                ),
                before.to_vec(),
                Some(before.to_vec()),
            )
        }
        "recordAppeared" if source.watch_kind == "record" => {
            let after = after
                .ok_or_else(|| error("RESTORE_CAPTURE", "The appeared record was not captured."))?;
            if before.is_some() || !complete(after) {
                return Err(error(
                    "RESTORE_CAPTURE",
                    "Removing an appeared record requires a complete captured row.",
                ));
            }
            if row.is_none_or(|r| !fields_match(after, r, &result.columns)) {
                return Err(error(
                    "RESTORE_CONFLICT",
                    "The appeared record has changed or no longer exists.",
                ));
            }
            (
                "delete",
                format!("DELETE FROM {table} WHERE {}", predicates.join(" AND ")),
                vec![],
                None,
            )
        }
        "recordDisappeared" if source.watch_kind == "record" => {
            let before = before.ok_or_else(|| {
                error(
                    "RESTORE_CAPTURE",
                    "The disappeared record was not captured.",
                )
            })?;
            if after.is_some() || !complete(before) {
                return Err(error(
                    "RESTORE_CAPTURE",
                    "Recreating a record requires a complete captured row, including excluded fields.",
                ));
            }
            if row.is_some() {
                return Err(error(
                    "RESTORE_CONFLICT",
                    "A record with this identity already exists. It will not be overwritten.",
                ));
            }
            params.clear();
            let mut names = Vec::new();
            let mut placeholders = Vec::new();
            for f in before.iter().filter(|f| !generated.contains(&f.column)) {
                params.push(f.value.clone());
                names.push(crate::safety::quote(&f.column));
                placeholders.push(bind(pg, params.len()));
            }
            if names.is_empty() {
                return Err(error(
                    "RESTORE_VALUES",
                    "No restorable columns were captured.",
                ));
            }
            (
                "insert",
                format!(
                    "INSERT INTO {table} ({}) {}VALUES ({})",
                    names.join(", "),
                    if pg && always_identity {
                        "OVERRIDING SYSTEM VALUE "
                    } else {
                        ""
                    },
                    placeholders.join(", ")
                ),
                before.to_vec(),
                Some(before.to_vec()),
            )
        }
        _ => {
            return Err(error(
                "RESTORE_SOURCE",
                "Result membership and watcher lifecycle events cannot be reversed as database inserts or deletes.",
            ));
        }
    };
    Ok(Plan {
        sql,
        params,
        action: action.into(),
        record,
        current,
        proposed,
        target,
    })
}
pub fn handle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    method: &str,
    p: Json,
) -> Result<Json, Error> {
    let state = app.state::<AppState>();
    if method == "restore_receipt" {
        return Ok(state
            .storage
            .get::<Json>("restores", p["eventId"].as_str().unwrap_or(""))?
            .unwrap_or(Json::Null));
    }
    if method == "commit_restore" {
        let connection_id = p["connectionId"]
            .as_str()
            .ok_or_else(|| error("VALIDATION", "Select a connection."))?;
        let session = state.session(connection_id)?;
        let operation_id = p["operationId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 100)
            .ok_or_else(|| error("VALIDATION", "Missing restore operation identifier."))?;
        let operation = Arc::new(QueryOperation {
            cancelled: AtomicBool::new(false),
            interrupt: Mutex::new(None),
        });
        {
            let mut operations = state
                .operations
                .lock()
                .map_err(|_| error("STATE", "Operations unavailable."))?;
            if operations.len() >= 100 || operations.contains_key(operation_id) {
                return Err(error("OPERATION_LIMIT", "Restore is already running."));
            }
            operations.insert(operation_id.into(), operation.clone());
        }
        let _guard = OperationGuard {
            operations: &state.operations,
            id: operation_id.into(),
        };
        let _permit = state.permits.clone().try_acquire_owned().map_err(|_| {
            error(
                "BUSY",
                "Database workers are busy. Review the restore again shortly.",
            )
        })?;
        let _gate = state
            .watch_gate
            .lock()
            .map_err(|_| error("STATE", "Watch state unavailable."))?;
        let mut db = session
            .db
            .lock()
            .map_err(|_| error("STATE", "Connection unavailable."))?;
        if session.read_only.load(Ordering::SeqCst) || !session.connected.load(Ordering::SeqCst) {
            return Err(error(
                "READ_ONLY",
                "Enable session write access explicitly before restoring data.",
            ));
        }
        if operation.cancelled.load(Ordering::SeqCst) {
            return Err(error("CANCELLED", "Restore cancelled before execution."));
        }
        *operation
            .interrupt
            .lock()
            .map_err(|_| error("STATE", "Cancellation unavailable."))? = db.interrupt();
        let approval = state
            .approvals
            .lock()
            .map_err(|_| error("STATE", "Review unavailable."))?
            .remove(p["token"].as_str().unwrap_or(""))
            .filter(|a| {
                a.restore.is_some()
                    && a.connection_id == connection_id
                    && a.generation == session.generation
                    && a.created.elapsed().as_secs() < 120
            })
            .ok_or_else(|| {
                error(
                    "REVIEW_EXPIRED",
                    "Restore review expired or has already been used. Review the event again.",
                )
            })?;
        let source = approval
            .restore
            .ok_or_else(|| error("REVIEW_EXPIRED", "Invalid restore approval."))?;
        let event = state
            .storage
            .event_by_id(&source.event_id)?
            .ok_or_else(|| {
                error(
                    "EVENT_MISSING",
                    "The captured event was removed or expired.",
                )
            })?;
        if serde_json::to_string(&event).ok().as_deref() != Some(&source.event_body) {
            return Err(error(
                "RESTORE_SOURCE",
                "The captured event changed. Review it again.",
            ));
        }
        let outcome=db.write_transaction(|db|{
 db.restore_lock(&event.record.as_ref().ok_or_else(||error("RESTORE_IDENTITY","The event has no identity."))?.table)?;
 let restore=plan(db,&event,true)?;
 if restore.sql!=approval.sql||restore.params!=approval.params{return Err(error("REVIEW_EXPIRED","The restore plan changed. Review it again."));}
 if operation.cancelled.load(Ordering::SeqCst){return Err(error("CANCELLED","Restore cancelled before its write."));}
 db.query_checked(&restore.sql,&restore.params,1,false,30,Some(1))?;
 let columns:Vec<String> = restore.current.iter().chain(restore.proposed.iter()).map(|f|f.column.clone()).chain(restore.record.key.keys().cloned()).collect::<BTreeSet<_>>().into_iter().collect();
 let observed=read_record(db,&restore.record,true,&columns)?;
 let matches=if let Some(target)=&restore.target {observed.rows.len()==1&&fields_match(target,&observed.rows[0],&observed.columns)}else{observed.rows.is_empty()};
 if !matches{return Err(error("RESTORE_CONFLICT","The resulting row did not match the captured state. The restore was rolled back."));}
 if operation.cancelled.load(Ordering::SeqCst){return Err(error("CANCELLED","Restore cancelled and rolled back."));}
 Ok(restore.action)
 })?;
        let receipt = json!({"eventId":event.id,"connectionId":connection_id,"action":outcome,"restoredAt":chrono::Utc::now().to_rfc3339()});
        let warning=state.storage.put("restores",&event.id,&receipt).err().map(|_|"Restore committed, but its local receipt could not be saved. Do not repeat the write; verify the current record.");
        return Ok(json!({"success":true,"receipt":receipt,"warning":warning}));
    }
    let _gate = state
        .watch_gate
        .lock()
        .map_err(|_| error("STATE", "Watch state unavailable."))?;
    let event_id = p["eventId"]
        .as_str()
        .ok_or_else(|| error("VALIDATION", "Select a captured event."))?;
    let attempt = (|| {
        let event = state.storage.event_by_id(event_id)?.ok_or_else(|| {
            error(
                "EVENT_MISSING",
                "The captured event was removed or expired.",
            )
        })?;
        if state.storage.get::<Json>("restores", event_id)?.is_some() {
            return Err(error(
                "RESTORE_APPLIED",
                "This event already has a confirmed restore receipt.",
            ));
        }
        let session = state.session(&event.connection_id)?;
        if session.read_only.load(Ordering::SeqCst) {
            return Err(error(
                "READ_ONLY",
                "Enable session write access explicitly before restoring data.",
            ));
        }
        let mut db = session
            .db
            .lock()
            .map_err(|_| error("STATE", "Connection unavailable."))?;
        let restore = plan(&mut db, &event, false)?;
        let mut response = json!({"eligible":true,"action":restore.action,"record":restore.record,"current":restore.current,"proposed":restore.proposed,"sql":restore.sql,"params":restore.params,"observationTimestamp":event.observed_at});
        if method == "preview_restore" {
            let token = uuid::Uuid::new_v4().to_string();
            let mut approvals = state
                .approvals
                .lock()
                .map_err(|_| error("STATE", "Reviews unavailable."))?;
            approvals.retain(|_, a| a.created.elapsed().as_secs() < 120);
            if approvals.len() >= 100 {
                return Err(error("REVIEW_LIMIT", "Too many pending reviews."));
            }
            approvals.insert(
                token.clone(),
                Approval {
                    restore: Some(RestoreApproval {
                        event_id: event.id.clone(),
                        event_body: serde_json::to_string(&event)
                            .map_err(|_| error("SERIALIZATION", "Event cannot be reviewed."))?,
                    }),
                    expected_affected: Some(1),
                    sql: restore.sql,
                    params: restore.params,
                    connection_id: session.config.id.clone(),
                    generation: session.generation.clone(),
                    script: false,
                    created: std::time::Instant::now(),
                },
            );
            response["token"] = json!(token);
        }
        Ok(response)
    })();
    if method == "restore_eligibility" {
        match attempt {
            Ok(value) => Ok(value),
            Err(e) => Ok(json!({"eligible":false,"code":e.code,"reason":e.message})),
        }
    } else {
        attempt
    }
}
