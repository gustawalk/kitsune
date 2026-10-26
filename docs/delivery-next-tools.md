# Next tools implementation

Authorized scope: grid context menus/shortcuts; saved table/panel/diagram layouts; typed AND/OR filters with saved filters and bounded CSV/typed-JSON exports; diagnostic run comparison; temporary/grouped watches and observation-gap status; complete MySQL/MariaDB adapter.

Order and acceptance gates:

1. Grid/workspace polish: real cell/row actions, shift selection, keyboard selection, persisted layout isolated by connection/table; unit/type/format verification.
2. Filters/exports: typed parameter binding, grouped predicate semantics, saved presets, explicit bounds/columns/destination and cancellation; SQLite integration coverage.
3. Diagnostics/watch workflow: compare retained in-memory measurements, timed watches restored paused, groups and gap/recovery visibility; lifecycle/retention tests.
4. MySQL/MariaDB: native prepared queries, metadata/identity/relationships, read-only enforcement, diagnostics and watch compatibility; use a disposable native database fixture where available. Never advertise unsupported operations.
5. Full checks, documentation, Linux build. Report environmental limitations honestly.

Baseline: SQLite and PostgreSQL adapters, CRUD, watch restore and diagnostics are already implemented. Previous checks: 46 Rust tests, 41 frontend tests, 21 IPC contracts; PostgreSQL live verification unavailable (libpq missing, Docker denied). MariaDB client library and server binaries are present in this environment; no cached Rust mysql/sqlx crate was found. The native MariaDB ABI was checked against installed headers before implementation.

## Current implementation status

- Stages 1–3 implemented: grid context menus/shortcuts, persisted column/panel/schema layouts, grouped typed filters and saved presets, bounded native CSV/typed-JSON export, diagnostic run comparison, timed/grouped watches, and existing lifecycle/gap reporting.
- Stage 4 has a native MySQL/MariaDB **preview** adapter with embedded-server integration evidence. Live network/TLS/cancellation, MySQL-version acceptance and other-platform packaging remain pending. A maintained Rust driver is still unavailable offline; the adapter uses the installed MariaDB Connector/C 3 ABI. Full acceptance is not complete.
- Stage 5 verification and Linux packaging recorded in validation.md. Desktop interaction acceptance and live PostgreSQL checks remain unavailable here.

SQL Server/DuckDB adapter blockers and the portable parser delivery are tracked in sql-engines-plan.md. SQL generation alone is not connection support.
