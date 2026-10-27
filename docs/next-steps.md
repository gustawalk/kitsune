# Next deliveries

The next work should deepen the database workflow before adding more workspaces. Each delivery below has a concrete acceptance gate and builds on the current SQLite/PostgreSQL architecture.

## Delivered in this iteration

- Connection-level schema catalog: search tables/views, filter PostgreSQL namespaces, inspect columns/defaults/nullability, keys, indexes, and both foreign-key directions.
- Full database ER diagrams and focused table relationships, with metadata-only reads, progressive loading, cancellation, partial-error reporting, pan/zoom/fit, movable cards, and resizable/collapsible details.
- SQLite source SQL inspection/copying. PostgreSQL source DDL is not fabricated when the server does not supply a definition.
- One shared Radix/shadcn Select across connection forms, editor controls, filters, paging, settings, and watch screens. Supports keyboard navigation through Radix, empty choices, numeric values, disabled choices, labels, and native required-field validation.

Full diagrams load on request: at most 200 nodes and 1,000 displayed relationships, in batches of 24 tables. Focused loading reads at most 40 tables. Filters allow inspecting another scope. Metadata that could not be loaded is marked explicitly; relationships come only from database declarations.

## 1. Verify desktop interactions and PostgreSQL parity

**Priority:** next, before adding more features.

- Run the desktop workflow with Kagura and the disposable PostgreSQL fixture: catalog → diagram → related table → data → record investigation → watch → historical observation.
- Verify Select arrow keys/typeahead, required fields, empty selection, numeric page sizes, disabled connections, nested dialogs, Escape, and focus restoration.
- Exercise large schemas, partial metadata permissions, schema changes during loading, cancellation, disconnect/reconnect, and native Wayland resizing/clipboard.
- Measure startup, idle memory, diagram layout, and grid interaction on representative datasets. Keep the schema viewer and editor lazy loaded.

**Done when:** automated service tests and desktop acceptance both pass on Linux; live PostgreSQL coverage is green; remaining platform limitations are documented with reproducible steps.

## 2. Data navigation and safe exports

**Priority:** first new feature delivery after verification.

- Preserve and extend the filter builder with typed operators and explicit AND/OR groups, binding values in Rust. Add additional regression coverage for filter-to-relationship navigation.
- Add CSV and typed JSON export with an explicit choice between the current page and a bounded filtered result. Show connection, scope, columns, and limits before export.
- Stream export work in Rust with progress, cancellation, and an explicit destination. Do not route large datasets through the webview or automatically export hidden/excluded columns.
- Add clear navigation back to the originating table/filter and persistent table column preferences.

**Done when:** composite keys, null/empty/zero, large integers, binary values, quoted identifiers, pagination, and cancelled/failed exports are tested; exports never alter source databases.

## 3. SQL execution diagnostics

**Priority:** after data navigation; independent of schema persistence.

- Replace the local SQL tokenizer with verified PostgreSQL/SQLite language support when dependencies are available; add context-aware completion and reliable statement selection.
- Add source-position error highlighting and a per-statement outcome panel that distinguishes committed statements, rolled-back statements, cancellation requests, and uncertain outcomes.
- Add an estimated-plan viewer: PostgreSQL `EXPLAIN (FORMAT JSON)` and SQLite `EXPLAIN QUERY PLAN`. Do not execute `ANALYZE` automatically.
- Preserve original connection context when reopening history and improve saved-query organization without persisting sensitive bound values by default.

**Done when:** the diagnostic workflow is tested on both databases; estimated-plan inspection does not silently execute source writes; large plans remain navigable.

## 4. Schema and investigation refinements

**Priority:** after the first parity gate; can be delivered independently of exports.

- Persist schema diagram layouts by connection and qualified table identity, storing positions/references rather than records.
- Add search/highlighting within a diagram, relationship selection, and keyboard navigation between related tables.
- Extend metadata with foreign-key update/delete actions, check constraints, generated columns, expression index definitions, and richer PostgreSQL view/table definitions. Clearly label generated DDL previews.
- Make graph limits configurable within hard safety bounds; preserve cycle detection, deduplication, composite keys, and explicit incomplete-scope indicators.

**Done when:** saved layouts survive refresh/restart, removed tables are explained, metadata stays accurate across database-specific naming rules, and no name-based heuristic is presented as a declared foreign key.

## 5. Watch reliability and capture profiles

**Priority:** before wider production use.

- Add reusable capture/exclusion profiles and configurable concurrency/resource limits.
- Implement safe read-connection recovery with backoff; maintain clear observation gaps and fresh baselines after failures.
- Add optional automatic watch resume, explicitly disabled by default, with clear capture consent and connection availability handling.
- Improve retention accounting, compaction controls, and low-disk tests. Distinguish retained payload limits from allocated SQLite file size.

**Done when:** disconnect/restart, queued cancellation, persistence failure, retention failure, and reconnect races cannot resurrect stopped watches or generate synthetic deletions.

## 6. Distribution and credential storage

**Priority:** release readiness; parallel planning is possible, implementation should follow platform verification.

- Expand cross-platform credential-vault build and runtime verification. The current implementation uses native OS credential stores and keeps session-only credentials when vault access is unavailable; plaintext fallback is prohibited.
- Verify libpq/TLS distribution and native installers on Linux, Windows, and macOS. Review the current `.app` identifier warning before macOS distribution.
- Add cross-platform CI gates, desktop smoke tests, and dependency/update checks. Publish only after review of actual artifacts and verification evidence.

**Done when:** credentials are absent from ordinary metadata/logs/exports, each supported platform has real build/test evidence, and installation prerequisites are accurate.

AI SQL, cloud accounts, CDC, automatic historical restore, and Replay exports remain future work. They should not displace reliability and the integrated investigation workflow.

## Requested database expansion

Database selection is now a separate first step; existing connection editing still opens its settings directly. PostgreSQL, SQLite, MySQL, MariaDB, and SQL Server have adapter implementations; engine-specific integration coverage and packaging should continue to expand. Each adapter must retain connection lifecycle, typed decoding, real catalog/key/index metadata, safe generated queries, paging, enforced read-only behavior, investigation traversal, and watch compatibility. DuckDB is deferred.

Diagram framing now uses a readable initial scale centered on the selected table, retains an explicit Fit all overview, and recomputes automatic framing after metadata/layout or canvas-size changes until the user moves the view. Focus selected restores record context without shrinking the whole schema.

## Latest agreed order

The current delivery implements shared themed controls, strict observed-state restoration, and query diagnostics. The next product work is workspace/grid polish (context menus, keyboard workflows, persistent column preferences, saved diagram/panel layouts), followed by MySQL/MariaDB. Filters/exports remain useful backlog items but are not the selected next priority. Existing live PostgreSQL/desktop/platform verification gates still apply.

## Workspace tools follow-up

The grid/workspace delivery, typed grouped filters and presets, bounded exports, diagnostic comparisons, and timed/grouped watches are implemented; see delivery-next-tools.md for precise scope. Current follow-up work is cross-engine integration coverage, graphical desktop acceptance, and other-platform packaging. Large-schema performance remains bounded by the diagram's deliberate node/edge limits; investigation into viewport-level graph rendering is a future improvement if real workloads justify it.

## Current performance and exploration follow-ups

- Keep the frontend request cache and mounted tab window bounded; collect representative startup, memory, scrolling, editor-input, tab-switch, and diagram interaction measurements before increasing cache or retention limits.
- Keep exact table counts explicit and user-triggered. Add database-specific row estimates only where their accuracy and staleness can be communicated clearly.
- Extend query result streaming/paging for engines where the driver supports safe, repeatable retrieval without re-executing statements with side effects. For arbitrary SQL, keep explicit truncation and safe failure behavior rather than rewriting user queries.
- Add cross-platform tests for secure credential storage and recovery from locked/unavailable OS keyrings.

## Main-engine verification update

PostgreSQL, MySQL/MariaDB and SQL Server have live integration evidence and Linux native WebKit smoke coverage. SQL Server's TDS adapter is implemented; DuckDB is deferred. Earlier unavailable-driver/network blockers are resolved. The maintained CodeMirror dialect package is in use. Remaining constraints, including intentionally unavailable MySQL verify-full, are documented in main-engine-verification.md.
