use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Value {
    Null,
    Boolean(bool),
    Integer(String),
    Decimal(String),
    Float(String),
    Text(String),
    Binary(String),
    Json(String),
    Date(String),
    Timestamp(String),
    Uuid(String),
    Array(String),
    Unknown(String),
}
impl Value {
    pub fn text(&self) -> Option<String> {
        match self {
            Self::Null => None,
            Self::Boolean(b) => Some(b.to_string()),
            Self::Integer(s)
            | Self::Decimal(s)
            | Self::Float(s)
            | Self::Text(s)
            | Self::Binary(s)
            | Self::Json(s)
            | Self::Date(s)
            | Self::Timestamp(s)
            | Self::Uuid(s)
            | Self::Array(s)
            | Self::Unknown(s) => Some(s.clone()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub driver: String,
    pub environment: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "port")]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing)]
    pub password: String,
    #[serde(default = "tls")]
    pub ssl_mode: String,
    #[serde(default)]
    pub tls_ca_path: String,
    #[serde(default)]
    pub tls_cert_path: String,
    #[serde(default)]
    pub tls_key_path: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub remember_password: bool,
}
fn port() -> u16 {
    5432
}
fn tls() -> String {
    "prefer".into()
}
impl ConnectionConfig {
    pub fn validate(&self) -> Result<(), Error> {
        if self.name.trim().is_empty() {
            return Err(Error::new("VALIDATION", "A connection name is required."));
        }
        let valid_color = self.color.is_empty()
            || (self.color.len() == 7
                && self.color.starts_with('#')
                && self.color.as_bytes()[1..]
                    .iter()
                    .all(|c| c.is_ascii_hexdigit()));
        if !valid_color {
            return Err(Error::new(
                "VALIDATION",
                "Choose a six-digit hex connection color.",
            ));
        }
        if !["development", "staging", "production", "custom"].contains(&self.environment.as_str())
        {
            return Err(Error::new("VALIDATION", "Invalid environment."));
        }
        match self.driver.as_str() {
            "sqlite" if self.path.trim().is_empty() => {
                Err(Error::new("VALIDATION", "Choose a SQLite file."))
            }
            "postgres" | "mysql" | "mssql"
                if self.host.is_empty()
                    || self.database.is_empty()
                    || self.username.is_empty()
                    || self.port == 0 =>
            {
                Err(Error::new(
                    "VALIDATION",
                    "Host, port, database and username are required.",
                ))
            }
            "postgres"
                if ![
                    "disable",
                    "allow",
                    "prefer",
                    "require",
                    "verify-ca",
                    "verify-full",
                ]
                .contains(&self.ssl_mode.as_str()) =>
            {
                Err(Error::new("VALIDATION", "Invalid TLS mode."))
            }
            "mysql" | "mssql"
                if !["disable", "require", "verify-full"].contains(&self.ssl_mode.as_str()) =>
            {
                Err(Error::new(
                    "VALIDATION",
                    "MySQL/MariaDB TLS mode must be disable, require, or verify-full.",
                ))
            }
            "sqlite" | "postgres" | "mysql" | "mssql" => Ok(()),
            _ => Err(Error::new("VALIDATION", "Unsupported database driver.")),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub pk: i64,
    #[serde(default)]
    pub enum_type: Option<EnumRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnumRef {
    pub schema: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumType {
    pub schema: String,
    pub name: String,
    pub values: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub from: TableRef,
    pub to: TableRef,
    pub columns: Vec<String>,
    pub target_columns: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub partial: bool,
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRecommendation {
    pub table: TableRef,
    pub related_table: TableRef,
    pub foreign_key: String,
    pub columns: Vec<String>,
    pub direction: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexAdvice {
    pub recommendations: Vec<IndexRecommendation>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub table: TableRef,
    pub columns: Vec<Column>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<Index>,
    #[serde(default)]
    pub enums: Vec<EnumType>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub types: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub affected: u64,
    pub duration_ms: u64,
    pub truncated: bool,
    #[serde(default)]
    pub next_cursor: Option<Vec<Value>>,
    #[serde(default)]
    pub keyset_supported: bool,
}
impl ResultSet {
    pub fn empty() -> Self {
        Self {
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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub operator: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterGroup {
    pub mode: String,
    pub filters: Vec<Filter>,
}
fn all_filters() -> String {
    "all".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRequest {
    #[serde(default)]
    pub filter_groups: Vec<FilterGroup>,
    #[serde(default = "all_filters")]
    pub group_mode: String,
    pub connection_id: String,
    pub table: TableRef,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub descending: bool,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub keyset: bool,
    #[serde(default)]
    pub cursor: Option<Vec<Value>>,
    #[serde(default = "page_size")]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCounts {
    pub matching: u64,
    pub total: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEstimate {
    pub total: Option<u64>,
    pub source: String,
}
fn page_size() -> u32 {
    100
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRef {
    pub connection_id: String,
    pub table: TableRef,
    pub key: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    #[serde(default)]
    pub filter_groups: Vec<FilterGroup>,
    #[serde(default = "all_filters")]
    pub group_mode: String,
    #[serde(default)]
    pub group_name: String,
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub deadline_at: Option<String>,
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub kind: String,
    pub table: Option<TableRef>,
    #[serde(default)]
    pub key: BTreeMap<String, Value>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sql: String,
    pub interval_seconds: u64,
    pub capture: String,
    #[serde(default)]
    pub production_capture_authorized: bool,
    #[serde(default)]
    pub excluded_columns: Vec<String>,
    #[serde(default)]
    pub notifications: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_observed: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub event_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub column: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedField {
    pub column: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSource {
    pub watch_kind: String,
    pub schema_fingerprint: String,
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(default)]
    pub restore_source: Option<RestoreSource>,
    pub id: String,
    pub watch_id: String,
    pub connection_id: String,
    pub observed_at: String,
    pub event_type: String,
    pub summary: String,
    pub changes: Vec<Change>,
    pub before_state: Option<Vec<ObservedField>>,
    pub after_state: Option<Vec<ObservedField>>,
    pub record: Option<RecordRef>,
    pub capture: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Investigation {
    pub id: String,
    pub name: String,
    pub root: RecordRef,
    pub graph: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
// Classify native diagnostics without returning raw SQL, paths, or data values.
fn sqlite_statement_error(message: Option<&str>, offset: Option<i32>) -> Error {
    let diagnostic = message.unwrap_or("").to_ascii_lowercase();
    let (code, hint) = if diagnostic.contains("no such column")
        || diagnostic.contains("has no column named")
    {
        (
            "SQLITE_COLUMN",
            "SQLite could not find a referenced column. In SET clauses use the column name alone (for example, SET \"name\" = 'value'); use single quotes for text values and double quotes for identifiers.",
        )
    } else if diagnostic.contains("no such table") {
        (
            "SQLITE_TABLE",
            "SQLite could not find a referenced table or view. Refresh the schema and check the active database and table name.",
        )
    } else if diagnostic.contains("syntax error")
        || diagnostic.contains("incomplete input")
        || diagnostic.contains("unrecognized token")
    {
        (
            "SQLITE_SYNTAX",
            "SQLite could not parse this statement. Check SQL syntax, quoting, and statement boundaries. Text values use single quotes; identifiers use double quotes.",
        )
    } else if diagnostic.contains("no such function") {
        (
            "SQLITE_FUNCTION",
            "This SQLite connection does not provide a function used by the statement. Extensions are not loaded automatically.",
        )
    } else {
        (
            "SQLITE_STATEMENT",
            "SQLite rejected this statement. Check column and table names, SQL syntax, and features supported by SQLite.",
        )
    };
    let location = offset
        .filter(|offset| *offset >= 0)
        .map(|offset| format!(" SQLite reported UTF-8 byte offset {offset} (starting at zero)."))
        .unwrap_or_default();
    Error::new(code, &format!("{hint}{location}"))
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode as Code;
        match e {
            rusqlite::Error::InvalidParameterCount(given, expected) => Self::new(
                "SQLITE_PARAMETERS",
                &format!(
                    "This statement expects {expected} bound parameter(s), but received {given}. Placeholders such as ?1 need a bound value. In a manually written query, replace the placeholder with a correctly quoted value, or execute the original generated query with its bound parameters."
                ),
            ),
            rusqlite::Error::SqlInputError { msg, offset, .. } => {
                sqlite_statement_error(Some(&msg), Some(offset))
            }
            rusqlite::Error::SqliteFailure(err, message) => {
                let (code, hint) = match err.code {
                    Code::DatabaseBusy | Code::DatabaseLocked => (
                        "SQLITE_BUSY",
                        "The database or table is locked by another operation. Wait for it to finish and retry.",
                    ),
                    Code::ReadOnly => (
                        "SQLITE_READ_ONLY",
                        "SQLite cannot write in this mode. Check the connection's read-only setting and permissions for the database and its journal files.",
                    ),
                    Code::OperationInterrupted => (
                        "SQLITE_INTERRUPTED",
                        "Execution interrupted or timed out. The database outcome may need verification.",
                    ),
                    Code::CannotOpen => (
                        "SQLITE_OPEN",
                        "SQLite could not open the database. Check that the selected file and its parent directory exist and are accessible; use Open read-only for files you cannot write.",
                    ),
                    Code::PermissionDenied | Code::AuthorizationForStatementDenied => (
                        "SQLITE_PERMISSION",
                        "SQLite denied this operation. Check connection permissions; attaching databases, loading extensions, and changing protected PRAGMAs are blocked by Kitsune.",
                    ),
                    Code::NotADatabase => (
                        "SQLITE_FORMAT",
                        "The selected file is not a supported SQLite database. Select the main database file, not a journal, WAL, backup archive, or encrypted database.",
                    ),
                    Code::DatabaseCorrupt => (
                        "SQLITE_CORRUPT",
                        "SQLite reported database corruption. Stop writing and investigate a copy of the database with its associated journal files. Kitsune has not attempted a repair.",
                    ),
                    Code::DiskFull => (
                        "SQLITE_DISK_FULL",
                        "SQLite could not finish because storage is full. Free space on the database and temporary-file volumes before retrying.",
                    ),
                    Code::SystemIoFailure => (
                        "SQLITE_IO",
                        "SQLite encountered a filesystem I/O error. Check the database volume, file access, and available storage.",
                    ),
                    Code::ConstraintViolation => (
                        "SQLITE_CONSTRAINT",
                        "The write violates a database constraint (such as a primary key, unique value, NOT NULL, CHECK, or foreign key). Inspect the table structure and supplied values.",
                    ),
                    Code::TooBig => (
                        "SQLITE_VALUE_LIMIT",
                        "A text, binary value, or row exceeds SQLite's configured size limit.",
                    ),
                    Code::Unknown => return sqlite_statement_error(message.as_deref(), None),
                    _ => (
                        "SQLITE",
                        "SQLite could not complete this operation. Check the statement and database configuration.",
                    ),
                };
                Self::new(code, &format!("{hint} SQLite code: {}.", err.extended_code))
            }
            _ => Self::new(
                "SQLITE",
                "SQLite could not decode or execute this operation. Check the statement's parameter and result types.",
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplicationSettings {
    pub theme: String,
    pub density: String,
    pub page_size: u32,
    pub row_limit: u32,
    pub query_timeout: u64,
    pub poll_interval: u64,
    pub retention_days: u64,
    pub max_events: u64,
    pub storage_mi_b: u64,
    pub query_history: bool,
    pub restore_tabs: bool,
    pub editor_font_size: u32,
    pub editor_tab_size: u32,
    pub editor_wrap: bool,
    pub sensitive_columns: String,
}
impl Default for ApplicationSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            density: "compact".into(),
            page_size: 100,
            row_limit: 1000,
            query_timeout: 30,
            poll_interval: 5,
            retention_days: 30,
            max_events: 10000,
            storage_mi_b: 250,
            query_history: true,
            restore_tabs: true,
            editor_font_size: 13,
            editor_tab_size: 2,
            editor_wrap: false,
            sensitive_columns: "password,secret,token,private_key,ssn".into(),
        }
    }
}
impl ApplicationSettings {
    pub fn validate(&self) -> Result<(), Error> {
        if ![
            "dark", "light", "system", "midnight", "forest", "sand", "oled", "violet",
        ]
        .contains(&self.theme.as_str())
            || !["compact", "comfortable"].contains(&self.density.as_str())
        {
            return Err(Error::new("VALIDATION", "Invalid appearance preference."));
        }
        for (name, value, min, max) in [
            ("Page size", self.page_size as u64, 10, 1000),
            ("Result rows", self.row_limit as u64, 1, 10000),
            ("Query timeout", self.query_timeout, 1, 300),
            ("Polling interval", self.poll_interval, 2, 3600),
            ("Retention days", self.retention_days, 1, 3650),
            ("Events per watch", self.max_events, 1, 100000),
            ("Storage MiB", self.storage_mi_b, 1, 2048),
            ("Editor font size", self.editor_font_size as u64, 10, 24),
            ("Editor tab size", self.editor_tab_size as u64, 1, 8),
        ] {
            if value < min || value > max {
                return Err(Error::new(
                    "VALIDATION",
                    &format!("{name} must be between {min} and {max}."),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub metadata: Metadata,
    pub incoming: Vec<ForeignKey>,
    pub definition: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaLoadError {
    pub table: TableRef,
    pub error: Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaBatch {
    pub tables: Vec<Metadata>,
    pub errors: Vec<SchemaLoadError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCompletion {
    pub label: String,
    pub parts: Vec<String>,
    pub kind: String,
    pub detail: String,
}
