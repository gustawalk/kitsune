//! MySQL/MariaDB wire protocol and TLS are owned by a bounded Rust worker.
use crate::model::*;
use base64::Engine;
use mysql_async::consts::{ColumnType, StatusFlags};
use mysql_async::{Conn, OptsBuilder, Params, SslOpts, Value as Wire, prelude::Queryable};
use std::{
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

#[derive(Default)]
struct Cancellation {
    active: bool,
    requested: bool,
}
pub struct Cancel {
    state: Mutex<Cancellation>,
    wake: Notify,
}
impl Cancel {
    pub fn cancel(&self) {
        if let Ok(mut s) = self.state.lock()
            && s.active
        {
            s.requested = true;
            self.wake.notify_one();
        }
    }
    async fn requested(&self) {
        loop {
            let n = self.wake.notified();
            if self.state.lock().map_or(true, |s| s.requested) {
                return;
            }
            n.await;
        }
    }
}
enum Work {
    Managed {
        sql: String,
        params: Vec<Value>,
        limit: usize,
        read_only: bool,
        timeout: u64,
        expected: Option<u64>,
    },
    Native {
        read_only: bool,
        sql: String,
        params: Vec<Value>,
        limit: usize,
        timeout: u64,
    },
    Begin(bool),
    End(bool),
    Close,
}
struct Reply {
    results: Vec<ResultSet>,
    transaction: bool,
}
struct Job {
    work: Work,
    reply: mpsc::SyncSender<Result<Reply, Error>>,
}
pub struct Mysql {
    sender: mpsc::Sender<Job>,
    worker: Option<std::thread::JoinHandle<()>>,
    cancel: Arc<Cancel>,
    pub transaction_active: bool,
}
fn failure(error: impl std::fmt::Display) -> Error {
    // Driver details can contain server SQL/data. Preserve categories, never raw messages.
    let text = error.to_string().to_ascii_lowercase();
    let code = if text.contains("certificate") || text.contains("cert") || text.contains("tls") {
        "TLS_CERTIFICATE"
    } else if text.contains("1045") || text.contains("access denied") {
        "AUTHENTICATION"
    } else if text.contains("1062")
        || text.contains("1451")
        || text.contains("1452")
        || text.contains("1048")
    {
        "CONSTRAINT"
    } else if text.contains("1317") || text.contains("interrupted") {
        "INTERRUPTED"
    } else if text.contains("2002")
        || text.contains("2003")
        || text.contains("refused")
        || text.contains("closed")
        || text.contains("broken pipe")
    {
        "CONNECTION_LOST"
    } else {
        "MYSQL"
    };
    Error::new(
        code,
        match code {
            "TLS_CERTIFICATE" => {
                "TLS failed. Check the trusted CA, certificate validity and server hostname. No insecure fallback was attempted."
            }
            "AUTHENTICATION" => {
                "MySQL/MariaDB authentication failed. Check the username and password."
            }
            "CONSTRAINT" => "The operation violates a database constraint.",
            "CONNECTION_LOST" => "MySQL/MariaDB is unavailable or its connection closed.",
            "INTERRUPTED" => "The database interrupted the operation.",
            _ => {
                "MySQL/MariaDB rejected the operation. Check SQL syntax, permissions and server compatibility."
            }
        },
    )
}
async fn connect(config: &ConnectionConfig) -> Result<Conn, Error> {
    let mut options = OptsBuilder::default()
        .ip_or_hostname(&config.host)
        .tcp_port(config.port)
        .user(Some(config.username.clone()))
        .pass(Some(config.password.clone()))
        .db_name(Some(config.database.clone()))
        .prefer_socket(false)
        .client_found_rows(true);
    if config.ssl_mode != "disable" {
        let strict = config.ssl_mode == "verify-full";
        let mut ssl = SslOpts::default()
            .with_danger_accept_invalid_certs(!strict)
            .with_danger_skip_domain_validation(!strict);
        if !config.tls_ca_path.is_empty() {
            let bytes = std::fs::read(&config.tls_ca_path)
                .map_err(|_| Error::new("TLS_FILE", "Cannot read the selected CA certificate."))?;
            ssl = ssl
                .with_disable_built_in_roots(true)
                .with_root_certs(vec![bytes.into()]);
        } else {
            let roots = rustls_native_certs::load_native_certs()
                .certs
                .into_iter()
                .map(|c| c.as_ref().to_vec().into())
                .collect();
            ssl = ssl.with_root_certs(roots);
        }
        if config.tls_cert_path.is_empty() != config.tls_key_path.is_empty() {
            return Err(Error::new(
                "TLS_FILE",
                "Select both a client certificate and private key.",
            ));
        }
        if !config.tls_cert_path.is_empty() {
            ssl = ssl.with_client_identity(Some(mysql_async::ClientIdentity::new(
                std::path::PathBuf::from(&config.tls_cert_path).into(),
                std::path::PathBuf::from(&config.tls_key_path).into(),
            )));
        }
        options = options.ssl_opts(ssl);
    }
    let mut conn = Conn::new(options).await.map_err(failure)?;
    // Keep existing application-generated ANSI quoting; this affects this session only.
    conn.query_drop(
        "SET SESSION sql_mode=CONCAT_WS(',',@@sql_mode,'ANSI_QUOTES','NO_BACKSLASH_ESCAPES')",
    )
    .await
    .map_err(failure)?;
    if config.read_only || config.environment == "production" {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY")
            .await
            .map_err(failure)?;
    }
    Ok(conn)
}
impl Mysql {
    pub fn open(config: &ConnectionConfig) -> Result<Self, Error> {
        let config = config.clone();
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready, wait) = mpsc::sync_channel(1);
        let cancel = Arc::new(Cancel {
            state: Mutex::new(Cancellation::default()),
            wake: Notify::new(),
        });
        let operation = cancel.clone();
        let worker = std::thread::Builder::new()
            .name("kitsune-mysql".into())
            .spawn(move || worker_loop(config, rx, ready, operation))
            .map_err(failure)?;
        match wait.recv().map_err(failure)? {
            Ok(()) => Ok(Self {
                sender: tx,
                worker: Some(worker),
                cancel,
                transaction_active: false,
            }),
            Err(e) => {
                let _ = worker.join();
                Err(e)
            }
        }
    }
    fn call(&mut self, work: Work) -> Result<Vec<ResultSet>, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        *self.cancel.state.lock().map_err(failure)? = Cancellation {
            active: true,
            requested: false,
        };
        self.sender.send(Job { work, reply: tx }).map_err(failure)?;
        let reply = rx.recv().map_err(failure)??;
        self.transaction_active = reply.transaction;
        Ok(reply.results)
    }
    pub fn cancel_handle(&self) -> Arc<Cancel> {
        self.cancel.clone()
    }
    pub(super) fn restore_begin(&mut self, read_only: bool) -> Result<(), Error> {
        self.call(Work::Begin(read_only)).map(|_| ())
    }
    pub(super) fn restore_end(&mut self, commit: bool) -> Result<(), Error> {
        self.call(Work::End(commit)).map(|_| ())
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
        if read_only {
            crate::mysql_sql::validate(sql, true, false)?;
        }
        let mut results = self.call(Work::Managed {
            sql: sql.into(),
            params: params.to_vec(),
            limit,
            read_only,
            timeout,
            expected,
        })?;
        Ok(if results.is_empty() {
            ResultSet::empty()
        } else {
            results.remove(0)
        })
    }
    pub fn native(
        &mut self,
        sql: &str,
        params: &[Value],
        limit: usize,
        timeout: u64,
        read_only: bool,
    ) -> Result<Vec<ResultSet>, Error> {
        self.call(Work::Native {
            read_only,
            sql: sql.into(),
            params: params.to_vec(),
            limit,
            timeout,
        })
    }
}
impl Drop for Mysql {
    fn drop(&mut self) {
        self.cancel.cancel();
        let (tx, _) = mpsc::sync_channel(1);
        let _ = self.sender.send(Job {
            work: Work::Close,
            reply: tx,
        });
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
fn worker_loop(
    config: ConnectionConfig,
    jobs: mpsc::Receiver<Job>,
    ready: mpsc::SyncSender<Result<(), Error>>,
    operation: Arc<Cancel>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(failure(error)));
            return;
        }
    };
    let opened = runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(10), connect(&config)).await });
    let mut client = match opened {
        Ok(Ok(conn)) => {
            let _ = ready.send(Ok(()));
            Some(conn)
        }
        Ok(Err(error)) => {
            let _ = ready.send(Err(error));
            return;
        }
        Err(_) => {
            let _ = ready.send(Err(Error::new(
                "CONNECTION_TIMEOUT",
                "MySQL/MariaDB connection timed out.",
            )));
            return;
        }
    };
    let (mut owned, mut lost) = (false, false);
    for job in jobs {
        if matches!(job.work, Work::Close) {
            break;
        }
        let timeout = match &job.work {
            Work::Managed { timeout, .. } | Work::Native { timeout, .. } => *timeout,
            _ => 30,
        }
        .clamp(1, 300);
        let writes = matches!(
            &job.work,
            Work::Managed {
                read_only: false,
                ..
            } | Work::Native {
                read_only: false,
                ..
            } | Work::End(true)
        );
        let result = runtime.block_on(async {
            tokio::select! {
                biased;
                _ = operation.requested() => Err(Error::new(if writes { "OUTCOME_UNCERTAIN" } else { "INTERRUPTED" }, "The client connection closed. Server cancellation is not confirmed; verify writes before retrying.")),
                _ = tokio::time::sleep(Duration::from_secs(timeout)) => Err(Error::new(if writes { "OUTCOME_UNCERTAIN" } else { "QUERY_TIMEOUT" }, "Execution timed out and the client connection closed. Writes must not be retried automatically.")),
                result = async {
                    if matches!(&job.work, Work::End(false)) && lost {
                        lost = false; owned = false;
                        return Ok(Reply { results: vec![], transaction: false });
                    }
                    if client.is_none() {
                        if lost { return Err(Error::new("TRANSACTION_LOST", "The transaction's connection was lost. Close this SQL session; unconfirmed writes must be checked.")); }
                        client = Some(connect(&config).await?);
                    }
                    run(client.as_mut().unwrap(), job.work, &mut owned).await
                } => result,
            }
        });
        if result.is_err() {
            if let Some(ref conn) = client {
                let id = conn.id();
                // Keep ownership of the old connection until this bounded request finishes.
                // A late cancellation must never target a reused server connection ID.
                runtime.block_on(async {
                    let _ = tokio::time::timeout(Duration::from_secs(2), async {
                        if let Ok(mut control) = connect(&config).await {
                            let _ = control.query_drop(format!("KILL QUERY {id}")).await;
                        }
                    })
                    .await;
                });
            }
            lost = owned || client.as_ref().is_some_and(in_transaction);
            client.take();
            owned = false;
        }
        if let Ok(mut state) = operation.state.lock() {
            state.active = false;
        }
        let _ = job.reply.send(result);
    }
}
fn in_transaction(conn: &Conn) -> bool {
    conn.last_ok_packet().is_some_and(|p| {
        p.status_flags()
            .contains(StatusFlags::SERVER_STATUS_IN_TRANS)
    })
}
async fn run(conn: &mut Conn, work: Work, owned: &mut bool) -> Result<Reply, Error> {
    let results = match work {
        Work::Begin(read_only) => {
            conn.query_drop("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                .await
                .map_err(failure)?;
            conn.query_drop(if read_only {
                "START TRANSACTION READ ONLY"
            } else {
                "START TRANSACTION"
            })
            .await
            .map_err(failure)?;
            *owned = true;
            vec![]
        }
        Work::End(commit) => {
            conn.query_drop(if commit { "COMMIT" } else { "ROLLBACK" })
                .await
                .map_err(|_| {
                    Error::new(
                        "OUTCOME_UNCERTAIN",
                        "The server did not confirm transaction completion. Verify current data.",
                    )
                })?;
            *owned = false;
            vec![]
        }
        Work::Native {
            mut sql,
            params,
            limit,
            read_only,
            ..
        } => {
            if read_only && ["BEGIN", "START"].contains(&crate::safety::first_word(&sql).as_str()) {
                sql = "START TRANSACTION READ ONLY".into();
            }
            execute(conn, &sql, &params, limit).await?
        }
        Work::Managed {
            sql,
            params,
            limit,
            read_only,
            expected,
            ..
        } => {
            let start = !*owned;
            if start {
                conn.query_drop(if read_only {
                    "START TRANSACTION READ ONLY"
                } else {
                    "START TRANSACTION"
                })
                .await
                .map_err(failure)?;
            }
            let result = execute(conn, &sql, &params, limit).await;
            let result = result.and_then(|r| {
                if expected.is_some_and(|n| r.first().map_or(0, |r| r.affected) != n) {
                    Err(Error::new(
                        "WRITE_CONFLICT",
                        "The affected-row count changed; the write was rolled back.",
                    ))
                } else {
                    Ok(r)
                }
            });
            if start {
                conn.query_drop(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                    .await
                    .map_err(|_| {
                        Error::new(
                            "OUTCOME_UNCERTAIN",
                            "The server did not confirm the transaction outcome.",
                        )
                    })?;
            }
            result?
        }
        Work::Close => vec![],
    };
    Ok(Reply {
        results,
        transaction: in_transaction(conn),
    })
}
fn parameters(sql: &str, params: &[Value]) -> Result<(String, Params), Error> {
    let mut output = String::new();
    let mut bound = Vec::new();
    let mut chars = sql.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        output.push(c);
        match c {
            '\'' | '"' | '`' => {
                while let Some((_, v)) = chars.next() {
                    output.push(v);
                    if v == c {
                        if chars.peek().is_some_and(|(_, n)| *n == c) {
                            output.push(chars.next().unwrap().1)
                        } else {
                            break;
                        }
                    }
                }
            }
            '-' if chars.peek().is_some_and(|(_, v)| *v == '-') => {
                for (_, v) in chars.by_ref() {
                    output.push(v);
                    if v == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek().is_some_and(|(_, v)| *v == '*') => {
                let mut prev = ' ';
                for (_, v) in chars.by_ref() {
                    output.push(v);
                    if prev == '*' && v == '/' {
                        break;
                    }
                    prev = v;
                }
            }
            '?' => {
                let mut number = String::new();
                while chars.peek().is_some_and(|(_, v)| v.is_ascii_digit()) {
                    number.push(chars.next().unwrap().1)
                }
                let index = if number.is_empty() {
                    bound.len()
                } else {
                    number
                        .parse::<usize>()
                        .map_err(failure)?
                        .checked_sub(1)
                        .ok_or_else(|| Error::new("PARAMETER", "Parameters start at ?1."))?
                };
                bound.push(wire(params.get(index).ok_or_else(|| {
                    Error::new("PARAMETER", "A bound value is missing.")
                })?)?);
            }
            _ => {}
        }
    }
    Ok((output, Params::Positional(bound)))
}
fn wire(value: &Value) -> Result<Wire, Error> {
    Ok(match value {
        Value::Null => Wire::NULL,
        Value::Boolean(v) => Wire::Int(i64::from(*v)),
        Value::Integer(v) => {
            if let Ok(n) = v.parse::<i64>() {
                Wire::Int(n)
            } else if let Ok(n) = v.parse::<u64>() {
                Wire::UInt(n)
            } else {
                Wire::Bytes(v.as_bytes().to_vec())
            }
        }
        Value::Binary(v) => Wire::Bytes(
            base64::engine::general_purpose::STANDARD
                .decode(v)
                .map_err(failure)?,
        ),
        _ => Wire::Bytes(value.text().unwrap_or_default().into_bytes()),
    })
}
fn value(v: Wire, column: &mysql_async::Column) -> Value {
    match v {
        Wire::NULL => Value::Null,
        Wire::Int(n) => Value::Integer(n.to_string()),
        Wire::UInt(n) => Value::Integer(n.to_string()),
        Wire::Float(n) => Value::Float(n.to_string()),
        Wire::Double(n) => Value::Float(n.to_string()),
        Wire::Bytes(bytes) => {
            let ty = column.column_type();
            if matches!(
                ty,
                ColumnType::MYSQL_TYPE_TINY
                    | ColumnType::MYSQL_TYPE_SHORT
                    | ColumnType::MYSQL_TYPE_LONG
                    | ColumnType::MYSQL_TYPE_LONGLONG
                    | ColumnType::MYSQL_TYPE_INT24
                    | ColumnType::MYSQL_TYPE_YEAR
            ) {
                Value::Integer(String::from_utf8_lossy(&bytes).into())
            } else if matches!(
                ty,
                ColumnType::MYSQL_TYPE_FLOAT | ColumnType::MYSQL_TYPE_DOUBLE
            ) {
                Value::Float(String::from_utf8_lossy(&bytes).into())
            } else if matches!(
                ty,
                ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL
            ) {
                Value::Decimal(String::from_utf8_lossy(&bytes).into())
            } else if ty == ColumnType::MYSQL_TYPE_JSON {
                Value::Json(String::from_utf8_lossy(&bytes).into())
            } else if matches!(
                ty,
                ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE
            ) {
                Value::Date(String::from_utf8_lossy(&bytes).into())
            } else if matches!(
                ty,
                ColumnType::MYSQL_TYPE_DATETIME
                    | ColumnType::MYSQL_TYPE_TIMESTAMP
                    | ColumnType::MYSQL_TYPE_DATETIME2
                    | ColumnType::MYSQL_TYPE_TIMESTAMP2
            ) {
                Value::Timestamp(String::from_utf8_lossy(&bytes).into())
            } else if matches!(
                ty,
                ColumnType::MYSQL_TYPE_TIME | ColumnType::MYSQL_TYPE_TIME2
            ) {
                Value::Text(String::from_utf8_lossy(&bytes).into())
            } else if column.character_set() == 63 {
                Value::Binary(base64::engine::general_purpose::STANDARD.encode(bytes))
            } else {
                match String::from_utf8(bytes) {
                    Ok(s) => Value::Text(s),
                    Err(e) => Value::Binary(
                        base64::engine::general_purpose::STANDARD.encode(e.into_bytes()),
                    ),
                }
            }
        }
        Wire::Date(y, m, d, h, i, s, us) => {
            let date = format!("{y:04}-{m:02}-{d:02}");
            if column.column_type() == ColumnType::MYSQL_TYPE_DATE {
                Value::Date(date)
            } else {
                Value::Timestamp(format!(
                    "{date} {h:02}:{i:02}:{s:02}{}",
                    fractional(us, column.decimals())
                ))
            }
        }
        Wire::Time(neg, days, h, m, s, us) => Value::Text(format!(
            "{}{:02}:{m:02}:{s:02}{}",
            if neg { "-" } else { "" },
            u64::from(days) * 24 + u64::from(h),
            fractional(us, column.decimals())
        )),
    }
}
fn fractional(us: u32, precision: u8) -> String {
    let precision = usize::from(precision.min(6));
    if precision == 0 {
        String::new()
    } else {
        format!(".{}", &format!("{us:06}")[..precision])
    }
}
async fn execute(
    conn: &mut Conn,
    sql: &str,
    params: &[Value],
    limit: usize,
) -> Result<Vec<ResultSet>, Error> {
    let (sql, params) = parameters(sql, params)?;
    let start = Instant::now();
    if matches!(&params,Params::Positional(p) if p.is_empty())
        && !["SELECT", "WITH", "VALUES", "SHOW", "EXPLAIN"]
            .contains(&crate::safety::first_word(&sql).as_str())
    {
        collect(conn.query_iter(sql).await.map_err(failure)?, limit, start).await
    } else {
        collect(
            conn.exec_iter(sql, params).await.map_err(failure)?,
            limit,
            start,
        )
        .await
    }
}
async fn collect<P: mysql_async::prelude::Protocol>(
    mut result: mysql_async::QueryResult<'_, '_, P>,
    limit: usize,
    start: Instant,
) -> Result<Vec<ResultSet>, Error> {
    let mut results = Vec::new();
    let mut bytes = 0usize;
    loop {
        let columns = result.columns_ref().to_vec();
        let mut set = ResultSet::empty();
        set.columns = columns.iter().map(|c| c.name_str().into_owned()).collect();
        set.types = columns
            .iter()
            .map(|c| {
                format!("{:?}", c.column_type())
                    .trim_start_matches("MYSQL_TYPE_")
                    .to_owned()
            })
            .collect();
        set.affected = result.affected_rows();
        while let Some(row) = result.next().await.map_err(failure)? {
            if set.rows.len() >= limit {
                return Err(Error::new(
                    "RESULT_LIMIT",
                    "Result limit reached; the connection was discarded instead of draining unbounded results. Writes may already have completed.",
                ));
            }
            let values: Vec<Value> = row
                .unwrap()
                .into_iter()
                .zip(columns.iter())
                .map(|(v, c)| value(v, c))
                .collect();
            bytes += serde_json::to_vec(&values).map_err(failure)?.len();
            if bytes > 10 * 1024 * 1024 {
                return Err(Error::new(
                    "RESULT_LIMIT",
                    "Results exceed 10 MiB; the connection was discarded. Writes may already have completed.",
                ));
            }
            set.rows.push(values);
        }
        set.duration_ms = start.elapsed().as_millis() as u64;
        results.push(set);
        if result.is_empty() {
            break;
        }
        if results.len() >= 100 {
            return Err(Error::new(
                "RESULT_LIMIT",
                "A call returned more than 100 result sets.",
            ));
        }
    }
    result.drop_result().await.map_err(failure)?;
    Ok(results)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binds_opaque_strings_and_exact_values() {
        let (sql, p) = parameters(
            "SELECT '?1', ?2, ?1",
            &[Value::Integer("18446744073709551615".into()), Value::Null],
        )
        .unwrap();
        assert_eq!(sql, "SELECT '?1', ?, ?");
        assert!(matches!(p,Params::Positional(v) if v==vec![Wire::NULL,Wire::UInt(u64::MAX)]));
    }
}
