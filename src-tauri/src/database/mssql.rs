//! SQL Server via Tiberius/TDS. A worker owns the asynchronous connection, never credentials in JS.
use crate::model::*;
use base64::Engine;
use futures_util::TryStreamExt;
use sqlparser::{
    ast::{Expr, ObjectName, Query as AstQuery, SetExpr, Statement, TableFactor, Visit, Visitor},
    dialect::MsSqlDialect,
    parser::Parser,
};
use std::{
    ops::ControlFlow,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, Query};
use tokio::{net::TcpStream, sync::Notify};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
type Tds = Client<Compat<TcpStream>>;
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
        if let Ok(mut state) = self.state.lock()
            && state.active
        {
            state.requested = true;
            self.wake.notify_one();
        }
    }
    async fn requested(&self) {
        loop {
            let notified = self.wake.notified();
            if self.state.lock().map_or(true, |s| s.requested) {
                return;
            }
            notified.await;
        }
    }
}
enum Work {
    Explain {
        sql: String,
        params: Vec<Value>,
    },
    Query {
        sql: String,
        params: Vec<Value>,
        limit: usize,
        read_only: bool,
        timeout: u64,
        expected: Option<u64>,
    },
    Begin,
    End(bool),
    Close,
}
struct Job {
    work: Work,
    reply: mpsc::SyncSender<Result<ResultSet, Error>>,
}
pub struct Mssql {
    sender: mpsc::Sender<Job>,
    worker: Option<std::thread::JoinHandle<()>>,
    cancel: Arc<Cancel>,
}
fn empty() -> ResultSet {
    ResultSet {
        columns: vec![],
        types: vec![],
        rows: vec![],
        affected: 0,
        duration_ms: 0,
        truncated: false,
        next_cursor: None,
        keyset_supported: false,
    }
}
fn driver_error(_: impl std::fmt::Display) -> Error {
    Error::new(
        "SQLSERVER",
        "SQL Server rejected the operation or the connection failed. Check syntax, credentials, TLS and permissions. Driver messages are redacted.",
    )
}
impl Mssql {
    pub fn open(config: &ConnectionConfig) -> Result<Self, Error> {
        let config = config.clone();
        let (sender, receiver) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let cancel = Arc::new(Cancel {
            state: Mutex::new(Cancellation::default()),
            wake: Notify::new(),
        });
        let operation = cancel.clone();
        let worker=std::thread::Builder::new().name("kitsune-sqlserver".into()).spawn(move||{
   let runtime=match tokio::runtime::Builder::new_current_thread().enable_all().build(){Ok(r)=>r,Err(e)=>{let _=ready_tx.send(Err(driver_error(e)));return;}};
   let connection=runtime.block_on(async {tokio::time::timeout(Duration::from_secs(10),connect(&config)).await});
   let mut state=match connection{Ok(Ok(c))=>{let _=ready_tx.send(Ok(()));State{client:Some(c),config,transaction:false,lost_transaction:false}},Ok(Err(e))=>{let _=ready_tx.send(Err(e));return;},Err(_)=>{let _=ready_tx.send(Err(Error::new("CONNECTION_TIMEOUT","SQL Server connection timed out.")));return;}};
   for job in receiver{
    if matches!(job.work,Work::Close){break;}
    let timeout=match &job.work{Work::Query{timeout,..}=>*timeout,_=>30}.clamp(1,300);
    let writes=matches!(&job.work,Work::Query{read_only:false,..}|Work::End(true));
    let result=runtime.block_on(async{
     tokio::select!{
      biased;
      _=operation.requested()=>Err(Error::new(if writes{"OUTCOME_UNCERTAIN"}else{"INTERRUPTED"},if writes{"SQL Server connection closed during a write. Verify current data before retrying."}else{"SQL Server execution cancelled; connection closed. Server cancellation is not confirmed."})),
      _=tokio::time::sleep(Duration::from_secs(timeout))=>Err(Error::new(if writes{"OUTCOME_UNCERTAIN"}else{"QUERY_TIMEOUT"},"SQL Server execution timed out. The connection was closed; do not automatically repeat writes.")),
      result=state.run(job.work)=>result,
     }
    });
    if result.is_err(){state.client.take();state.lost_transaction=state.transaction;state.transaction=false;}
    if let Ok(mut s)=operation.state.lock(){s.active=false;}
    let _=job.reply.send(result);
   }
  }).map_err(driver_error)?;
        match ready_rx.recv().map_err(driver_error)? {
            Ok(()) => Ok(Self {
                sender,
                worker: Some(worker),
                cancel,
            }),
            Err(e) => {
                let _ = worker.join();
                Err(e)
            }
        }
    }
    fn call(&mut self, work: Work) -> Result<ResultSet, Error> {
        let (reply, receiver) = mpsc::sync_channel(1);
        *self.cancel.state.lock().map_err(driver_error)? = Cancellation {
            active: true,
            requested: false,
        };
        self.sender
            .send(Job { work, reply })
            .map_err(driver_error)?;
        receiver.recv().map_err(driver_error)?
    }
    pub fn cancel_handle(&self) -> Arc<Cancel> {
        self.cancel.clone()
    }
    pub fn explain(&mut self, sql: &str, params: &[Value]) -> Result<ResultSet, Error> {
        if params.len() > 2000 {
            return Err(Error::new(
                "PARAMETER_LIMIT",
                "SQL Server plans support at most 2,000 parameters.",
            ));
        }
        let (sql, _) = validate(sql, true)?;
        self.call(Work::Explain {
            sql,
            params: params.to_vec(),
        })
    }
    pub(super) fn restore_begin(&mut self, _read_only: bool) -> Result<(), Error> {
        self.call(Work::Begin).map(|_| ())
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
        if params.len() > 2000
            || serde_json::to_vec(params).map_or(true, |v| v.len() > 4 * 1024 * 1024)
        {
            return Err(Error::new(
                "PARAMETER_LIMIT",
                "SQL Server supports at most 2,000 bound values / 4 MiB in this client.",
            ));
        }
        let (sql, read_query) = validate(sql, read_only)?;
        self.call(Work::Query {
            sql,
            params: params.to_vec(),
            limit,
            read_only: read_query,
            timeout,
            expected,
        })
    }
}
impl Drop for Mssql {
    fn drop(&mut self) {
        self.cancel.cancel();
        let (reply, _) = mpsc::sync_channel(1);
        let _ = self.sender.send(Job {
            work: Work::Close,
            reply,
        });
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct State {
    client: Option<Tds>,
    config: ConnectionConfig,
    transaction: bool,
    lost_transaction: bool,
}
impl State {
    async fn run(&mut self, work: Work) -> Result<ResultSet, Error> {
        if self.lost_transaction {
            if matches!(work, Work::End(false)) {
                self.lost_transaction = false;
                return Ok(empty());
            }
            return Err(Error::new(
                "TRANSACTION_LOST",
                "The SQL Server transaction was interrupted. Retry the complete operation after review.",
            ));
        }
        if self.client.is_none() {
            self.client = Some(connect(&self.config).await?);
        }
        let c = self
            .client
            .as_mut()
            .ok_or_else(|| Error::new("CONNECTION_LOST", "Reconnect SQL Server."))?;
        match work {
            Work::Explain { sql, params } => {
                let declarations = params
                    .iter()
                    .enumerate()
                    .map(|(i, value)| {
                        format!(
                            "DECLARE @P{} {};",
                            i + 1,
                            match value {
                                Value::Integer(_) => "bigint",
                                Value::Boolean(_) => "bit",
                                Value::Decimal(_) => "decimal(38,20)",
                                Value::Float(_) => "float",
                                Value::Binary(_) => "varbinary(max)",
                                _ => "nvarchar(max)",
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                command(c, "SET SHOWPLAN_XML ON").await?;
                let query = format!("{declarations}\n{sql}");
                let result = match c.simple_query(query).await {
                    Ok(stream) => collect(stream, 1000, false, "").await,
                    Err(e) => Err(driver_error(e)),
                };
                command(c, "SET SHOWPLAN_XML OFF").await?;
                result
            }
            Work::Begin => {
                command(
                    c,
                    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRANSACTION",
                )
                .await?;
                self.transaction = true;
                Ok(empty())
            }
            Work::End(commit) => {
                command(c, if commit { "COMMIT" } else { "ROLLBACK" })
                    .await
                    .map_err(|_| {
                        Error::new(
                            "OUTCOME_UNCERTAIN",
                            "SQL Server did not confirm the transaction outcome.",
                        )
                    })?;
                self.transaction = false;
                Ok(empty())
            }
            Work::Query {
                sql,
                params,
                limit,
                read_only,
                expected,
                ..
            } => {
                let started = Instant::now();
                let own = !self.transaction;
                if own {
                    command(
                        c,
                        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; BEGIN TRANSACTION",
                    )
                    .await?;
                }
                let result = fetch(c, &sql, &params, limit, !read_only).await;
                let result = result.and_then(|r| {
                    if expected.is_some_and(|n| n != r.affected) {
                        Err(Error::new(
                            "MUTATION_CONFLICT",
                            "Selected rows changed. The SQL Server transaction was not committed.",
                        ))
                    } else {
                        Ok(r)
                    }
                });
                if result.is_ok() && own {
                    command(c,"COMMIT").await.map_err(|_|Error::new("OUTCOME_UNCERTAIN","SQL Server did not confirm commit. Verify current records before retrying."))?;
                } else if result.as_ref().is_err_and(|e| e.code == "RESULT_LIMIT") {
                    return result;
                } else if result.is_err() && own {
                    let _ = command(c, "ROLLBACK").await;
                }
                result.map(|mut r| {
                    r.duration_ms = started.elapsed().as_millis() as u64;
                    r
                })
            }
            Work::Close => Ok(empty()),
        }
    }
}
async fn connect(config: &ConnectionConfig) -> Result<Tds, Error> {
    let mut cfg = Config::new();
    cfg.host(&config.host);
    cfg.port(config.port);
    cfg.database(&config.database);
    cfg.application_name("Kitsune");
    cfg.authentication(AuthMethod::sql_server(&config.username, &config.password));
    cfg.encryption(if config.ssl_mode == "disable" {
        EncryptionLevel::NotSupported
    } else {
        EncryptionLevel::Required
    });
    if config.ssl_mode == "require" {
        cfg.trust_cert();
    }
    let tcp = TcpStream::connect(cfg.get_addr())
        .await
        .map_err(driver_error)?;
    tcp.set_nodelay(true).map_err(driver_error)?;
    let mut client = Client::connect(cfg, tcp.compat_write())
        .await
        .map_err(driver_error)?;
    command(
        &mut client,
        "SET QUOTED_IDENTIFIER ON; SET XACT_ABORT ON; SET NOCOUNT ON; SET LOCK_TIMEOUT 5000",
    )
    .await?;
    if config.read_only || config.environment == "production" {
        let probe=fetch(&mut client,"SELECT COUNT(*) AS n FROM sys.objects o WHERE o.is_ms_shipped=0 AND (HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','INSERT')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','UPDATE')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','DELETE')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','ALTER')=1)",&[],1,false).await?;
        let broad=fetch(&mut client,"SELECT CASE WHEN IS_SRVROLEMEMBER('sysadmin')=1 OR IS_MEMBER('db_owner')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE')=1 OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER')=1 THEN 1 ELSE 0 END AS n",&[],1,false).await?;
        if probe
            .rows
            .first()
            .and_then(|r| r.first())
            .and_then(Value::text)
            .as_deref()
            != Some("0")
            || broad
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(Value::text)
                .as_deref()
                != Some("0")
        {
            return Err(Error::new(
                "READ_ONLY_CREDENTIALS",
                "SQL Server read-only/Production mode requires a dedicated login without write/schema permissions. ApplicationIntent is not a security boundary.",
            ));
        }
    }
    Ok(client)
}
async fn command(client: &mut Tds, sql: &str) -> Result<(), Error> {
    client
        .simple_query(sql)
        .await
        .map_err(driver_error)?
        .into_results()
        .await
        .map_err(driver_error)?;
    Ok(())
}
fn decimal(value: &str) -> Result<tiberius::numeric::Numeric, Error> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if fraction.len() > 38 || whole.is_empty() || !fraction.bytes().all(|c| c.is_ascii_digit()) {
        return Err(Error::new("VALUE_RANGE", "Invalid SQL Server decimal."));
    }
    let digits = format!("{whole}{fraction}");
    let number = digits.parse::<i128>().map_err(|_| {
        Error::new(
            "VALUE_RANGE",
            "SQL Server decimals support at most 38 digits.",
        )
    })?;
    if digits.trim_start_matches(['-', '+']).len() > 38 {
        return Err(Error::new(
            "VALUE_RANGE",
            "SQL Server decimal exceeds 38 digits.",
        ));
    }
    Ok(tiberius::numeric::Numeric::new_with_scale(
        number,
        fraction.len() as u8,
    ))
}
fn numeric(value: tiberius::numeric::Numeric) -> String {
    let scale = value.scale() as usize;
    let number = value.value();
    let mut text = number.unsigned_abs().to_string();
    if scale > 0 {
        if text.len() <= scale {
            text = format!("{}{}", "0".repeat(scale + 1 - text.len()), text);
        }
        text.insert(text.len() - scale, '.');
    }
    if number < 0 {
        text.insert(0, '-');
    }
    text
}
fn bind<'a>(query: &mut Query<'a>, params: &'a [Value]) -> Result<(), Error> {
    for value in params {
        match value {
            Value::Null => query.bind(Option::<&str>::None),
            Value::Boolean(v) => query.bind(*v),
            Value::Integer(v) => {
                query.bind(v.parse::<i64>().map_err(|_| {
                    Error::new("VALUE_RANGE", "SQL Server bigint is signed 64-bit.")
                })?)
            }
            Value::Decimal(v) => query.bind(decimal(v)?),
            Value::Float(v) => query.bind(v.parse::<f64>().map_err(driver_error)?),
            Value::Binary(v) => query.bind(
                base64::engine::general_purpose::STANDARD
                    .decode(v)
                    .map_err(driver_error)?,
            ),
            _ => query.bind(value.text().unwrap_or_default()),
        }
    }
    Ok(())
}
async fn fetch(
    client: &mut Tds,
    sql: &str,
    params: &[Value],
    limit: usize,
    write: bool,
) -> Result<ResultSet, Error> {
    let marker = format!("__kitsune_{}", uuid::Uuid::new_v4().simple());
    let sql = if write {
        format!("{sql}\n; SELECT CONVERT(bigint,@@ROWCOUNT) AS [{marker}]")
    } else {
        sql.into()
    };
    let mut query = Query::new(sql);
    bind(&mut query, params)?;
    let stream = query.query(client).await.map_err(driver_error)?;
    collect(stream, limit, write, &marker).await
}
async fn collect(
    mut stream: tiberius::QueryStream<'_>,
    limit: usize,
    write: bool,
    marker: &str,
) -> Result<ResultSet, Error> {
    let mut result = empty();
    let mut affected = false;
    let mut bytes = 0;
    while let Some(item) = stream.try_next().await.map_err(driver_error)? {
        match item {
            tiberius::QueryItem::Metadata(meta) => {
                affected = write && meta.columns().len() == 1 && meta.columns()[0].name() == marker;
                if !affected {
                    if !result.columns.is_empty() {
                        return Err(Error::new(
                            "RESULT_SETS",
                            "Execute one SQL Server result set at a time.",
                        ));
                    }
                    result.columns = meta.columns().iter().map(|c| c.name().into()).collect();
                    result.types = meta
                        .columns()
                        .iter()
                        .map(|c| format!("{:?}", c.column_type()))
                        .collect();
                }
            }
            tiberius::QueryItem::Row(row) => {
                if affected {
                    result.affected =
                        row.try_get::<i64, _>(0).map_err(driver_error)?.unwrap_or(0) as u64;
                    continue;
                }
                if result.rows.len() >= limit {
                    return Err(Error::new(
                        "RESULT_LIMIT",
                        "SQL Server result exceeds the row limit. Narrow the query; execution was interrupted.",
                    ));
                }
                let values = row
                    .cells()
                    .enumerate()
                    .map(|(i, (_, v))| decode(&row, i, v))
                    .collect::<Result<Vec<_>, _>>()?;
                bytes += serde_json::to_vec(&values).map_err(driver_error)?.len();
                if bytes > crate::database::MAX_RESULT_BYTES {
                    return Err(Error::new(
                        "RESULT_LIMIT",
                        "SQL Server result exceeds 64 MiB.",
                    ));
                }
                result.rows.push(values);
            }
        }
    }
    Ok(result)
}
fn decode(row: &tiberius::Row, index: usize, value: &ColumnData<'_>) -> Result<Value, Error> {
    macro_rules! scalar {
        ($v:expr,$kind:ident) => {
            Ok($v
                .map(|v| Value::$kind(v.to_string()))
                .unwrap_or(Value::Null))
        };
    }
    match value {
        ColumnData::U8(v) => scalar!(*v, Integer),
        ColumnData::I16(v) => scalar!(*v, Integer),
        ColumnData::I32(v) => scalar!(*v, Integer),
        ColumnData::I64(v) => scalar!(*v, Integer),
        ColumnData::F32(v) => scalar!(*v, Float),
        ColumnData::F64(v) => scalar!(*v, Float),
        ColumnData::Bit(v) => Ok(v.map(Value::Boolean).unwrap_or(Value::Null)),
        ColumnData::String(v) => Ok(v
            .as_ref()
            .map(|v| Value::Text(v.to_string()))
            .unwrap_or(Value::Null)),
        ColumnData::Guid(v) => scalar!(*v, Uuid),
        ColumnData::Binary(v) => Ok(v
            .as_ref()
            .map(|v| Value::Binary(base64::engine::general_purpose::STANDARD.encode(v)))
            .unwrap_or(Value::Null)),
        ColumnData::Numeric(v) => Ok(v.map(|v| Value::Decimal(numeric(v))).unwrap_or(Value::Null)),
        ColumnData::Xml(v) => Ok(v
            .as_ref()
            .map(|v| Value::Text(v.to_string()))
            .unwrap_or(Value::Null)),
        ColumnData::Date(_) => Ok(row
            .try_get::<chrono::NaiveDate, _>(index)
            .map_err(driver_error)?
            .map(|v| Value::Date(v.to_string()))
            .unwrap_or(Value::Null)),
        ColumnData::Time(_) => Ok(row
            .try_get::<chrono::NaiveTime, _>(index)
            .map_err(driver_error)?
            .map(|v| Value::Text(v.to_string()))
            .unwrap_or(Value::Null)),
        ColumnData::DateTimeOffset(_) => Ok(row
            .try_get::<chrono::DateTime<chrono::FixedOffset>, _>(index)
            .map_err(driver_error)?
            .map(|v| Value::Timestamp(v.to_rfc3339()))
            .unwrap_or(Value::Null)),
        _ => Ok(row
            .try_get::<chrono::NaiveDateTime, _>(index)
            .map_err(driver_error)?
            .map(|v| Value::Timestamp(v.to_string()))
            .unwrap_or(Value::Null)),
    }
}
fn placeholders(sql: &str) -> Result<String, Error> {
    let b = sql.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let mut anonymous = 0;
    while i < b.len() {
        let start = i;
        if matches!(b[i], b'\'' | b'"' | b'[') {
            let end = if b[i] == b'[' { b']' } else { b[i] };
            i += 1;
            let mut closed = false;
            while i < b.len() {
                if b[i] == end {
                    i += 1;
                    if b.get(i) == Some(&end) {
                        i += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            if !closed {
                return Err(Error::new("SQL_PARSE", "Unterminated SQL Server quote."));
            }
        } else if b.get(i..i + 2) == Some(b"--") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b.get(i..i + 2) == Some(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < b.len() && depth > 0 {
                if b.get(i..i + 2) == Some(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b.get(i..i + 2) == Some(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth > 0 {
                return Err(Error::new("SQL_PARSE", "Unterminated SQL comment."));
            }
        } else if b[i] == b'?' {
            i += 1;
            let from = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let n = if from == i {
                anonymous + 1
            } else {
                sql[from..i].parse::<usize>().map_err(driver_error)?
            };
            if n == 0 || n > 30000 {
                return Err(Error::new(
                    "UNBOUND_PARAMETERS",
                    "SQL Server parameter index is invalid.",
                ));
            }
            anonymous = anonymous.max(n);
            out.extend_from_slice(format!("@P{n}").as_bytes());
            continue;
        } else {
            i += 1;
        }
        out.extend_from_slice(&b[start..i]);
    }
    String::from_utf8(out).map_err(driver_error)
}
fn validate(sql: &str, read_only: bool) -> Result<(String, bool), Error> {
    if sql.len() > 1024 * 1024 {
        return Err(Error::new(
            "SQL_LIMIT",
            "SQL Server SQL is limited to 1 MiB.",
        ));
    }
    let text = placeholders(sql)?;
    let mut ast_tokens = sqlparser::tokenizer::Tokenizer::new(&MsSqlDialect {}, &text)
        .tokenize()
        .map_err(|_| Error::new("SQL_PARSE", "Invalid SQL Server syntax."))?;
    for token in &mut ast_tokens {
        if let sqlparser::tokenizer::Token::Word(word) = token
            && word.quote_style.is_none()
            && word.value.to_uppercase().starts_with("@P")
            && word.value[2..].bytes().all(|c| c.is_ascii_digit())
        {
            *token = sqlparser::tokenizer::Token::Placeholder(format!("?{}", &word.value[2..]));
        }
    }
    let ast=Parser::new(&MsSqlDialect{}).with_recursion_limit(64).with_tokens(ast_tokens).parse_statements().map_err(|_|Error::new("SQL_PARSE","SQL Server syntax could not be parsed. Execute a single supported SELECT, INSERT, UPDATE or DELETE statement."))?;
    if ast.len() != 1 {
        return Err(Error::new(
            "SQL_STATEMENTS",
            "Execute a single SQL Server statement.",
        ));
    }
    let query = matches!(ast[0], Statement::Query(_));
    if !query
        && !matches!(
            ast[0],
            Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)
        )
    {
        return Err(Error::new(
            "SQLSERVER_UNSUPPORTED",
            "DDL, routines, session control and scripts are unavailable in the SQL Server adapter.",
        ));
    }
    if read_only && !query {
        return Err(Error::new(
            "READ_ONLY",
            "SQL Server operation is read-only.",
        ));
    }
    if query {
        struct Safe;
        fn body(body: &SetExpr) -> bool {
            match body {
                SetExpr::Select(s) => s.into.is_none(),
                SetExpr::Query(_) | SetExpr::Values(_) => true,
                SetExpr::SetOperation { left, right, .. } => body_safe(left) && body_safe(right),
                _ => false,
            }
        }
        fn body_safe(b: &SetExpr) -> bool {
            body(b)
        }
        impl Visitor for Safe {
            type Break = ();
            fn pre_visit_query(&mut self, q: &AstQuery) -> ControlFlow<()> {
                if body(&q.body) {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            }
            fn pre_visit_relation(&mut self, n: &ObjectName) -> ControlFlow<()> {
                if n.0.len() > 2 {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            }
            fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<()> {
                if matches!(
                    t,
                    TableFactor::Table { args: None, .. } | TableFactor::Derived { .. }
                ) {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            }
            fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
                if let Expr::Function(f) = e {
                    let name = f.name.to_string().to_uppercase();
                    if f.name.0.len() != 1
                        || ![
                            "COUNT",
                            "COUNT_BIG",
                            "SUM",
                            "AVG",
                            "MIN",
                            "MAX",
                            "COALESCE",
                            "ISNULL",
                            "NULLIF",
                            "LOWER",
                            "UPPER",
                            "ABS",
                            "ROUND",
                            "LEN",
                            "CONCAT",
                            "CONVERT",
                            "SCHEMA_NAME",
                            "OBJECT_NAME",
                            "OBJECT_ID",
                            "TYPE_NAME",
                            "OBJECT_DEFINITION",
                            "DB_NAME",
                            "HAS_PERMS_BY_NAME",
                            "QUOTENAME",
                            "IS_MEMBER",
                            "IS_SRVROLEMEMBER",
                            "JSON_VALUE",
                            "JSON_QUERY",
                            "GETDATE",
                            "SYSDATETIME",
                        ]
                        .contains(&name.as_str())
                    {
                        return ControlFlow::Break(());
                    }
                }
                ControlFlow::Continue(())
            }
        }
        if ast[0].visit(&mut Safe).is_break() {
            return Err(Error::new(
                "READ_ONLY",
                "SQL Server SELECT INTO, external/table-valued functions, qualified functions and cross-database queries are blocked. Use supported read-only SQL.",
            ));
        }
    }
    Ok((text, query))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readonly_ast_and_lossless_numeric() {
        for s in [
            "SELECT * INTO x FROM y",
            "SELECT dbo.evil()",
            "SELECT * FROM OPENROWSET('x','y','z')",
            "DELETE FROM t",
            "SELECT 1;DELETE FROM t",
        ] {
            assert!(validate(s, true).is_err(), "{s}");
        }
        assert!(validate("WITH q AS (SELECT 1 AS n) SELECT * FROM q", true).is_ok());
        assert_eq!(
            numeric(decimal("-0.00000000000000000001").unwrap()),
            "-0.00000000000000000001"
        );
        assert!(validate("SELECT '?1',?1", true).unwrap().0.contains("@P1"));
        assert!(validate("SELECT NEXT VALUE FOR dbo.seq", true).is_err());
        assert_eq!(
            placeholders("SELECT 0x00FF80,N'名?1',?1 -- ?2").unwrap(),
            "SELECT 0x00FF80,N'名?1',@P1 -- ?2"
        );
    }
}
