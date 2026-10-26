# Delivery status and roadmap

## Next delivery plan

See [next-steps.md](next-steps.md) for the ordered implementation plan: desktop/PostgreSQL verification, typed filters and safe exports, SQL diagnostics, schema/investigation refinements, watch recovery, and distribution.

## Implemented

Connection lifecycle and local settings; PostgreSQL/native SQLite adapters; metadata and schema navigation; a searchable schema catalog and full/focused ER diagrams; shared Radix select controls; bounded, virtualized table browsing; SQL editing/execution/history; parameterized record SQL; incoming/outgoing foreign-key investigation; reference-only saved graphs; record/table/query polling; typed differences; capture controls; historical state inspection/comparison; retention; keyboard commands; themes; native branding; and Linux Debian packaging.

## Remaining before declaring the entire requested 0.1 complete

- Run live PostgreSQL integration and the full graphical desktop workflow. The available sandbox cannot access Docker, initialize GTK/Wayland, bind the Vite port, or launch Chromium successfully.
- Verify native window behavior, accessibility, focus handling, and component-level interactions visually. Current frontend tests cover domain/state/validation logic and server-rendered select semantics; browser keyboard/modal interactions still need verification.
- Test Windows and macOS, bundle or document libpq distribution on those platforms, and verify native installer behavior. Linux Debian packaging is the only completed packaging check.
- Measure actual application startup, idle RSS, and frame responsiveness on large real datasets. Current build sizes are measurements, not runtime performance guarantees.
- Reconcile the original dependency specification: TanStack Query/Table/Virtual, Zustand, XYFlow, and dedicated SQL language support were unavailable offline. The functioning replacements are documented in architecture.md. SQLx was replaced with established native drivers.
- Add OS credential-vault persistence if desired; the current secure fallback deliberately requires credentials each session.
- Make graph resource caps and monitoring concurrency configurable, add optional automatic watch resume, improve database-side reconnect recovery, and complete language/externalized-copy architecture.
- Expand PostgreSQL arrays/custom types, rich SQL source-error highlighting, and production/destructive SQL review coverage. PostgreSQL external-effect functions require database-role controls.
- Improve exact disk-space accounting/compaction, secure-memory handling, low-disk fault injection, and platform-specific permission verification. Current retention bounds payload storage, not exact physical file size.

The above are explicit gaps, not hidden controls or promises of completed functionality.

## Future versions

Keep MySQL, AI SQL, cloud accounts, CDC/logical replication, automatic restore, schema migration execution, and collaboration outside 0.1. No interface control implies these exist.

Potential later work includes Kitsune Replay with reviewed relational exports and anonymization; alternative observation sources for Time Machine; Query Lab; reusable integrity rules; and deterministic Seed Studio fixtures. Strict reviewed restoration is now implemented for eligible new full-value watch events; general transaction rewind and arbitrary SQL undo remain out of scope.

## Agreed next deliveries

1. Delivered workspace/grid polish, grouped filters/saved presets, bounded exports, diagnostic comparison, and timed/grouped watches; native graphical acceptance remains pending.
2. MySQL/MariaDB supports strict TLS, native SQL sessions, transactions, routines and eligible historical restore. Continue broader server-version/type coverage; DuckDB connectivity stays deferred.

This delivery adds shared themed checkbox/tooltips, reviewed watch-event restoration, and read-only query plans with explicit measurement. Graphical acceptance and live PostgreSQL verification remain required before calling those paths fully verified.

## SQL engines update

PostgreSQL, MySQL, MariaDB and SQL Server now pass live server workflows and Linux native WebKit table/query smoke tests. SQL Server has its own TDS adapter; CodeMirror uses maintained native dialect parsing. DuckDB adapter work is deferred. MySQL verify-full now uses Rustls to enforce certificate and hostname verification. Complete Windows/macOS acceptance and remaining detailed desktop workflows; see main-engine-verification.md.
