use crate::{
    model::*,
    state::{AppState, OperationGuard, QueryOperation},
};
use serde_json::{Value as Json, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    connection_id: String,
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
    mode: String,
    operation_id: String,
}
pub fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>, payload: Json) -> Result<Json, Error> {
    let request: Request = serde_json::from_value(payload)
        .map_err(|_| Error::new("VALIDATION", "Invalid diagnostic request."))?;
    if !["estimate", "measure"].contains(&request.mode.as_str())
        || request.sql.len() > 1024 * 1024
        || request.operation_id.is_empty()
        || request.operation_id.len() > 100
    {
        return Err(Error::new(
            "VALIDATION",
            "Choose a single query and a valid diagnostic mode.",
        ));
    }
    let sql = crate::safety::validate_sql(&request.sql, true, false)?;
    if !["SELECT", "WITH", "VALUES"].contains(&crate::safety::first_word(&sql).as_str()) {
        return Err(Error::new(
            "DIAGNOSTIC_QUERY",
            "Diagnostics accept one SELECT, WITH or VALUES query. Scripts and writes are not supported.",
        ));
    }
    let state = app.state::<AppState>();
    let session = state.session(&request.connection_id)?;
    let _permit = state.permits.clone().try_acquire_owned().map_err(|_| {
        Error::new(
            "BUSY",
            "Database workers are busy. Try diagnostics again shortly.",
        )
    })?;
    let operation = Arc::new(QueryOperation {
        cancelled: AtomicBool::new(false),
        interrupt: Mutex::new(None),
    });
    {
        let mut operations = state
            .operations
            .lock()
            .map_err(|_| Error::new("STATE", "Operation state unavailable."))?;
        if operations.len() >= 100 || operations.contains_key(&request.operation_id) {
            return Err(Error::new(
                "OPERATION_LIMIT",
                "Operation identifier is already active.",
            ));
        }
        operations.insert(request.operation_id.clone(), operation.clone());
    }
    let _guard = OperationGuard {
        operations: &state.operations,
        id: request.operation_id.clone(),
    };
    let mut db = session
        .db
        .lock()
        .map_err(|_| Error::new("STATE", "Connection unavailable."))?;
    if operation.cancelled.load(Ordering::SeqCst) || !session.connected.load(Ordering::SeqCst) {
        return Err(Error::new(
            "CANCELLED",
            "Diagnostics cancelled before execution.",
        ));
    }
    *operation
        .interrupt
        .lock()
        .map_err(|_| Error::new("STATE", "Cancellation unavailable."))? = db.interrupt();
    let settings = state
        .storage
        .list::<ApplicationSettings>("settings")?
        .into_iter()
        .next()
        .unwrap_or_default();
    let started = std::time::Instant::now();
    if db.is_mssql() {
        let plan = db.mssql_explain(&sql, &request.params)?;
        let measured = if request.mode == "measure" {
            Some(db.query(
                &sql,
                &request.params,
                settings.row_limit.clamp(1, 100000) as usize,
                true,
                settings.query_timeout,
            )?)
        } else {
            None
        };
        return Ok(
            json!({"engine":"mssql","mode":request.mode,"plan":plan,"structuredPlan":null,"elapsedMs":started.elapsed().as_millis() as u64,"measurementMs":measured.as_ref().map(|r|r.duration_ms),"rowsConsumed":measured.as_ref().map(|r|r.rows.len()),"complete":measured.as_ref().map(|r|!r.truncated),"costUnit":null}),
        );
    }

    let pg = session.config.driver == "postgres";
    let mysql = session.config.driver == "mysql";
    if !pg {
        db.require_readonly(&sql)?;
    }
    let estimate = if pg {
        format!("EXPLAIN (FORMAT JSON) {sql}")
    } else if mysql {
        format!("EXPLAIN FORMAT=JSON {sql}")
    } else {
        format!("EXPLAIN QUERY PLAN {sql}")
    };
    let plan = db.query(
        &estimate,
        &request.params,
        1000,
        true,
        settings.query_timeout,
    )?;
    if plan.truncated {
        return Err(Error::new(
            "PLAN_LIMIT",
            "The plan exceeds the display limit.",
        ));
    }
    let json_plan = if pg || mysql {
        Some(
            serde_json::from_str::<Json>(
                &plan
                    .rows
                    .first()
                    .and_then(|r| r.first())
                    .and_then(Value::text)
                    .ok_or_else(|| {
                        Error::new("PLAN_FORMAT", "PostgreSQL did not return a plan.")
                    })?,
            )
            .map_err(|_| Error::new("PLAN_FORMAT", "PostgreSQL returned an unsupported plan."))?,
        )
    } else {
        None
    };
    fn modifies(value: &Json) -> bool {
        match value {
            Json::Object(m) => {
                m.get("Node Type").and_then(Json::as_str) == Some("ModifyTable")
                    || m.values().any(modifies)
            }
            Json::Array(a) => a.iter().any(modifies),
            _ => false,
        }
    }
    fn node_count(value: &Json) -> usize {
        match value {
            Json::Object(m) => {
                usize::from(m.contains_key("Node Type")) + m.values().map(node_count).sum::<usize>()
            }
            Json::Array(a) => a.iter().map(node_count).sum(),
            _ => 0,
        }
    }
    if json_plan.as_ref().is_some_and(|p| node_count(p) > 1000) {
        return Err(Error::new("PLAN_LIMIT", "The plan exceeds 1,000 nodes."));
    }
    if json_plan.as_ref().is_some_and(modifies) {
        return Err(Error::new(
            "DIAGNOSTIC_QUERY",
            "A modifying CTE cannot be measured through read-only diagnostics.",
        ));
    }
    if operation.cancelled.load(Ordering::SeqCst) {
        return Err(Error::new("CANCELLED", "Diagnostics were cancelled."));
    }
    let measured = if request.mode == "measure" {
        Some(db.query(
            &if pg {
                format!("EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT JSON) {sql}")
            } else {
                sql.clone()
            },
            &request.params,
            settings.row_limit.clamp(1, 100000) as usize,
            true,
            settings.query_timeout,
        )?)
    } else {
        None
    };
    let measured_plan = if pg {
        measured
            .as_ref()
            .and_then(|r| r.rows.first())
            .and_then(|r| r.first())
            .and_then(Value::text)
            .map(|s| serde_json::from_str::<Json>(&s))
            .transpose()
            .map_err(|_| Error::new("PLAN_FORMAT", "The measured plan could not be decoded."))?
    } else {
        None
    };
    if measured_plan.as_ref().is_some_and(|p| node_count(p) > 1000) {
        return Err(Error::new(
            "PLAN_LIMIT",
            "The measured plan exceeds 1,000 nodes.",
        ));
    }
    Ok(
        json!({"engine":if pg{"postgres"}else if mysql{"mysql"}else{"sqlite"},"mode":request.mode,"plan":plan,"structuredPlan":measured_plan.or(json_plan),"elapsedMs":started.elapsed().as_millis() as u64,"measurementMs":measured.as_ref().map(|r|r.duration_ms),"rowsConsumed":if pg{None}else{measured.as_ref().map(|r|r.rows.len())},"complete":measured.as_ref().map(|r|!r.truncated),"costUnit":if pg{Some("planner units")}else{None::<&str>}}),
    )
}
