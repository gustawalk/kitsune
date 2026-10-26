# Database adapters

Database access stays in Rust. `database/mod.rs` provides bounded queries, metadata, stable identity, filtering, and browsing. Dialect-specific SQL remains separate. `database/postgres.rs` owns the libpq boundary.

## SQLite

The adapter uses bundled rusqlite and explicit read-only/read-write/create open flags. Existing-file mode never creates a missing database. Connection testing cannot create files. Generated filters use bound parameters; identifiers use doubled double-quote escaping.

Read-only execution checks SQLite's prepared-statement classification, and monitoring additionally opens the file read-only. A native authorizer blocks attaching databases, external-file helpers, extension loading, and unapproved PRAGMAs. Metadata uses narrowly allowed introspection functions. No source WAL mode, source extensions, or source triggers are installed. Source PRAGMAs, including foreign-key enforcement settings, are not silently changed; SQLite connection defaults therefore matter for explicit editor writes.

Storage classes are preserved as null, signed integer strings, floating-point strings, text, and base64 binary. Declared column types are returned separately. Date/JSON semantics in SQLite remain dependent on its actual storage values; numeric text is never automatically coerced into a JavaScript number.

## PostgreSQL

Install libpq and its platform TLS dependencies. The adapter supplies separate connection properties rather than building authenticated URLs. TLS modes include disable, allow, prefer, require, verify-ca, and verify-full. Prefer verification modes and restricted database roles for production. Certificate behavior follows libpq's configuration.

Metadata includes schemas, tables/views, types, defaults, nullability, primary/foreign keys, indexes, composite constraints, and partial-index eligibility. Background reads use PostgreSQL read-only transactions. All managed queries have statement timeouts. Native cancellation requests are distinguished from confirmed server outcomes; a failure to confirm commit is reported as uncertain.

Result streaming uses libpq single-row mode to bound accumulated data. Exceeding PostgreSQL's result limit interrupts and rolls back the managed transaction and reports a limit error; narrow the query to retrieve a bounded result. The current adapter does not return a successful partial PostgreSQL SQL-editor result after that interruption. Large individual server fields may still be allocated by libpq before the application can reject them.

Types include booleans, integers, numeric/decimal strings, floats, JSON/JSONB text, dates/timestamps, UUID, base64 bytea, arrays in explicit PostgreSQL textual form, and an unknown/custom fallback. Arrays are not yet decoded into a recursive element model. User-defined type decoding and SQL error source highlighting remain limited.

## Adding another adapter

Keep native connection/authentication/type handling inside Rust. Implement bounded execution, database-specific identifier/parameter rules, metadata, cancellation outcomes, identity discovery, and safe read-only operations. Extend capabilities and shared contracts where the new database differs. A generic string-only driver must not erase type or safety differences.

## MySQL / MariaDB preview

Native prepared statements use MariaDB Connector/C 3, loaded lazily from the platform loader. MySQL and MariaDB share this adapter; no Oracle Connector/C ABI is loaded. The selected database acts as the catalog namespace. Native composite keys, incoming/outgoing relationships, indexes, column defaults and base-table/view distinctions come from information_schema. Prefix/functional indexes are excluded as reliable identities.

Ordinary reads, server paging, JSON EXPLAIN and bounded direct measurements are available. InnoDB DML supports reviewed application edits with affected-row checks before commit. Source schema mutation/routines, multi-table DML and historical restore are unavailable. SQL session settings ANSI_QUOTES and NO_BACKSLASH_ESCAPES are connection-local to support shared identifier/string rules. TLS choices are explicit disable or encryption-only require. verify-full fails closed before connection because the connector cannot guarantee strict CA/hostname verification for private endpoints.

Linux embedded-server tests exercise the Rust native statement boundary against real MariaDB tables without sockets. Live MySQL 8.x/MariaDB network authentication, TLS, interrupted connections and cancellation still need a disposable remote/socket fixture on an unrestricted host. Windows/macOS are unverified. Native client libraries are optional runtime dependencies and are not bundled by this change.

SQL Server now has its own adapter, described below. DuckDB remains a SQL-preview dialect only; adapter work is deferred.

## SQL Server / Tiberius

SQL Server now has a dedicated Rust TDS adapter (`mssql.rs`) and native sys-catalog metadata (`mssql_metadata.rs`). A worker owns its asynchronous connection; Rust command callers retain the same typed synchronous service boundary. Credentials never enter frontend state or authenticated URLs. Rustls handles transport; `verify-full` rejects the untrusted fixture certificate, while explicit `require` encrypts a trusted local fixture without certificate validation.

The maintained sqlparser AST rejects unsupported statements/read-side effects. Explicit read-only and Production connections check effective object/schema permissions and require restricted credentials; the fixture verifies that the server itself refuses writes. ApplicationIntent is not used as an enforcement boundary. Generated paging uses OFFSET/FETCH with stable unique-key ordering where available. Typed parameters use TDS values; decimal scale/sign are formatted without floats, including negative values below one. DML affected-row checks occur before COMMIT. Historical restore and DDL/routines are unavailable.

Estimated plans use SHOWPLAN XML with typed unassigned parameters; measurement uses actual bindings. Cancellation/timeout closes the transport and discards interrupted transactions. No server-confirmed cancellation is promised; writes interrupted around commit are uncertain and must not be retried automatically. A lost multi-operation transaction cannot silently continue after reconnect.

Live SQL Server, PostgreSQL, MySQL and MariaDB integration results and restrictions are recorded in main-engine-verification.md. DuckDB remains deferred.
