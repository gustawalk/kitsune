//! Native PostgreSQL adapter through libpq. No authenticated URI is constructed.
//! libpq supplies TLS, SCRAM authentication, protocol handling and cancellation.
use crate::model::{ConnectionConfig, Error, ResultSet, Value};
use libloading::Library;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::Arc;
use std::time::Instant;

type Ptr = *mut c_void;
struct Api {
    _library: Library,
    connect: unsafe extern "C" fn(*const *const c_char, *const *const c_char, c_int) -> Ptr,
    status: unsafe extern "C" fn(Ptr) -> c_int,
    finish: unsafe extern "C" fn(Ptr),
    exec: unsafe extern "C" fn(Ptr, *const c_char) -> Ptr,
    result_status: unsafe extern "C" fn(Ptr) -> c_int,
    clear: unsafe extern "C" fn(Ptr),
    rows: unsafe extern "C" fn(Ptr) -> c_int,
    cols: unsafe extern "C" fn(Ptr) -> c_int,
    name: unsafe extern "C" fn(Ptr, c_int) -> *const c_char,
    oid: unsafe extern "C" fn(Ptr, c_int) -> u32,
    value: unsafe extern "C" fn(Ptr, c_int, c_int) -> *const c_char,
    null: unsafe extern "C" fn(Ptr, c_int, c_int) -> c_int,
    length: unsafe extern "C" fn(Ptr, c_int, c_int) -> c_int,
    affected: unsafe extern "C" fn(Ptr) -> *const c_char,
    error_field: unsafe extern "C" fn(Ptr, c_int) -> *const c_char,
    get_cancel: unsafe extern "C" fn(Ptr) -> Ptr,
    cancel: unsafe extern "C" fn(Ptr, *mut c_char, c_int) -> c_int,
    free_cancel: unsafe extern "C" fn(Ptr),
    send: unsafe extern "C" fn(
        Ptr,
        *const c_char,
        c_int,
        *const u32,
        *const *const c_char,
        *const c_int,
        *const c_int,
        c_int,
    ) -> c_int,
    single_row: unsafe extern "C" fn(Ptr) -> c_int,
    get_result: unsafe extern "C" fn(Ptr) -> Ptr,
}
impl Api {
    fn load() -> Result<Arc<Self>, Error> {
        #[cfg(target_os = "windows")]
        let names = ["libpq.dll"];
        #[cfg(target_os = "macos")]
        let names = [
            "libpq.dylib",
            "/opt/homebrew/opt/libpq/lib/libpq.dylib",
            "/usr/local/opt/libpq/lib/libpq.dylib",
        ];
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let names = ["libpq.so.5", "libpq.so"];
        let mut library = None;
        for name in names {
            if let Ok(l) = unsafe { Library::new(name) } {
                library = Some(l);
                break;
            }
        }
        let l=library.ok_or_else(||Error::new("POSTGRES_DRIVER","PostgreSQL requires libpq. Install PostgreSQL client libraries, then restart Kitsune."))?;
        unsafe {
            macro_rules! symbol {
                ($name:literal) => {
                    *l.get(concat!($name, "\0").as_bytes()).map_err(|_| {
                        Error::new(
                            "POSTGRES_DRIVER",
                            "Installed libpq is missing a required API.",
                        )
                    })?
                };
            }
            Ok(Arc::new(Self {
                connect: symbol!("PQconnectdbParams"),
                status: symbol!("PQstatus"),
                finish: symbol!("PQfinish"),
                exec: symbol!("PQexec"),
                result_status: symbol!("PQresultStatus"),
                clear: symbol!("PQclear"),
                rows: symbol!("PQntuples"),
                cols: symbol!("PQnfields"),
                name: symbol!("PQfname"),
                oid: symbol!("PQftype"),
                value: symbol!("PQgetvalue"),
                null: symbol!("PQgetisnull"),
                length: symbol!("PQgetlength"),
                affected: symbol!("PQcmdTuples"),
                error_field: symbol!("PQresultErrorField"),
                get_cancel: symbol!("PQgetCancel"),
                cancel: symbol!("PQcancel"),
                free_cancel: symbol!("PQfreeCancel"),
                send: symbol!("PQsendQueryParams"),
                single_row: symbol!("PQsetSingleRowMode"),
                get_result: symbol!("PQgetResult"),
                _library: l,
            }))
        }
    }
}
pub struct Pg {
    transaction_open: bool,
    api: Arc<Api>,
    connection: Ptr,
}
// Each Pg is exclusively accessed under the session mutex. libpq explicitly permits
// separate connections on separate threads, but not concurrent use of one PGconn.
unsafe impl Send for Pg {}
pub struct Cancel {
    api: Arc<Api>,
    handle: Ptr,
}
unsafe impl Send for Cancel {}
unsafe impl Sync for Cancel {}
impl Cancel {
    pub fn cancel(&self) {
        unsafe {
            let mut buffer = [0i8; 256];
            (self.api.cancel)(self.handle, buffer.as_mut_ptr(), 256);
        }
    }
}
impl Drop for Cancel {
    fn drop(&mut self) {
        unsafe { (self.api.free_cancel)(self.handle) }
    }
}
impl Drop for Pg {
    fn drop(&mut self) {
        unsafe { (self.api.finish)(self.connection) }
    }
}
fn c(s: &str) -> Result<CString, Error> {
    CString::new(s).map_err(|_| {
        Error::new(
            "VALIDATION",
            "NUL bytes are not supported in text parameters.",
        )
    })
}
unsafe fn string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned()
    }
}
impl Pg {
    pub fn open(config: &ConnectionConfig) -> Result<Self, Error> {
        let api = Api::load()?;
        let keys = [
            "host",
            "port",
            "dbname",
            "user",
            "password",
            "sslmode",
            "connect_timeout",
            "application_name",
            "options",
        ];
        let values=[config.host.clone(),config.port.to_string(),config.database.clone(),config.username.clone(),config.password.clone(),config.ssl_mode.clone(),"10".into(),"Kitsune".into(),"-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000 -c bytea_output=hex -c standard_conforming_strings=on -c client_encoding=UTF8".into()];
        let keys: Vec<_> = keys.iter().map(|v| c(v)).collect::<Result<_, _>>()?;
        let values: Vec<_> = values.iter().map(|v| c(v)).collect::<Result<_, _>>()?;
        let mut kp: Vec<_> = keys.iter().map(|v| v.as_ptr()).collect();
        kp.push(std::ptr::null());
        let mut vp: Vec<_> = values.iter().map(|v| v.as_ptr()).collect();
        vp.push(std::ptr::null());
        let connection = unsafe { (api.connect)(kp.as_ptr(), vp.as_ptr(), 0) };
        if connection.is_null() {
            return Err(Error::new(
                "CONNECTION",
                "PostgreSQL could not allocate a connection.",
            ));
        }
        let pg = Self {
            api,
            connection,
            transaction_open: false,
        };
        if unsafe { (pg.api.status)(connection) } != 0 {
            return Err(Error::new(
                "CONNECTION",
                "PostgreSQL connection failed. Check credentials, host, TLS configuration, and server availability.",
            ));
        }
        Ok(pg)
    }
    pub fn cancel_handle(&self) -> Option<Arc<Cancel>> {
        let handle = unsafe { (self.api.get_cancel)(self.connection) };
        if handle.is_null() {
            None
        } else {
            Some(Arc::new(Cancel {
                api: self.api.clone(),
                handle,
            }))
        }
    }
    fn command(&mut self, sql: &str) -> Result<(), Error> {
        let sql = c(sql)?;
        let result = unsafe { (self.api.exec)(self.connection, sql.as_ptr()) };
        if result.is_null() {
            return Err(Error::new(
                "CONNECTION_LOST",
                "PostgreSQL connection was lost.",
            ));
        }
        let status = unsafe { (self.api.result_status)(result) };
        unsafe { (self.api.clear)(result) };
        if status != 1 {
            return Err(Error::new(
                "POSTGRES",
                "PostgreSQL could not establish the managed transaction.",
            ));
        }
        Ok(())
    }
    pub(super) fn restore_begin(&mut self, read_only: bool) -> Result<(), Error> {
        self.command(if read_only {
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        } else {
            "BEGIN"
        })?;
        self.transaction_open = true;
        Ok(())
    }
    pub(super) fn restore_end(&mut self, commit: bool) -> Result<(), Error> {
        let result = self.command(if commit { "COMMIT" } else { "ROLLBACK" });
        self.transaction_open = false;
        result.map_err(|_|Error::new("OUTCOME_UNCERTAIN","The database did not confirm the restore outcome. Verify the current record before repeating the operation."))
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
        let own_transaction = !self.transaction_open;
        if own_transaction {
            self.command(if read_only {
                "BEGIN READ ONLY"
            } else {
                "BEGIN"
            })?;
        }
        if let Err(e) = self.command(&format!(
            "SET LOCAL statement_timeout = {}",
            timeout.clamp(1, 300) * 1000
        )) {
            let _ = self.command("ROLLBACK");
            return Err(e);
        }
        let result = self.query_inner(sql, params, limit);
        match result {
            Ok(r) => {
                if expected.is_some_and(|n| n != r.affected) {
                    let _ = self.command("ROLLBACK");
                    return Err(Error::new(
                        "MUTATION_CONFLICT",
                        "The selected rows changed or no longer match. No changes from this operation were committed. Refresh and review the selection.",
                    ));
                }
                if own_transaction {
                    self.command("COMMIT").map_err(|_|Error::new("OUTCOME_UNCERTAIN","PostgreSQL could not confirm the commit. Verify the database state before repeating a write."))?;
                }
                Ok(r)
            }
            Err(e) => {
                let _ = self.command("ROLLBACK");
                Err(e)
            }
        }
    }
    fn query_inner(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
    ) -> Result<ResultSet, Error> {
        let start = Instant::now();
        let sql = c(sql)?;
        let strings: Vec<Option<CString>> = params
            .iter()
            .map(|v| {
                pg_parameter(v)
                    .map(|s| s.map(|s| c(&s)))
                    .and_then(|s| s.transpose())
            })
            .collect::<Result<_, _>>()?;
        let ptrs: Vec<_> = strings
            .iter()
            .map(|s| s.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()))
            .collect();
        let sent = unsafe {
            (self.api.send)(
                self.connection,
                sql.as_ptr(),
                ptrs.len() as i32,
                std::ptr::null(),
                ptrs.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
            )
        };
        if sent != 1 {
            return Err(Error::new(
                "CONNECTION_LOST",
                "PostgreSQL could not send the query.",
            ));
        }
        unsafe { (self.api.single_row)(self.connection) };
        let mut output = ResultSet::empty();
        let mut bytes = 0usize;
        let mut failure = None;
        let mut cancelled = false;
        loop {
            let r = unsafe { (self.api.get_result)(self.connection) };
            if r.is_null() {
                break;
            }
            let status = unsafe { (self.api.result_status)(r) };
            if status == 1 || status == 2 || status == 9 {
                let ncols = unsafe { (self.api.cols)(r) };
                if output.columns.is_empty() {
                    for col in 0..ncols {
                        output
                            .columns
                            .push(unsafe { string((self.api.name)(r, col)) });
                        output
                            .types
                            .push(oid_name(unsafe { (self.api.oid)(r, col) }));
                    }
                }
                for row in 0..unsafe { (self.api.rows)(r) } {
                    let mut record = Vec::new();
                    for col in 0..ncols {
                        let len = unsafe { (self.api.length)(r, row, col) } as usize;
                        bytes = bytes.saturating_add(len);
                        if bytes > 10 * 1024 * 1024 {
                            break;
                        }
                        let value = if unsafe { (self.api.null)(r, row, col) } != 0 {
                            Value::Null
                        } else {
                            decode(unsafe { (self.api.oid)(r, col) }, unsafe {
                                string((self.api.value)(r, row, col))
                            })
                        };
                        record.push(value);
                    }
                    if bytes > 10 * 1024 * 1024 || output.rows.len() >= limit {
                        output.truncated = true;
                        if !cancelled {
                            if let Some(c) = self.cancel_handle() {
                                c.cancel();
                            }
                            cancelled = true;
                        }
                    } else {
                        output.rows.push(record);
                    }
                }
                let affected = unsafe { string((self.api.affected)(r)) };
                if let Ok(n) = affected.parse() {
                    output.affected = n;
                }
            } else if !cancelled {
                let code = unsafe { string((self.api.error_field)(r, 67)) };
                let position = unsafe { string((self.api.error_field)(r, 80)) };
                failure = Some(Error::new(
                    if code == "57014" {
                        "INTERRUPTED"
                    } else if code == "25006" {
                        "READ_ONLY"
                    } else {
                        "POSTGRES"
                    },
                    &format!(
                        "PostgreSQL rejected the statement (SQLSTATE {code}{}). Check SQL and permissions.",
                        if position.is_empty() {
                            String::new()
                        } else {
                            format!(", position {position}")
                        }
                    ),
                ));
            }
            unsafe { (self.api.clear)(r) };
        }
        if let Some(e) = failure {
            return Err(e);
        }
        if cancelled {
            return Err(Error::new(
                "RESULT_LIMIT",
                "Result exceeded the row or byte limit. PostgreSQL execution was interrupted and the transaction rolled back. Narrow the query.",
            ));
        }
        output.duration_ms = start.elapsed().as_millis() as u64;
        Ok(output)
    }
}
pub fn oid_name(oid: u32) -> String {
    match oid {
        16 => "boolean",
        17 => "bytea",
        20 => "int8",
        21 => "int2",
        23 => "int4",
        700 => "float4",
        701 => "float8",
        1700 => "numeric",
        114 => "json",
        3802 => "jsonb",
        1082 => "date",
        1114 => "timestamp",
        1184 => "timestamptz",
        2950 => "uuid",
        25 => "text",
        1043 => "varchar",
        1000..=1041 => "array",
        _ => return format!("custom (OID {oid})"),
    }
    .into()
}
pub fn decode(oid: u32, s: String) -> Value {
    match oid {
        16 => Value::Boolean(s == "t"),
        17 => {
            use base64::Engine;
            let hex = s.strip_prefix("\\x").unwrap_or(&s);
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(hex.get(i..i + 2).unwrap_or(""), 16))
                .collect::<Result<Vec<_>, _>>();
            match bytes {
                Ok(b) => Value::Binary(base64::engine::general_purpose::STANDARD.encode(b)),
                Err(_) => Value::Unknown(s),
            }
        }
        20 | 21 | 23 | 26 => Value::Integer(s),
        700 | 701 => Value::Float(s),
        1700 => Value::Decimal(s),
        114 | 3802 => Value::Json(s),
        1082 => Value::Date(s),
        1114 | 1184 | 1083 | 1266 => Value::Timestamp(s),
        2950 => Value::Uuid(s),
        25 | 1042 | 1043 | 19 => Value::Text(s),
        1000..=1041 | 1182 | 1185 | 1231 | 199 | 3807 | 2951 => Value::Array(s),
        _ => Value::Unknown(s),
    }
}

fn pg_parameter(value: &Value) -> Result<Option<String>, Error> {
    if let Value::Binary(encoded) = value {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Error::new("VALUE_ENCODING", "Invalid binary encoding."))?;
        return Ok(Some(format!(
            "\\x{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )));
    }
    Ok(value.text())
}
