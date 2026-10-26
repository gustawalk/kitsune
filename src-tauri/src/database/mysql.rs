//! MariaDB Connector/C 3 ABI; deliberately never load Oracle's incompatible MYSQL_BIND ABI.
//! Connections and native statement buffers are exclusively owned by the session mutex.
use crate::model::*;
use base64::Engine;
use libloading::Library;
use std::{
    ffi::{CStr, CString, c_char, c_int, c_uint, c_ulong, c_void},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
type Ptr = *mut c_void;
#[repr(C)]
struct Bind {
    length: *mut c_ulong,
    is_null: *mut u8,
    buffer: Ptr,
    error: *mut u8,
    u: Ptr,
    store: Option<unsafe extern "C" fn()>,
    fetch: Option<unsafe extern "C" fn()>,
    skip: Option<unsafe extern "C" fn()>,
    buffer_length: c_ulong,
    offset: c_ulong,
    length_value: c_ulong,
    flags: c_uint,
    pack_length: c_uint,
    buffer_type: c_int,
    error_value: u8,
    is_unsigned: u8,
    long_data_used: u8,
    is_null_value: u8,
    extension: Ptr,
}
#[repr(C)]
struct Field {
    name: *mut c_char,
    org_name: *mut c_char,
    table: *mut c_char,
    org_table: *mut c_char,
    db: *mut c_char,
    catalog: *mut c_char,
    def: *mut c_char,
    length: c_ulong,
    max_length: c_ulong,
    name_length: c_uint,
    org_name_length: c_uint,
    table_length: c_uint,
    org_table_length: c_uint,
    db_length: c_uint,
    catalog_length: c_uint,
    def_length: c_uint,
    flags: c_uint,
    decimals: c_uint,
    charsetnr: c_uint,
    kind: c_int,
    extension: Ptr,
}
struct Api {
    _library: Library,
    init: unsafe extern "C" fn(Ptr) -> Ptr,
    close: unsafe extern "C" fn(Ptr),
    connect: unsafe extern "C" fn(
        Ptr,
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        c_uint,
        *const c_char,
        c_ulong,
    ) -> Ptr,
    options: unsafe extern "C" fn(Ptr, c_int, *const c_void) -> c_int,
    real_query: unsafe extern "C" fn(Ptr, *const c_char, c_ulong) -> c_int,
    store_result: unsafe extern "C" fn(Ptr) -> Ptr,
    free_result: unsafe extern "C" fn(Ptr),
    thread_id: unsafe extern "C" fn(Ptr) -> c_ulong,
    thread_init: unsafe extern "C" fn() -> u8,
    thread_end: unsafe extern "C" fn(),
    errno: unsafe extern "C" fn(Ptr) -> c_uint,
    ssl_cipher: unsafe extern "C" fn(Ptr) -> *const c_char,
    stmt_init: unsafe extern "C" fn(Ptr) -> Ptr,
    stmt_close: unsafe extern "C" fn(Ptr) -> u8,
    prepare: unsafe extern "C" fn(Ptr, *const c_char, c_ulong) -> c_int,
    param_count: unsafe extern "C" fn(Ptr) -> c_ulong,
    bind_param: unsafe extern "C" fn(Ptr, *mut Bind) -> u8,
    execute: unsafe extern "C" fn(Ptr) -> c_int,
    metadata: unsafe extern "C" fn(Ptr) -> Ptr,
    num_fields: unsafe extern "C" fn(Ptr) -> c_uint,
    field: unsafe extern "C" fn(Ptr, c_uint) -> *mut Field,
    bind_result: unsafe extern "C" fn(Ptr, *mut Bind) -> u8,
    fetch: unsafe extern "C" fn(Ptr) -> c_int,
    fetch_column: unsafe extern "C" fn(Ptr, *mut Bind, c_uint, c_ulong) -> c_int,
    stmt_errno: unsafe extern "C" fn(Ptr) -> c_uint,
    affected: unsafe extern "C" fn(Ptr) -> u64,
}
impl Api {
    fn load() -> Result<Arc<Self>, Error> {
        static API: std::sync::OnceLock<Result<Arc<Api>, Error>> = std::sync::OnceLock::new();
        API.get_or_init(Self::load_inner).clone()
    }
    fn load_inner() -> Result<Arc<Self>, Error> {
        #[cfg(target_os = "windows")]
        let names = ["libmariadb.dll"];
        #[cfg(target_os = "macos")]
        let names = ["libmariadb.3.dylib", "libmariadb.dylib"];
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let names = ["libmariadb.so.3"];
        let l = names
            .iter()
            .find_map(|n| unsafe { Library::new(n).ok() })
            .ok_or_else(|| {
                Error::new(
                    "MYSQL_DRIVER",
                    "Install MariaDB Connector/C 3 client libraries to use MySQL/MariaDB.",
                )
            })?;
        let initialize = unsafe {
            *l.get::<unsafe extern "C" fn(c_int, *mut *mut c_char, *mut *mut c_char) -> c_int>(
                b"mysql_server_init\0",
            )
            .map_err(|_| Error::new("MYSQL_DRIVER", "Connector initialization API is missing."))?
        };
        if unsafe { initialize(0, std::ptr::null_mut(), std::ptr::null_mut()) } != 0 {
            return Err(Error::new(
                "MYSQL_DRIVER",
                "Connector initialization failed.",
            ));
        }
        Self::from_library(l)
    }
    fn from_library(l: Library) -> Result<Arc<Self>, Error> {
        unsafe {
            macro_rules! symbol {
                ($name:literal) => {
                    *l.get(concat!($name, "\0").as_bytes()).map_err(|_| {
                        Error::new(
                            "MYSQL_DRIVER",
                            "MariaDB Connector/C is missing a required API.",
                        )
                    })?
                };
            }
            Ok(Arc::new(Self {
                init: symbol!("mysql_init"),
                close: symbol!("mysql_close"),
                connect: symbol!("mysql_real_connect"),
                options: symbol!("mysql_options"),
                real_query: symbol!("mysql_real_query"),
                store_result: symbol!("mysql_store_result"),
                free_result: symbol!("mysql_free_result"),
                thread_id: symbol!("mysql_thread_id"),
                thread_init: symbol!("mysql_thread_init"),
                thread_end: symbol!("mysql_thread_end"),
                errno: symbol!("mysql_errno"),
                ssl_cipher: symbol!("mysql_get_ssl_cipher"),
                stmt_init: symbol!("mysql_stmt_init"),
                stmt_close: symbol!("mysql_stmt_close"),
                prepare: symbol!("mysql_stmt_prepare"),
                param_count: symbol!("mysql_stmt_param_count"),
                bind_param: symbol!("mysql_stmt_bind_param"),
                execute: symbol!("mysql_stmt_execute"),
                metadata: symbol!("mysql_stmt_result_metadata"),
                num_fields: symbol!("mysql_num_fields"),
                field: symbol!("mysql_fetch_field_direct"),
                bind_result: symbol!("mysql_stmt_bind_result"),
                fetch: symbol!("mysql_stmt_fetch"),
                fetch_column: symbol!("mysql_stmt_fetch_column"),
                stmt_errno: symbol!("mysql_stmt_errno"),
                affected: symbol!("mysql_stmt_affected_rows"),
                _library: l,
            }))
        }
    }
}
thread_local! {static THREAD_DEPTH:std::cell::Cell<u32>=const{std::cell::Cell::new(0)};}
struct Thread(Arc<Api>);
impl Thread {
    fn enter(api: &Arc<Api>) -> Result<Self, Error> {
        let depth = THREAD_DEPTH.get();
        if depth == 0 && unsafe { (api.thread_init)() } != 0 {
            return Err(Error::new(
                "MYSQL_DRIVER",
                "Connector thread initialization failed.",
            ));
        }
        THREAD_DEPTH.set(depth + 1);
        Ok(Self(api.clone()))
    }
}
impl Drop for Thread {
    fn drop(&mut self) {
        let depth = THREAD_DEPTH.get().saturating_sub(1);
        THREAD_DEPTH.set(depth);
        if depth == 0 {
            unsafe { (self.0.thread_end)() }
        }
    }
}
struct Statement {
    api: Arc<Api>,
    ptr: Ptr,
}
impl Drop for Statement {
    fn drop(&mut self) {
        unsafe {
            (self.api.stmt_close)(self.ptr);
        }
    }
}
struct ResultMetadata {
    api: Arc<Api>,
    ptr: Ptr,
}
impl Drop for ResultMetadata {
    fn drop(&mut self) {
        unsafe { (self.api.free_result)(self.ptr) }
    }
}
fn err(code: u32) -> Error {
    let (category, message) = match code {
        1045 | 1698 => (
            "AUTHENTICATION",
            "MySQL/MariaDB authentication failed. Check the username and password.",
        ),
        1290 | 1792 => (
            "READ_ONLY",
            "The database rejected a write in read-only mode.",
        ),
        1205 | 1317 | 1969 | 3024 => (
            "INTERRUPTED",
            "MySQL/MariaDB execution timed out or was interrupted.",
        ),
        2002 | 2003 | 2006 | 2013 => (
            "CONNECTION_LOST",
            "MySQL/MariaDB is unavailable or the connection was lost.",
        ),
        1062 | 1451 | 1452 | 1048 => (
            "CONSTRAINT",
            "The operation violates a database constraint.",
        ),
        _ => (
            "MYSQL",
            "MySQL/MariaDB rejected the statement. Check syntax, permissions, and server compatibility.",
        ),
    };
    Error::new(category, &format!("{message} (code {code})"))
}
fn c(s: &str) -> Result<CString, Error> {
    CString::new(s).map_err(|_| {
        Error::new(
            "VALIDATION",
            "NUL bytes are not allowed in connection properties.",
        )
    })
}
unsafe fn name(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}
enum Parameter {
    Bytes(Vec<u8>),
    Signed(Box<i64>),
    Unsigned(Box<u64>),
    Boolean(Box<u8>),
}
impl Parameter {
    fn len(&self) -> usize {
        match self {
            Self::Bytes(v) => v.len(),
            Self::Signed(_) | Self::Unsigned(_) => 8,
            Self::Boolean(_) => 1,
        }
    }
    fn pointer(&mut self) -> Ptr {
        match self {
            Self::Bytes(v) => v.as_mut_ptr().cast(),
            Self::Signed(v) => (&mut **v as *mut i64).cast(),
            Self::Unsigned(v) => (&mut **v as *mut u64).cast(),
            Self::Boolean(v) => (&mut **v as *mut u8).cast(),
        }
    }
}
pub struct Mysql {
    api: Arc<Api>,
    connection: Ptr,
    transaction_open: bool,
    cancel: Arc<Cancel>,
    generation: u64,
}
// Connector connections are never concurrently used; moving exclusive ownership is allowed.
unsafe impl Send for Mysql {}
#[derive(Default)]
struct CancelState {
    generation: Option<u64>,
    requested: bool,
}
pub struct Cancel {
    api: Arc<Api>,
    config: ConnectionConfig,
    id: c_ulong,
    active: Mutex<CancelState>,
}
impl Cancel {
    pub fn cancel(&self) {
        self.cancel_generation(None)
    }
    fn check_requested(&self) -> Result<(), Error> {
        let state = self
            .active
            .lock()
            .map_err(|_| Error::new("STATE", "Cancellation state unavailable."))?;
        if state.generation.is_some() && state.requested {
            return Err(Error::new(
                "INTERRUPTED",
                "The operation was cancelled before its next database step.",
            ));
        }
        Ok(())
    }
    fn cancel_generation(&self, expected: Option<u64>) {
        // Serialize completion with cancellation to prevent a late timer killing the next query.
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        if active.generation.is_none() || expected.is_some_and(|n| active.generation != Some(n)) {
            return;
        }
        active.requested = true;
        if let Ok(mut db) = Mysql::connect(self.api.clone(), &self.config) {
            let _ = db.command(&format!("KILL QUERY {}", self.id));
        }
    }
}
enum Watchdog {
    Async(tokio::task::JoinHandle<()>),
    Thread(std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>),
}
impl Watchdog {
    fn start(cancel: Arc<Cancel>, generation: u64, timeout: u64) -> Self {
        let duration = Duration::from_secs(timeout.clamp(1, 300));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            Self::Async(runtime.spawn(async move {
                tokio::time::sleep(duration).await;
                let _ =
                    tokio::task::spawn_blocking(move || cancel.cancel_generation(Some(generation)))
                        .await;
            }))
        } else {
            let (sender, receiver) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                if matches!(
                    receiver.recv_timeout(duration),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    cancel.cancel_generation(Some(generation));
                }
            });
            Self::Thread(sender, thread)
        }
    }
    fn finish(self) {
        match self {
            Self::Async(task) => task.abort(),
            Self::Thread(sender, thread) => {
                let _ = sender.send(());
                let _ = thread.join();
            }
        }
    }
}
struct Active(Arc<Cancel>);
impl Drop for Active {
    fn drop(&mut self) {
        if let Ok(mut n) = self.0.active.lock() {
            *n = CancelState::default();
        }
    }
}
impl Drop for Mysql {
    fn drop(&mut self) {
        let _thread = Thread::enter(&self.api);
        unsafe { (self.api.close)(self.connection) }
    }
}
impl Mysql {
    pub fn open(config: &ConnectionConfig) -> Result<Self, Error> {
        // Connector/C 3.4 intentionally skips hostname/CA checks for private/local peers.
        // Its verify flag alone cannot implement this application's verify-full contract.
        if config.ssl_mode == "verify-full" {
            return Err(Error::new(
                "TLS_VERIFY_UNSUPPORTED",
                "Strict certificate/hostname verification is unavailable in this Connector/C adapter. No connection was attempted. Use a verified driver/TLS tunnel; never downgrade an untrusted connection.",
            ));
        }
        Self::connect(Api::load()?, config)
    }
    fn connect(api: Arc<Api>, config: &ConnectionConfig) -> Result<Self, Error> {
        let _thread = Thread::enter(&api)?;
        let connection = unsafe { (api.init)(std::ptr::null_mut()) };
        if connection.is_null() {
            return Err(Error::new(
                "MYSQL_DRIVER",
                "Connector could not allocate a connection.",
            ));
        }
        let mut db = Self {
            api: api.clone(),
            connection,
            transaction_open: false,
            generation: 0,
            cancel: Arc::new(Cancel {
                api: api.clone(),
                config: config.clone(),
                id: 0,
                active: Mutex::new(CancelState::default()),
            }),
        };
        let timeout = 10u32;
        let disabled = 0u32;
        let no = 0u8;
        let enforce = u8::from(config.ssl_mode != "disable");
        let verify = u8::from(config.ssl_mode == "verify-full");
        // Require encrypted transport by default; there is no opportunistic downgrade.
        for (option, pointer) in [
            (0, (&timeout as *const u32).cast()),
            (11, (&timeout as *const u32).cast()),
            (12, (&timeout as *const u32).cast()),
            (8, (&disabled as *const u32).cast()),
            (20, (&no as *const u8).cast()),
            (38, (&enforce as *const u8).cast()),
            (21, (&verify as *const u8).cast()),
        ] {
            if unsafe { (api.options)(connection, option, pointer) } != 0 {
                return Err(Error::new(
                    "MYSQL_DRIVER",
                    "Connector could not apply required safety settings.",
                ));
            }
        }
        let charset = c("utf8mb4")?;
        if unsafe { (api.options)(connection, 7, charset.as_ptr().cast()) } != 0 {
            return Err(Error::new(
                "MYSQL_DRIVER",
                "Connector could not enforce UTF-8 encoding.",
            ));
        }
        let socket = if config.host.starts_with('/') {
            Some(c(&config.host)?)
        } else {
            None
        };
        let host = c(if socket.is_some() {
            "localhost"
        } else {
            &config.host
        })?;
        let user = c(&config.username)?;
        let password = c(&config.password)?;
        let database = c(&config.database)?;
        let connected = unsafe {
            (api.connect)(
                connection,
                host.as_ptr(),
                user.as_ptr(),
                password.as_ptr(),
                database.as_ptr(),
                config.port as c_uint,
                socket.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                2, /* CLIENT_FOUND_ROWS */
            )
        };
        if connected.is_null() {
            return Err(err(unsafe { (api.errno)(connection) }));
        }
        if config.ssl_mode != "disable" && unsafe { (api.ssl_cipher)(connection) }.is_null() {
            return Err(Error::new(
                "TLS_REQUIRED",
                "The server did not negotiate TLS. Use TLS or explicitly choose disable for a trusted local fixture.",
            ));
        }
        // This changes only this managed session, never schema or persistent database settings.
        db.command(
            "SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES,NO_BACKSLASH_ESCAPES')",
        )?;
        let id = unsafe { (api.thread_id)(connection) };
        db.cancel = Arc::new(Cancel {
            api,
            config: config.clone(),
            id,
            active: Mutex::new(CancelState::default()),
        });
        Ok(db)
    }
    pub fn cancel_handle(&self) -> Arc<Cancel> {
        self.cancel.clone()
    }
    fn command(&mut self, sql: &str) -> Result<(), Error> {
        let _thread = Thread::enter(&self.api)?;
        if unsafe {
            (self.api.real_query)(self.connection, sql.as_ptr().cast(), sql.len() as c_ulong)
        } != 0
        {
            return Err(err(unsafe { (self.api.errno)(self.connection) }));
        }
        let r = unsafe { (self.api.store_result)(self.connection) };
        if !r.is_null() {
            unsafe { (self.api.free_result)(r) }
        }
        Ok(())
    }
    pub(super) fn restore_begin(&mut self, read_only: bool) -> Result<(), Error> {
        self.command("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")?;
        self.command(if read_only {
            "START TRANSACTION READ ONLY"
        } else {
            "START TRANSACTION"
        })?;
        self.transaction_open = true;
        Ok(())
    }
    pub(super) fn restore_end(&mut self, commit: bool) -> Result<(), Error> {
        self.transaction_open = false;
        self.command(if commit{"COMMIT"}else{"ROLLBACK"}).map_err(|_|Error::new("OUTCOME_UNCERTAIN","The server did not confirm the transaction outcome. Verify current data before repeating a write."))
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
        let _thread = Thread::enter(&self.api)?;
        // Executable comments and CALL/DDL can bypass transactional guarantees. Keep this adapter transactional.
        if sql.contains("/*!")
            || sql.contains("/*M!")
            || ![
                "SELECT", "WITH", "VALUES", "EXPLAIN", "SHOW", "INSERT", "UPDATE", "DELETE",
            ]
            .contains(&crate::safety::first_word(sql).as_str())
        {
            return Err(Error::new(
                "MYSQL_UNSUPPORTED",
                "Managed MySQL/MariaDB supports queries and transactional DML. DDL, routines, session control, and executable comments require another client.",
            ));
        }
        let own = !self.transaction_open;
        if own {
            self.restore_begin(read_only)?;
        }
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        *self
            .cancel
            .active
            .lock()
            .map_err(|_| Error::new("STATE", "Cancellation state unavailable."))? = CancelState {
            generation: Some(generation),
            requested: false,
        };
        let active = Active(self.cancel.clone());
        let watchdog = Watchdog::start(self.cancel.clone(), generation, timeout);
        let result = self
            .validate_statement(sql, read_only)
            .and_then(|()| self.query_inner(sql, params, limit));
        drop(active);
        watchdog.finish();
        let result = result.and_then(|r| {
            if expected.is_some_and(|n| n != r.affected) {
                Err(Error::new(
                    "MUTATION_CONFLICT",
                    "Rows changed since review. The operation was rolled back.",
                ))
            } else {
                Ok(r)
            }
        });
        if own {
            self.restore_end(result.is_ok())?;
        }
        result
    }

    fn validate_statement(&mut self, sql: &str, read_only: bool) -> Result<(), Error> {
        let tokens = sql_words(sql)?;
        if tokens
            .iter()
            .any(|w| ["OUTFILE", "DUMPFILE", "LOAD_FILE"].contains(&w.to_uppercase().as_str()))
            || sql.contains(":=")
        {
            return Err(Error::new(
                "MYSQL_UNSUPPORTED",
                "External-file operations and session-variable assignment are unavailable in the managed editor.",
            ));
        }
        let first = crate::safety::first_word(sql);
        if ["SELECT", "WITH"].contains(&first.as_str())
            && tokens.iter().any(|w| w.eq_ignore_ascii_case("INTO"))
        {
            return Err(Error::new(
                "MYSQL_UNSUPPORTED",
                "SELECT INTO is unavailable in the managed editor.",
            ));
        }
        if read_only || !["INSERT", "UPDATE", "DELETE", "WITH"].contains(&first.as_str()) {
            return Ok(());
        }
        let start = match first.as_str() {
            "INSERT" | "DELETE"
                if tokens.get(1).is_some_and(|w| {
                    w.eq_ignore_ascii_case(if first == "INSERT" { "INTO" } else { "FROM" })
                }) =>
            {
                2
            }
            "UPDATE" => 1,
            _ => {
                return Err(Error::new(
                    "MYSQL_UNSUPPORTED",
                    "Use one simple INSERT INTO, UPDATE, or DELETE FROM target for managed writes.",
                ));
            }
        };
        let name = tokens
            .get(start)
            .ok_or_else(|| Error::new("SQL_PARSE", "Choose a write target."))?;
        let (schema, table, end) = if tokens.get(start + 1).is_some_and(|s| s == ".") {
            (
                name.clone(),
                tokens
                    .get(start + 2)
                    .cloned()
                    .ok_or_else(|| Error::new("SQL_PARSE", "Choose a table name."))?,
                start + 3,
            )
        } else {
            (self.cancel.config.database.clone(), name.clone(), start + 1)
        };
        if first == "UPDATE"
            && !tokens
                .get(end)
                .is_some_and(|s| s.eq_ignore_ascii_case("SET"))
            || first == "DELETE"
                && tokens
                    .get(end)
                    .is_some_and(|s| !s.eq_ignore_ascii_case("WHERE"))
        {
            return Err(Error::new(
                "MYSQL_UNSUPPORTED",
                "Multi-table writes and aliased write targets are unavailable in managed SQL.",
            ));
        }
        self.query_inner(
            &format!(
                "SELECT 1 FROM {} LIMIT 0",
                super::qualified(&TableRef {
                    schema: schema.clone(),
                    name: table.clone(),
                    kind: "table".into()
                })
            ),
            &[],
            1,
        )?;
        let p = [Value::Text(schema), Value::Text(table)];
        let r = self.query_inner(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?1 AND TABLE_NAME=?2",
            &p,
            1,
        )?;
        let triggers=self.query_inner("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=?1 AND EVENT_OBJECT_TABLE=?2",&p,1)?;
        if r.rows
            .first()
            .and_then(|r| r.first())
            .and_then(Value::text)
            .is_none_or(|s| !s.eq_ignore_ascii_case("InnoDB"))
            || triggers
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(Value::text)
                .as_deref()
                != Some("0")
        {
            return Err(Error::new(
                "TRANSACTION_UNSUPPORTED",
                "Managed writes require an InnoDB table without triggers. Other targets require another client.",
            ));
        }
        Ok(())
    }
    fn query_inner(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
    ) -> Result<ResultSet, Error> {
        self.cancel.check_requested()?;
        let started = Instant::now();
        let (sql, params) = parameters(sql, params)?;
        let ptr = unsafe { (self.api.stmt_init)(self.connection) };
        if ptr.is_null() {
            return Err(Error::new(
                "MYSQL_DRIVER",
                "Could not allocate a statement.",
            ));
        }
        let statement = Statement {
            api: self.api.clone(),
            ptr,
        };
        let p = statement.ptr;
        let check = |failed: bool| {
            if failed {
                Err(err(unsafe { (self.api.stmt_errno)(p) }))
            } else {
                Ok(())
            }
        };
        check(unsafe { (self.api.prepare)(p, sql.as_ptr().cast(), sql.len() as c_ulong) } != 0)?;
        if unsafe { (self.api.param_count)(p) } as usize != params.len() {
            return Err(Error::new(
                "UNBOUND_PARAMETERS",
                "Provide every query parameter before executing.",
            ));
        }
        let mut data: Vec<Parameter> = params
            .iter()
            .map(|v| match v {
                Value::Binary(v) => base64::engine::general_purpose::STANDARD
                    .decode(v)
                    .map(Parameter::Bytes)
                    .map_err(|_| Error::new("VALUE", "Invalid binary parameter.")),
                Value::Integer(v) => {
                    if let Ok(n) = v.parse::<i64>() {
                        Ok(Parameter::Signed(Box::new(n)))
                    } else if let Ok(n) = v.parse::<u64>() {
                        Ok(Parameter::Unsigned(Box::new(n)))
                    } else {
                        Err(Error::new(
                            "VALUE",
                            "Integer exceeds 64-bit MySQL range; use decimal instead.",
                        ))
                    }
                }
                Value::Boolean(v) => Ok(Parameter::Boolean(Box::new(u8::from(*v)))),
                _ => Ok(Parameter::Bytes(v.text().unwrap_or_default().into_bytes())),
            })
            .collect::<Result<_, _>>()?;
        let mut lengths: Vec<c_ulong> = data.iter().map(|b| b.len() as c_ulong).collect();
        let mut nulls: Vec<u8> = params
            .iter()
            .map(|v| u8::from(matches!(v, Value::Null)))
            .collect();
        let mut binds: Vec<Bind> = (0..params.len())
            .map(|i| {
                let mut b: Bind = unsafe { std::mem::zeroed() };
                b.buffer = data[i].pointer();
                b.buffer_length = lengths[i];
                b.length = &mut lengths[i];
                b.is_null = &mut nulls[i];
                b.buffer_type = match &params[i] {
                    Value::Binary(_) => 252,
                    Value::Integer(v) => {
                        b.is_unsigned = u8::from(v.parse::<i64>().is_err());
                        8
                    }
                    Value::Boolean(_) => 1,
                    _ => 254,
                };
                b
            })
            .collect();
        if !binds.is_empty() {
            check(unsafe { (self.api.bind_param)(p, binds.as_mut_ptr()) } != 0)?;
        }
        self.cancel.check_requested()?;
        check(unsafe { (self.api.execute)(p) } != 0)?;
        let meta = unsafe { (self.api.metadata)(p) };
        let mut result = ResultSet {
            columns: vec![],
            types: vec![],
            rows: vec![],
            affected: 0,
            duration_ms: 0,
            truncated: false,
        };
        if meta.is_null() {
            result.affected = unsafe { (self.api.affected)(p) };
            result.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(result);
        }
        let _meta = ResultMetadata {
            api: self.api.clone(),
            ptr: meta,
        };
        let count = unsafe { (self.api.num_fields)(meta) } as usize;
        if count > 10000 {
            return Err(Error::new(
                "RESULT_LIMIT",
                "Result has more than 10,000 columns.",
            ));
        }
        let mut kinds = Vec::with_capacity(count);
        for i in 0..count {
            let f = unsafe { &*(self.api.field)(meta, i as c_uint) };
            result.columns.push(unsafe { name(f.name) });
            result.types.push(type_name(f.kind).into());
            kinds.push((f.kind, f.charsetnr));
        }
        let mut lengths = vec![0 as c_ulong; count];
        let mut nulls = vec![0u8; count];
        let mut errors = vec![0u8; count];
        let mut dummy = vec![0u8; count];
        let mut binds: Vec<Bind> = (0..count)
            .map(|i| {
                let mut b: Bind = unsafe { std::mem::zeroed() };
                b.buffer = (&mut dummy[i] as *mut u8).cast();
                b.buffer_length = 1;
                b.length = &mut lengths[i];
                b.is_null = &mut nulls[i];
                b.error = &mut errors[i];
                b.buffer_type = 254;
                b
            })
            .collect();
        check(unsafe { (self.api.bind_result)(p, binds.as_mut_ptr()) } != 0)?;
        let mut bytes = 0usize;
        loop {
            self.cancel.check_requested()?;
            let status = unsafe { (self.api.fetch)(p) };
            if status == 100 {
                break;
            }
            check(status != 0 && status != 101)?;
            if result.rows.len() >= limit {
                result.truncated = true;
                break;
            }
            let mut row = Vec::with_capacity(count);
            for i in 0..count {
                if nulls[i] != 0 {
                    row.push(Value::Null);
                    continue;
                }
                bytes = bytes.saturating_add(lengths[i] as usize);
                if bytes > 10 * 1024 * 1024 {
                    return Err(Error::new(
                        "RESULT_LIMIT",
                        "Result exceeds 10 MiB. Narrow the query.",
                    ));
                }
                let mut value = vec![0u8; lengths[i] as usize];
                let mut b: Bind = unsafe { std::mem::zeroed() };
                b.buffer = value.as_mut_ptr().cast();
                b.buffer_length = lengths[i];
                b.buffer_type = 254;
                check(unsafe { (self.api.fetch_column)(p, &mut b, i as c_uint, 0) } != 0)?;
                row.push(decode(kinds[i].0, kinds[i].1, &value));
            }
            result.rows.push(row);
        }
        result.duration_ms = started.elapsed().as_millis() as u64;
        Ok(result)
    }
}
fn type_name(kind: c_int) -> &'static str {
    match kind {
        0 | 246 => "decimal",
        1 | 2 | 3 | 8 | 9 | 13 => "integer",
        4 | 5 => "float",
        7 | 12 => "timestamp",
        10 | 14 => "date",
        11 => "time",
        16 | 249..=252 => "blob/text",
        245 => "json",
        _ => "text",
    }
}
fn decode(kind: c_int, charset: c_uint, bytes: &[u8]) -> Value {
    if charset == 63 && matches!(kind, 15 | 16 | 249..=254) {
        return Value::Binary(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    let Ok(s) = std::str::from_utf8(bytes) else {
        return Value::Unknown(format!(
            "base64:{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    };
    match kind {
        0 | 246 => Value::Decimal(s.into()),
        1 | 2 | 3 | 8 | 9 | 13 => Value::Integer(s.into()),
        4 | 5 => Value::Float(s.into()),
        7 | 12 => Value::Timestamp(s.into()),
        10 | 14 => Value::Date(s.into()),
        245 => Value::Json(s.into()),
        _ => Value::Text(s.into()),
    }
}

/// Tokenize target identifiers without interpreting string contents. Used only for conservative write restrictions.
fn sql_words(sql: &str) -> Result<Vec<String>, Error> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut words = vec![];
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b.get(i..i + 2) == Some(b"--") || b[i] == b'#' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b.get(i..i + 2) == Some(b"/*") {
            i += 2;
            while i + 1 < b.len() && b.get(i..i + 2) != Some(b"*/") {
                i += 1;
            }
            i = (i + 2).min(b.len());
            continue;
        }
        if matches!(b[i], b'\'' | b'"' | b'`') {
            let q = b[i];
            i += 1;
            let mut value = vec![];
            let mut closed = false;
            while i < b.len() {
                if b[i] == q {
                    i += 1;
                    if b.get(i) == Some(&q) {
                        value.push(q);
                        i += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    value.push(b[i]);
                    i += 1;
                }
            }
            if !closed {
                return Err(Error::new("SQL_PARSE", "Unterminated SQL quote."));
            }
            if q != b'\'' {
                words.push(
                    String::from_utf8(value)
                        .map_err(|_| Error::new("SQL_PARSE", "Invalid identifier."))?,
                );
            } else {
                words.push("<literal>".into());
            }
            continue;
        }
        let start = i;
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] >= 128 {
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 128)
            {
                i += 1;
            }
        } else {
            i += 1;
        }
        words.push(sql[start..i].into());
    }
    Ok(words)
}
/// Adapt numbered application placeholders without inspecting/substituting bound values.
fn parameters(sql: &str, params: &[Value]) -> Result<(String, Vec<Value>), Error> {
    let b = sql.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut values = vec![];
    let mut i = 0;
    let mut anonymous = 0;
    let mut bytes = 0usize;
    while i < b.len() {
        let start = i;
        if matches!(b[i], b'\'' | b'"' | b'`') {
            let q = b[i];
            i += 1;
            loop {
                if i >= b.len() {
                    return Err(Error::new("SQL_PARSE", "Unterminated SQL quote."));
                }
                if b[i] == q {
                    i += 1;
                    if b.get(i) == Some(&q) {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if b.get(i..i + 2) == Some(b"--") || b[i] == b'#' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b.get(i..i + 2) == Some(b"/*") {
            i += 2;
            while i + 1 < b.len() && b.get(i..i + 2) != Some(b"*/") {
                i += 1;
            }
            i = (i + 2).min(b.len());
        } else if b[i] == b'?' {
            i += 1;
            let n = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let index = if i > n {
                sql[n..i]
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
            } else {
                let n = anonymous;
                anonymous += 1;
                Some(n)
            }
            .ok_or_else(|| Error::new("UNBOUND_PARAMETERS", "Invalid parameter index."))?;
            let value = params
                .get(index)
                .ok_or_else(|| Error::new("UNBOUND_PARAMETERS", "Provide every SQL parameter."))?;
            bytes = bytes.saturating_add(
                serde_json::to_vec(value)
                    .map_err(|_| Error::new("VALUE", "Could not encode parameter."))?
                    .len(),
            );
            if values.len() >= 30000 || bytes > 4 * 1024 * 1024 {
                return Err(Error::new(
                    "PARAMETER_LIMIT",
                    "Bound parameter expansion exceeds 30,000 values or 4 MiB.",
                ));
            }
            anonymous = anonymous.max(index + 1);
            values.push(value.clone());
            out.push(b'?');
            continue;
        } else {
            i += 1;
        }
        out.extend_from_slice(&b[start..i]);
    }
    if values.is_empty() && !params.is_empty() {
        return Err(Error::new(
            "UNBOUND_PARAMETERS",
            "The query has no parameter placeholders.",
        ));
    }
    Ok((
        String::from_utf8(out).map_err(|_| Error::new("SQL_PARSE", "Invalid SQL encoding."))?,
        values,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connector_abi() {
        #[cfg(all(target_pointer_width = "64", target_os = "linux"))]
        {
            assert_eq!(std::mem::size_of::<Bind>(), 112);
            assert_eq!(std::mem::size_of::<Field>(), 128);
            assert_eq!(std::mem::offset_of!(Bind, buffer_type), 96);
            assert_eq!(std::mem::offset_of!(Field, kind), 112);
        }
        if let Err(error) = Api::load() {
            assert_eq!(error.code, "MYSQL_DRIVER");
        }
    }
    #[test]
    fn parameters_are_native_and_quotes_opaque() {
        let (s, p) = parameters(
            "SELECT ?2, '?1', \"?3\", ?1 -- ?7",
            &[
                Value::Integer("1".into()),
                Value::Text("';DROP TABLE x".into()),
            ],
        )
        .unwrap();
        assert_eq!(s, "SELECT ?, '?1', \"?3\", ? -- ?7");
        assert_eq!(p[0], Value::Text("';DROP TABLE x".into()));
        assert!(parameters("SELECT ?0", &[]).is_err());
    }
    #[test]
    fn configuration_requires_explicit_tls_and_redacts_credentials() {
        let mut config:ConnectionConfig=serde_json::from_value(serde_json::json!({"id":"test","name":"Test","driver":"mysql","environment":"development","host":"localhost","port":3306,"database":"db","username":"user","password":"never-serialize"})).unwrap();
        assert!(config.validate().is_err());
        config.ssl_mode = "require".into();
        assert!(config.validate().is_ok());
        assert!(
            !serde_json::to_string(&config)
                .unwrap()
                .contains("never-serialize")
        );
        config.port = 0;
        assert!(config.validate().is_err());
        assert_eq!(
            sql_words("UPDATE `名.前` SET x='LOAD_FILE' /* OUTFILE */").unwrap()[1],
            "名.前"
        );
        assert_eq!(
            sql_words("SELECT `LOAD_FILE`('x')").unwrap()[1],
            "LOAD_FILE"
        );
    }
    #[test]
    fn typed_values() {
        assert_eq!(
            decode(8, 63, b"18446744073709551615"),
            Value::Integer("18446744073709551615".into())
        );
        assert_eq!(
            decode(246, 63, b"1.00000000000000000001"),
            Value::Decimal("1.00000000000000000001".into())
        );
        assert_eq!(decode(252, 63, &[0, 255]), Value::Binary("AP8=".into()));
    }
    #[test]
    #[ignore = "Requires libmariadbd and mariadb-install-db; uses a fresh disposable embedded server without sockets"]
    fn embedded_native_statement_fixture() {
        unsafe {
            let path =
                std::env::temp_dir().join(format!("kitsune-mariadb-test-{}", uuid::Uuid::new_v4()));
            let initialized = std::process::Command::new("mariadb-install-db")
                .arg(format!("--datadir={}", path.display()))
                .args(["--auth-root-authentication-method=normal", "--skip-test-db"])
                .output()
                .unwrap();
            assert!(
                initialized.status.success(),
                "Could not initialize disposable MariaDB fixture"
            );
            let library = Library::new("libmariadbd.so.19").unwrap();
            let init = *library
                .get::<unsafe extern "C" fn(c_int, *mut *mut c_char, *mut *mut c_char) -> c_int>(
                    b"mysql_server_init\0",
                )
                .unwrap();
            let args = [
                c("kitsune-test").unwrap(),
                c(&format!("--datadir={}", path.display())).unwrap(),
                c("--skip-grant-tables").unwrap(),
                c("--skip-networking").unwrap(),
                c("--innodb-buffer-pool-size=32M").unwrap(),
            ];
            let mut pointers = args
                .iter()
                .map(|s| s.as_ptr() as *mut c_char)
                .collect::<Vec<_>>();
            pointers.push(std::ptr::null_mut());
            assert_eq!(
                init(
                    args.len() as c_int,
                    pointers.as_mut_ptr(),
                    std::ptr::null_mut()
                ),
                0
            );
            let end = *library
                .get::<unsafe extern "C" fn()>(b"mysql_server_end\0")
                .unwrap();
            let api = Api::from_library(library).unwrap();
            struct Server {
                _api: Arc<Api>,
                end: unsafe extern "C" fn(),
                path: std::path::PathBuf,
            }
            impl Drop for Server {
                fn drop(&mut self) {
                    unsafe { (self.end)() }
                    let _ = std::fs::remove_dir_all(&self.path);
                    // Embedded server callbacks outlive server_end; retain code until process exit.
                    std::mem::forget(self._api.clone());
                }
            }
            let _server = Server {
                _api: api.clone(),
                end,
                path,
            };
            let _thread = Thread::enter(&api).unwrap();
            let ptr = (api.init)(std::ptr::null_mut());
            assert!(!ptr.is_null());
            assert_eq!((api.options)(ptr, 15, std::ptr::null()), 0);
            assert!(
                !(api.connect)(
                    ptr,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    2
                )
                .is_null()
            );
            let config:ConnectionConfig=serde_json::from_value(serde_json::json!({"id":"fixture","name":"Fixture","driver":"mysql","environment":"development","host":"localhost","database":"kitsune_fixture","username":"root","sslMode":"disable"})).unwrap();
            let cancel = Arc::new(Cancel {
                api: api.clone(),
                config,
                id: 0,
                active: Mutex::new(CancelState::default()),
            });
            let mut db = Mysql {
                api,
                connection: ptr,
                transaction_open: false,
                cancel,
                generation: 0,
            };
            db.command("SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'")
                .unwrap();
            db.command("CREATE DATABASE IF NOT EXISTS kitsune_fixture")
                .unwrap();
            db.command("USE kitsune_fixture").unwrap();
            db.command("DROP TABLE IF EXISTS child").unwrap();
            db.command("DROP TABLE IF EXISTS samples").unwrap();
            db.command("CREATE TABLE samples(a BIGINT,b VARCHAR(100),amount DECIMAL(30,20),payload BLOB,PRIMARY KEY(a,b)) ENGINE=InnoDB").unwrap();
            db.command("CREATE TABLE child(id INT PRIMARY KEY,a BIGINT,b VARCHAR(100), FOREIGN KEY(a,b) REFERENCES samples(a,b)) ENGINE=InnoDB").unwrap();
            let inserted = db
                .query_checked(
                    "INSERT INTO samples VALUES(?1,?2,?3,?4)",
                    &[
                        Value::Integer("9223372036854775807".into()),
                        Value::Text("'; DROP TABLE samples;--".into()),
                        Value::Decimal("1.12345678901234567890".into()),
                        Value::Binary("AP8=".into()),
                    ],
                    100,
                    false,
                    5,
                    Some(1),
                )
                .unwrap();
            assert_eq!(inserted.affected, 1);
            let result = db
                .query_checked(
                    "SELECT * FROM samples WHERE a=?1 LIMIT ?2",
                    &[
                        Value::Integer("9223372036854775807".into()),
                        Value::Integer("100".into()),
                    ],
                    100,
                    true,
                    5,
                    None,
                )
                .unwrap();
            assert_eq!(result.rows.len(), 1);
            assert_eq!(
                result.rows[0][0],
                Value::Integer("9223372036854775807".into())
            );
            assert_eq!(
                result.rows[0][2],
                Value::Decimal("1.12345678901234567890".into())
            );
            assert_eq!(result.rows[0][3], Value::Binary("AP8=".into()));
            assert!(
                db.query_checked("UPDATE samples SET amount=0", &[], 1, true, 5, None)
                    .is_err()
            );
            let mut database = super::super::Database::new(super::super::Driver::Mysql(db));
            let tables = database.tables().unwrap();
            assert_eq!(tables.len(), 2);
            let sample = tables.iter().find(|t| t.name == "samples").unwrap();
            let meta = database.metadata(sample).unwrap();
            assert_eq!(meta.columns.iter().filter(|c| c.pk > 0).count(), 2);
            let request: BrowseRequest = serde_json::from_value(
                serde_json::json!({"connectionId":"fixture","table":sample,"limit":100}),
            )
            .unwrap();
            let before = database.browse(&request).unwrap();
            assert_eq!(before.rows.len(), 1);
            let key = super::super::record_key(&meta, &before.rows[0], &before.columns);
            let record = RecordRef {
                connection_id: "fixture".into(),
                table: sample.clone(),
                key,
            };
            if let super::super::Driver::Mysql(db) = &mut database.driver {
                *db.cancel.active.lock().unwrap() = CancelState {
                    generation: Some(999),
                    requested: true,
                };
                assert_eq!(
                    db.query_inner("UPDATE samples SET amount=0", &[], 1)
                        .unwrap_err()
                        .code,
                    "INTERRUPTED"
                );
                *db.cancel.active.lock().unwrap() = CancelState::default();
            }
            assert_eq!(database.browse(&request).unwrap().rows, before.rows);
            let previous = before.rows[0][2].clone();
            let changed = Value::Decimal("2.00000000000000000000".into());
            database
                .update_cell(&record, "amount", &previous, &changed)
                .unwrap();
            assert_eq!(
                database
                    .update_cell(&record, "amount", &previous, &changed)
                    .unwrap_err()
                    .code,
                "EDIT_CONFLICT"
            );
            let after = database.browse(&request).unwrap();
            assert_eq!(after.rows[0][2], changed);
            let watch:Watch=serde_json::from_value(serde_json::json!({"id":"watch","name":"Fixture","connectionId":"fixture","kind":"table","table":sample,"intervalSeconds":2,"capture":"full"})).unwrap();
            let before = crate::monitor::snapshot(&watch, before, Some(&meta)).unwrap();
            let after = crate::monitor::snapshot(&watch, after, Some(&meta)).unwrap();
            assert_eq!(
                crate::monitor::differences(&watch, &before, &after).len(),
                1
            );
            assert!(
                database
                    .query_checked("UPDATE samples SET amount=0", &[], 1, false, 5, Some(2))
                    .is_err()
            );
            assert_eq!(database.browse(&request).unwrap().rows[0][2], changed);
            assert!(database.restore_schema(sample).is_ok());
            assert!(
                database
                    .query("SELECT LOAD_FILE('/etc/passwd')", &[], 1, true, 5)
                    .is_err()
            );
            let incoming = database.incoming_foreign_keys(sample, &meta).unwrap();
            assert_eq!(incoming[0].columns, vec!["a", "b"]);
            assert!(
                database
                    .table_definition(sample)
                    .unwrap()
                    .unwrap()
                    .contains("CREATE TABLE")
            );
            // Validate the same bootstrap SQL used by the live Docker fixtures against MariaDB.
            if let super::super::Driver::Mysql(db) = &mut database.driver {
                db.command("CREATE DATABASE kitsune_network_fixture")
                    .unwrap();
                db.command("USE kitsune_network_fixture").unwrap();
                for statement in
                    crate::safety::statements(include_str!("../../../tests/fixtures/mysql.sql"))
                        .unwrap()
                {
                    db.command(&statement).unwrap();
                }
                let exact = db
                    .query_checked(
                        "SELECT id,amount,empty_text,null_text,payload FROM exact_values",
                        &[],
                        10,
                        true,
                        5,
                        None,
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
                assert_eq!(exact.rows[0][4], Value::Binary("AP+A".into()));
            }
        }
    }
}
