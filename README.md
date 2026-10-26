# Kitsune 狐

**Understand your data.** A local-first desktop database client for exploring records, following relationships, observing changes, and reviewing captured history.

Built with Tauri 2, Rust, React, strict TypeScript, Tailwind, shadcn-style Radix components, Lucide, CodeMirror, and Zod. The icon reuses Kodama's vector geometry with `#E85D3F` throughout the application and native icon variants.

## Current status

This repository contains functioning database services and connected UI workflows, not demo datasets. SQLite workflows are covered by real-database integration tests. PostgreSQL, MySQL/MariaDB and SQL Server adapters now have live server integration coverage; PostgreSQL uses libpq, MySQL/MariaDB uses Connector/C, and SQL Server uses Tiberius/TDS.

The full requested 0.1 verification is **not complete**: complete graphical workflows, Windows and macOS still need verification. Linux native WebKit smoke testing now covers four live engines and SQL execution. See [validation](docs/validation.md) for executed checks and [roadmap](docs/roadmap.md) for remaining requirements and implementation differences.

## Requirements

- Bun and stable Rust. Development was tested with Bun 1.4 and Rust 1.93.1.
- Linux: C build tools, GTK 3, and WebKitGTK 4.1 development libraries. `pkg-config --modversion gtk+-3.0 webkit2gtk-4.1` should succeed.
- PostgreSQL connections: native PostgreSQL client library **libpq**, including its TLS dependencies. On Arch this is provided by `postgresql-libs`; on Debian by `libpq5`. The Debian bundle declares this dependency.
- Windows/macOS: the corresponding Tauri desktop build prerequisites. PostgreSQL also requires libpq available to the platform loader; Homebrew libpq paths are supported on macOS.

SQLite is bundled into the Rust application and needs no external database service. No credentials, account, remote fonts, or cloud service are needed to launch Kitsune.

## Development

```sh
bun install --frozen-lockfile
bun run tauri dev
```

`bun run dev` starts the Vite frontend. Browser preview displays the real interface, but database operations require the desktop application; it never substitutes fake results.

```sh
bun run typecheck
bun run types:check
bun run lint
bun test
bun run test:rust
bun run test:contracts
bun run format:check
```

Generate frontend IPC contracts after changing Rust models:

```sh
bun run types:generate
```

Formatting is available separately with `bun run format`.

## Builds

```sh
bun run build
bun run tauri build
# Linux Debian package only:
bun run tauri build --bundles deb
```

Native outputs are under `src-tauri/target/release/`. Building a Linux package does not verify Windows or macOS. AppImage packaging may need additional platform tooling or downloads.

## Schema viewer

Open **Schema viewer** from the sidebar, a connection's menu, **View schema** on a table, or the command palette. The catalog shows real columns, defaults, nullability, keys, indexes, and incoming/outgoing foreign keys. SQLite also exposes its reported source SQL.

Choose **ER diagram** and **Load diagram** for a full database view, or **Focus diagram** on a table for its relationships. Diagrams support pan/zoom/fit, draggable table cards, and resizable/collapsible details. Loading is progressive and cancellable; large schemas are explicitly scoped to 200 nodes/1,000 relationships. No table rows are loaded for schema inspection.

All dropdowns now share a themed Radix/shadcn select rather than the browser's native menu. See the [next delivery plan](docs/next-steps.md) for planned functionality.

## Explore → observe → investigate

1. Add PostgreSQL, SQLite, or MySQL/MariaDB preview connection settings. SQLite creation is an explicit checkbox/action; testing a connection cannot create a file.
2. Connect, search the explorer, and open table data or structure. Use the SQL editor for explicit statements or sequential scripts.
3. Select a row with a complete primary or eligible non-null unique key. Open **Investigate** to expand declared incoming/outgoing foreign keys, including composite relationships.
4. Create a record, scoped-table, or query watch. The first successful observation establishes a baseline.
5. Change data from another connection. Open **Live Watch** or **Time Machine** to inspect observed differences and navigate back to current records.
6. Save investigations to preserve references and graph layout. Source values are fetched again when reopening.

The grid supports server-side filtering, sorting, paging, column resizing/reordering/hiding, cell-range copying, typed row JSON, keyboard navigation, and full-value inspection. Row numbering is local to the current page. Exact table counts are not queried automatically.

The editor supports selected/current SQL, result tabs, bound values for generated record queries, timeout/cancellation, saved queries, and configurable local query history. Scripts execute statements sequentially, each in its own managed transaction, stop on error, and retain completed outcomes. Session/transaction control, `ATTACH`, arbitrary PRAGMAs, external-file commands, and unsupported execution modes are blocked.

## Keyboard shortcuts

| Shortcut             | Action                                   |
| -------------------- | ---------------------------------------- |
| Ctrl/Cmd + K         | Command palette                          |
| Ctrl/Cmd + P         | Search tables, connections, and commands |
| Ctrl/Cmd + Shift + F | Search workspace items                   |
| Ctrl/Cmd + T         | New SQL tab                              |
| Ctrl/Cmd + W         | Close tab; review unsaved SQL first      |
| Ctrl/Cmd + Enter     | Execute SQL                              |
| Ctrl/Cmd + S         | Save SQL                                 |
| Ctrl/Cmd + ,         | Settings                                 |
| Escape               | Dismiss active overlay                   |

## Security and privacy

Passwords are session-only and are not serialized into saved connections, workspace state, or history. Enter server database credentials again after restarting. OS credential-vault persistence is not implemented; no plaintext fallback is used.

Production starts read-only. Development, Staging, and Custom start writable, as selected for this project. Writes can be disabled at any time; Production write enablement requires session confirmation. Destructive/unclassified statements require a short-lived review token bound to the exact SQL, bound values, connection, and session.

Watch execution always uses read-only operations. Production defaults to metadata-only capture; full-value capture requires explicit authorization. Sensitive column-name patterns and explicit exclusions apply to every watch type. Column-name exclusions cannot identify all secrets inside ordinary text or JSON; review projections and capture mode before watching sensitive data.

Local metadata and full-value history are **not encrypted at rest**. Unix directory/file permissions are restricted. SQL text and record references can contain sensitive information; disable history/tab restoration and clear local history when appropriate. Nothing is sent to telemetry or operating-system notifications.

Read-only transactions do not sandbox PostgreSQL functions with external side effects. Use restricted database roles and review [security boundaries](docs/security.md).

## Polling and retention

Polling is observation, **not a transactional audit log**. Intermediate changes and rows inserted/deleted between polls may be missed. Timestamps describe observation time. A row entering/leaving a filtered query is not proof of database insertion/deletion.

Defaults: 5-second polls, 2-second minimum, four global polls, one background poll per connection, 1,000 rows/5 MiB per observation, and 50 active watches. There is a separate interactive connection per session. Watches restore paused and pause on disconnect. Failures back off; recovery establishes a fresh baseline.

History defaults to 30 days, 10,000 events per watch, and 250 MiB of event payloads. Individual events above 1 MiB retain metadata only, with an explicit explanation. Timeline pages are bounded to 8 MiB. Query history retains at most 1,000 entries/32 MiB and follows the retention duration. SQLite may retain allocated free pages for reuse after deletion; payload limits are not a promise about exact file size or forensic erasure.

## Test data

Create a disposable SQLite fixture explicitly:

```sh
sqlite3 /tmp/kitsune-fixture.sqlite < tests/fixtures/sqlite.sql
```

For PostgreSQL, start only the isolated test service:

```sh
docker compose up -d --wait
cargo test --manifest-path src-tauri/Cargo.toml postgres_live_fixture -- --ignored
# Remove the disposable service when finished:
docker compose down
```

The fixture includes customers, orders, items, products, payments, addresses, cycles, composite keys, nulls, JSON, large numeric values, binary data, views, and 5,000 additional products. Test credentials are fixed and restricted to the localhost test service. Fixtures are never installed into a connected user database automatically.

## Further documentation

- [Architecture and decisions](docs/architecture.md)
- [Database adapters and typing](docs/database-adapters.md)
- [Security boundaries](docs/security.md)
- [Verification and release evidence](docs/validation.md)
- [Remaining work and future roadmap](docs/roadmap.md)

SQLite connections use a native **Browse…** dialog to select an existing database. Enable **Create a new SQLite database** to choose a new filename with **Choose location…**. Picking a location does not create a file; creation happens only when you connect. Existing files cannot be replaced through the creation picker. Read-only and Production connections open existing files only.

To change a table value, double-click its cell, press **F2**, or use **Edit value** in the grid toolbar. Review the current/new value and connection, then choose **Save value**. The editor preserves large numeric strings, distinguishes NULL from empty text, and refuses to overwrite a cell whose value changed since it was loaded. Enable session write access explicitly for read-only connections. Identity columns, views, tables without reliable keys, binary/array/custom values, and database-generated columns are not supported for ordinary cell editing; use an explicit SQL workflow where appropriate.

Live Watch now starts with a target summary, offers record, filtered-table, and query workflows, and selects a watch automatically in the dashboard. The first poll establishes a baseline; resuming establishes a new baseline. Paused intervals and changes between polls are not reconstructed. Privacy exclusions and notification settings are grouped under advanced options; production capture consent remains visible.

Workspace tabs show their type, connection and namespace, with category colors and a stronger active marker. Arrow keys, Home and End navigate the focused tab strip. Schema diagrams pack disconnected groups separately, order connected layers to reduce crossings, and use compact table cards. Use **Arrange related tables** (or **Arrange records** in Detective) to reset manual positions.

Table browsing now includes row checkboxes and **Select all rows on this page**, **Edit selected**, **Delete selected**, and **New record**. Selection is limited to the loaded page and at most 500 rows; it clears when paging, sorting, filtering or refreshing results. Bulk edits set one field across the selection and check the previous values. Inserts distinguish database defaults, explicit values, and NULL. Every operation shows generated SQL and bound values for review before a single-use confirmation. Bulk writes roll back if the affected base-row count differs from the selection. Deletion follows database triggers and cascading foreign keys, which may affect additional records.

Appearance provides Graphite, Daylight, System, Midnight, Forest, Sand and Pitch black palettes. Theme and density changes apply immediately and save automatically; other settings retain their Save action. Comfortable density increases grid row spacing as well as navigation spacing. A failed appearance save is shown inline with a retry action.

Checkboxes and hover hints now use shared, theme-aware Radix components, including mixed row selection, required consent controls, keyboard focus, and explanations for disabled actions.

To restore an unusual observed change, configure a **Record Watch** or **Table Watch** with **Before and after values**, wait for a baseline and a subsequent change, then choose **Restore…** in Live Watch or Time Machine. Review the current/proposed values and SQL, then confirm. Only new, eligible observations carry restoration provenance; older events remain readable. Metadata-only history and arbitrary query projections cannot restore data. Excluded fields are preserved. Removing an appeared record or recreating a disappeared record requires a complete Record Watch capture. Conflicts, changed schemas, active triggers, unsafe cascades, unsupported types, and read-only connections block automatic restoration. There is no force-overwrite or automatic transaction rewind.

Use **Diagnose** in a SQL tab to inspect one selected/current read-only query. Estimated plans load first. **Run measurement…** explicitly executes it under read-only enforcement, timeout and cancellation controls. PostgreSQL shows JSON plan nodes, planner cost units, and measured execution/buffer details. Cost units are not money or milliseconds. SQLite shows scan/index plans and observed elapsed time; capped measurements are marked partial. Diagnostic plans and measurements are not saved automatically.

The grid now has application context menus for copying, inspection, editing, investigation, watches, and reviewed deletion. Shift-click selects a row range; Ctrl/Cmd+A selects the loaded page (up to 500 rows), Space toggles the active row, and Shift+F10 opens its cell menu. Column widths/order/visibility, panel sizes, and schema-card positions persist locally by connection and table.

Table filters support typed conditions grouped with AND/OR, plus explicitly saved local presets. `contains` treats `%` and `_` literally. Applied filter groups restore with workspace tabs. Presets and restored filters may contain sensitive values; clear them when no longer needed.

**Export** writes the current page or a filtered scope to CSV or typed JSON, using a native Save dialog. Choose columns explicitly; likely secret columns are excluded initially and require authorization. Exports stop at 10,000 rows or 100 MiB. CSV uses unquoted `\N` for NULL and quoted empty strings; binary is base64 and spreadsheet-safe text is enabled by default. Typed JSON retains tagged database values, including large integers. Existing files are never replaced. Publication requires filesystem hard-link support; unsupported filesystems fail without replacing the destination.

Watches can be grouped and given a duration, with group pause/resume and automatic stopping. A resumed watch starts a new baseline and resets its duration; no changes during a pause are reconstructed. Query diagnostics can compare recent runs from the same connection: driver elapsed-time deltas, PostgreSQL planner costs and node counts, with warnings for different query parameters and incomplete measurements. At most 10 runs / 5 MiB stay in memory, with a 2 MiB per-run cap; they are not persisted.

## More engines and portable SQL

The connection chooser now includes **MySQL / MariaDB · Preview**, using **MariaDB Connector/C 3** (`libmariadb.so.3`, `libmariadb.3.dylib`, or `libmariadb.dll`). Install the trusted platform client library separately; it is loaded only when needed. Credentials remain session-only. TLS defaults to required; `verify-full` is unavailable and fails before authentication: live tests found that the C connector skips peer checks on local/private endpoints. Network/TLS-required, timeout and cancellation workflows now pass real MySQL and MariaDB tests.

The adapter supports prepared queries, typed results, the selected database's catalog, primary/composite/foreign keys, indexes, browsing, InnoDB cell/bulk edits, investigation, polling comparisons and JSON EXPLAIN. Transactional DML is intentionally restricted to simple single-table targets. DDL, stored routines, executable comments, external-file functions and historical restoration are blocked. Visible triggers block managed writes. Database grants can hide trigger metadata; privileged functions/trigger side effects are not sandboxed. Prefer a dedicated, restricted database role. Connector socket read/write timeouts are 10 seconds; the query watchdog also requests cancellation at the configured deadline. Cancellation is a request, not a verified server outcome.

Use **Portable SQL** in a query tab to write one SELECT, choose a table template, and preview dialect-specific output. The parser builds a real SELECT AST and reports error positions. It handles identifiers, exact literals, parameters, joins, predicates, common aggregates, grouping, ordering and paging; SQL Server uses TOP/OFFSET-FETCH, while MySQL uses backticks and positional parameters. Opening the result creates a new tab and preserves the original query. Run executes native SQL as written, without automatic translation. Completion now uses structured metadata, quotes names correctly and includes a bounded query snippet. Multi-line SQL strings/comments receive stateful highlighting.

Portable SQL is a deliberately bounded grammar, **not a universal SQL translator**. CTEs, subqueries, casts, writes, engine-specific functions and unsupported semantics remain native SQL workflows. Comments/hints are omitted from generated SQL. Collations, types, arithmetic, NULL ordering and other engine semantics can still differ; review and test the generated query.

**SQL Server now has a native TDS adapter and live integration coverage.** DuckDB adapter work is deferred; its SQL generation remains preview-only. See [the engine plan](docs/sql-engines-plan.md) for the remaining implementation and acceptance gates.

Main-engine verification now has dedicated commands: `bun run engines:check`, `bun run engines:up`, `bun run engines:test`, and `bun run engines:down`. These use disposable PostgreSQL/MySQL/MariaDB fixtures with TLS and source identity guards. SQL Server can be provisioned with `bun run engines:up --sqlserver` and tested with `bun run engines:test --sqlserver`. DuckDB adapter work is deferred. See [main-engine-verification.md](docs/main-engine-verification.md) for required host permissions and exact acceptance gaps.

SQL Server supports encrypted username/password connections, schemas/tables/views, keys/indexes, bounded browsing, typed bound SQL, reviewed editing, investigation, watches and XML query plans. Explicit read-only/Production connections require a dedicated restricted login. `require` skips certificate validation for trusted endpoints; `verify-full` uses Rustls/native certificate trust. Cancelling SQL Server closes its connection, and server cancellation is not confirmed. DDL/routines and historical restoration are unavailable for the new adapters. CodeMirror now uses maintained native SQL dialect parsers and keyword completion.
