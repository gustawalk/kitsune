use crate::{
    database::Database,
    model::*,
    monitor::sensitive_column,
    state::{AppState, OperationGuard, QueryOperation},
};
use serde_json::{Value as Json, json};
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportRequest {
    pub request: BrowseRequest,
    pub columns: Vec<String>,
    pub format: String,
    pub max_rows: u32,
    #[serde(default)]
    pub spreadsheet_safe: bool,
    #[serde(default)]
    pub allow_sensitive: bool,
    pub operation_id: String,
}
fn io_error(_: std::io::Error) -> Error {
    Error::new(
        "EXPORT_IO",
        "Could not write the export. Check folder permissions and available storage.",
    )
}
struct Output<'a, W: Write> {
    writer: &'a mut W,
    bytes: usize,
}
impl<W: Write> Output<'_, W> {
    fn put(&mut self, data: &[u8]) -> Result<(), Error> {
        self.bytes += data.len();
        if self.bytes > 100 * 1024 * 1024 {
            return Err(Error::new(
                "EXPORT_LIMIT",
                "Export exceeds 100 MiB. Choose a smaller scope or fewer columns.",
            ));
        }
        self.writer.write_all(data).map_err(io_error)
    }
}
fn csv(value: Option<&Value>, safe: bool) -> String {
    let Some(value) = value else {
        return "\\N".into();
    };
    if matches!(value, Value::Null) {
        return "\\N".into();
    }
    let mut text = value.text().unwrap_or_default();
    if safe
        && matches!(value, Value::Text(_))
        && text.trim_start().starts_with(['=', '+', '-', '@'])
    {
        text.insert(0, '\'');
    }
    format!("\"{}\"", text.replace('"', "\"\""))
}
pub(crate) fn write_export<W: Write>(
    db: &mut Database,
    request: &ExportRequest,
    writer: &mut W,
    cancelled: &AtomicBool,
    timeout: u64,
) -> Result<(u32, bool), Error> {
    if !["csv", "json"].contains(&request.format.as_str())
        || request.max_rows == 0
        || request.max_rows > 10000
        || request.columns.is_empty()
        || request.columns.len() > 10000
    {
        return Err(Error::new(
            "EXPORT_LIMIT",
            "Choose CSV or typed JSON, at least one column, and a limit of 1–10,000 rows.",
        ));
    }
    let metadata = db.metadata(&request.request.table)?;
    let mut seen = std::collections::BTreeSet::new();
    for column in &request.columns {
        if !metadata.columns.iter().any(|c| &c.name == column) || !seen.insert(column) {
            return Err(Error::new(
                "VALIDATION",
                "Export columns are missing or duplicated.",
            ));
        }
        if sensitive_column(column) && !request.allow_sensitive {
            return Err(Error::new(
                "EXPORT_SENSITIVE",
                "Explicitly authorize sensitive-column export first.",
            ));
        }
    }
    let started = Instant::now();
    let mut output = Output { writer, bytes: 0 };
    let mut exported = 0u32;
    let mut more = false;
    let json = request.format == "json";
    if json {
        output.put(b"{\"format\":\"kitsune-typed-json-v1\",\"columns\":")?;
        output
            .put(&serde_json::to_vec(&request.columns).map_err(|_| {
                Error::new("SERIALIZATION", "Export headers could not be encoded.")
            })?)?;
        output.put(b",\"rows\":[")?;
    } else {
        output.put(
            request
                .columns
                .iter()
                .map(|c| csv(Some(&Value::Text(c.clone())), false))
                .collect::<Vec<_>>()
                .join(",")
                .as_bytes(),
        )?;
        output.put(b"\r\n")?;
    }
    db.read_transaction(|db| {
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::new(
                    "CANCELLED",
                    "Export cancelled; no destination file was created.",
                ));
            }
            if started.elapsed().as_secs() >= timeout {
                return Err(Error::new(
                    "EXPORT_TIMEOUT",
                    "Export reached its time limit. Narrow the scope.",
                ));
            }
            let mut page = request.request.clone();
            page.offset = page.offset.checked_add(exported).ok_or_else(|| {
                Error::new("EXPORT_LIMIT", "Export offset exceeds the supported range.")
            })?;
            page.limit = (request.max_rows - exported).min(500);
            let (sql, params, _) = db.browse_statement(&page)?;
            let selection = request
                .columns
                .iter()
                .map(|c| crate::safety::quote(c))
                .collect::<Vec<_>>()
                .join(",");
            let result = db.query(
                &sql.replacen("SELECT *", &format!("SELECT {selection}"), 1),
                &params,
                (page.limit + 1) as usize,
                true,
                timeout.saturating_sub(started.elapsed().as_secs()).max(1),
            )?;
            let count = result.rows.len().min(page.limit as usize);
            for row in result.rows.iter().take(count) {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(Error::new(
                        "CANCELLED",
                        "Export cancelled; no destination file was created.",
                    ));
                }
                if json {
                    if exported > 0 {
                        output.put(b",")?;
                    }
                    output.put(&serde_json::to_vec(row).map_err(|_| {
                        Error::new("SERIALIZATION", "A row could not be encoded.")
                    })?)?;
                } else {
                    output.put(
                        row.iter()
                            .map(|v| csv(Some(v), request.spreadsheet_safe))
                            .collect::<Vec<_>>()
                            .join(",")
                            .as_bytes(),
                    )?;
                    output.put(b"\r\n")?;
                }
                exported += 1;
            }
            more = result.truncated || result.rows.len() > page.limit as usize;
            if exported >= request.max_rows || !more || count == 0 {
                break;
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::new("CANCELLED", "Export cancelled."));
        }
        Ok(())
    })?;
    if json {
        output.put(format!("],\"limited\":{more},\"rowCount\":{exported}}}").as_bytes())?;
    }
    Ok((exported, more))
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>, payload: Json) -> Result<Json, Error> {
    let request: ExportRequest = serde_json::from_value(payload)
        .map_err(|_| Error::new("VALIDATION", "Invalid export options."))?;
    if request.operation_id.is_empty() || request.operation_id.len() > 100 {
        return Err(Error::new("VALIDATION", "Invalid export operation."));
    }
    let state = app.state::<AppState>();
    let session = state.session(&request.request.connection_id)?;
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
                "An export with this identifier is already active.",
            ));
        }
        operations.insert(request.operation_id.clone(), operation.clone());
    }
    let _guard = OperationGuard {
        operations: &state.operations,
        id: request.operation_id.clone(),
    };
    let mut picker = app
        .dialog()
        .file()
        .set_title("Export table data")
        .set_file_name(format!(
            "{}.{}",
            request.request.table.name,
            if request.format == "csv" {
                "csv"
            } else {
                "json"
            }
        ));
    if let Some(window) = app.get_webview_window("main") {
        picker = picker.set_parent(&window);
    }
    let Some(file) = picker.blocking_save_file() else {
        return Ok(json!({"cancelled":true}));
    };
    let path = file
        .into_path()
        .map_err(|_| Error::new("FILE_PATH", "Choose a local export file."))?;
    if path.exists() {
        return Err(Error::new(
            "FILE_EXISTS",
            "The destination exists. Choose a new filename; no file was replaced.",
        ));
    }
    let temporary =
        Temporary(path.with_file_name(format!(".kitsune-export-{}.tmp", uuid::Uuid::new_v4())));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&temporary.0).map_err(io_error)?;
    let mut writer = std::io::BufWriter::new(file);
    let _permit = state
        .permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new("BUSY", "Database workers are busy; try the export again."))?;
    let mut db = session
        .db
        .lock()
        .map_err(|_| Error::new("STATE", "Connection unavailable."))?;
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
    if !request.allow_sensitive
        && request.columns.iter().any(|column| {
            settings
                .sensitive_columns
                .split(',')
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .any(|c| column.eq_ignore_ascii_case(c))
        })
    {
        return Err(Error::new(
            "EXPORT_SENSITIVE",
            "Explicitly authorize excluded-column export first.",
        ));
    }
    let (rows, limited) = write_export(
        &mut db,
        &request,
        &mut writer,
        &operation.cancelled,
        settings.query_timeout,
    )?;
    if !session.connected.load(Ordering::SeqCst) || operation.cancelled.load(Ordering::SeqCst) {
        return Err(Error::new(
            "CANCELLED",
            "The export was cancelled before publication.",
        ));
    }
    writer.flush().map_err(io_error)?;
    writer.get_ref().sync_all().map_err(io_error)?;
    drop(writer);
    std::fs::hard_link(&temporary.0, &path).map_err(io_error)?;
    Ok(json!({"cancelled":false,"rows":rows,"limited":limited,"path":path.to_string_lossy()}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_escapes_quotes_newlines_and_formula_text() {
        assert_eq!(
            csv(Some(&Value::Text("a,\"b\"\nc".into())), true),
            "\"a,\"\"b\"\"\nc\""
        );
        assert_eq!(
            csv(Some(&Value::Text("=SUM(1)".into())), true),
            "\"'=SUM(1)\""
        );
        assert_eq!(csv(Some(&Value::Null), true), "\\N");
        assert_eq!(csv(Some(&Value::Text("".into())), true), "\"\"");
    }
    #[test]
    fn sqlite_export_is_bounded_lossless_scoped_and_cancellable() {
        let path = std::env::temp_dir().join(format!(
            "kitsune-export-test-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let config: ConnectionConfig = serde_json::from_value(json!({"id":"test","name":"Test","driver":"sqlite","environment":"development","path":path,"create":true})).unwrap();
        let mut db = Database::open(&config, &path.with_extension("internal"), false).unwrap();
        db.query(
            "CREATE TABLE samples(id INTEGER PRIMARY KEY, note TEXT, payload BLOB, password TEXT)",
            &[],
            100,
            false,
            5,
        )
        .unwrap();
        db.query("INSERT INTO samples VALUES(1,NULL,X'00FF','secret'),(2,'',X'01','secret'),(9223372036854775807,'=SUM(1)',X'02','secret')",&[],100,false,5).unwrap();
        let mut request:ExportRequest=serde_json::from_value(json!({"request":{"connectionId":"test","table":{"schema":"","name":"samples","kind":"table"},"filterGroups":[{"mode":"all","filters":[{"column":"id","operator":"gt","value":{"kind":"integer","value":"1"}}]}]},"columns":["id","note","payload"],"format":"json","maxRows":1,"operationId":"test"})).unwrap();
        let cancel = AtomicBool::new(false);
        let mut bytes = vec![];
        assert_eq!(
            write_export(&mut db, &request, &mut bytes, &cancel, 5).unwrap(),
            (1, true)
        );
        let value: Json = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["rows"][0][0], json!({"kind":"integer","value":"2"}));
        assert_eq!(value["rows"][0][1], json!({"kind":"text","value":""}));
        request.max_rows = 100;
        bytes.clear();
        assert_eq!(
            write_export(&mut db, &request, &mut bytes, &cancel, 5).unwrap(),
            (2, false)
        );
        let value: Json = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["rows"][1][0]["value"], "9223372036854775807");
        assert_eq!(value["rows"][0][2], json!({"kind":"binary","value":"AQ=="}));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            write_export(&mut db, &request, &mut vec![], &cancel, 5)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert!(db.query("SELECT * FROM samples", &[], 100, true, 5).is_ok());
        cancel.store(false, Ordering::SeqCst);
        request.columns.push("password".into());
        assert_eq!(
            write_export(&mut db, &request, &mut vec![], &cancel, 5)
                .unwrap_err()
                .code,
            "EXPORT_SENSITIVE"
        );
        request.columns.pop();
        request.max_rows = 0;
        assert!(write_export(&mut db, &request, &mut vec![], &cancel, 5).is_err());
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
