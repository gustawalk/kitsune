# Main SQL engines and portable SQL

The active engines are PostgreSQL, MySQL/MariaDB, SQL Server and existing SQLite. DuckDB adapter work is deferred.

## Delivered

SQL Server now has a Tiberius/TDS adapter, schema/key/index metadata, parameter binding, paging, typed results, transaction/affected-row checks, read-only AST and credential checks, diagnostics, and the shared investigation/watch flow. Live workflows passed for PostgreSQL, MySQL, MariaDB and SQL Server; see [main-engine-verification.md](main-engine-verification.md).

CodeMirror now uses the maintained SQL language package with SQLite, PostgreSQL, MySQL and SQL Server dialects. Connection changes reconfigure the parser without discarding editor state. Completion uses real structured metadata, dialect keywords and bounded snippets (TOP for SQL Server, LIMIT elsewhere).

Portable mode remains an explicit SELECT AST/preview workflow: projections, aliases, joins, predicates, common aggregates, grouping, ordering and paging. Unsupported CTE/subquery/cast translations and vendor-specific operations stay native. No SQL is silently rewritten when Run is pressed. SQL Server native SQL independently uses the maintained Rust sqlparser AST to enforce its supported read subset. Native placeholders are rewritten outside opaque quotes/comments while preserving original dialect syntax and binary literals.

## Remaining work

MySQL/MariaDB strict certificate/hostname verification is intentionally unavailable: live testing showed the native connector skips checks on local/private endpoints. `verify-full` fails before authentication; encryption-only `require` is explicit. Replace or extend that transport only with verified certificate tests.

Continue native GUI and cross-platform acceptance, richer plan displays, vendor type coverage and configurable resource controls. Extend portable SQL through AST nodes and semantic rejection tests, never regex substitution. Do not resume DuckDB work without a new user request.
