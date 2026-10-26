# Verification evidence

Verification date: 2026-10-25. Linux x86_64, Bun 1.4.0, Rust 1.93.1, GTK 3.24.52, WebKitGTK 2.52.6.

## Executed successfully

Final default Rust suite: **32 passed**, with the live PostgreSQL test and contract-export helper deliberately ignored. The helper passed separately through `test:contracts`, validating twelve service responses. Frontend suite: **25 passed**. Formatting, generated types, TypeScript, and Clippy checks passed.

- Frontend production compilation with strict TypeScript and Vite.
- Frontend domain/state/validation tests: SQL selection, lossless values, composite identities, identifier quoting, malformed responses, settings bounds, tab state, graph deduplication, reference-only graph persistence, and historical state comparison.
- Rust unit/integration tests with real temporary SQLite files. These cover metadata, composite and eligible unique keys, source read-only enforcement, filters, paging, interruption/reuse, capture exclusions, result-order independence, retention, metadata corruption, and settings validation.
- Native-service integration through Tauri's mock **window runtime**, with real SQLite operations: connect, inspect an order, expand incoming/outgoing foreign keys, save an investigation, poll, update externally, detect and persist before/after changes, pause/resume, disconnect/reconnect, and restore workspace references.
- Regression checks for exact/single-use/session-bound SQL review, Production read-only mode, explicit capture consent, Development-to-Production consent separation, and successful SQL despite unavailable local query-history storage.
- `bun run test:contracts` generates twelve real service responses from SQLite and validates them against frontend Zod schemas. This checks the actual IPC JSON boundary rather than only handwritten TypeScript assumptions.
- Rust Clippy with warnings denied, frontend type checking, generated-contract checking, and source formatting checks are part of the final check sequence.
- Native icon generation completed for PNG, ICO, ICNS, and Tauri's platform icon variants, all from the recolored source SVG.
- A Linux optimized release executable and Debian package were produced by `bun run tauri build --bundles deb`. Artifacts are under `src-tauri/target/release/`.

Exact final command results and counts should be read from the delivery report; the live PostgreSQL test is deliberately ignored in the default suite, and the contract-export helper is run separately by its script.

## Environment blocks and unverified behavior

- `docker info` failed with permission denied on the Docker socket. No live PostgreSQL service was available, and libpq was not installed in this environment. The opt-in PostgreSQL fixture test was not reported as passing.
- Vite's development listener failed with `EPERM` binding localhost port 1420. This is an execution-environment restriction, not a successful desktop-development smoke test.
- Chromium failed before rendering because sandbox socket operations were denied. No screenshots or rendered-component/browser tests were produced.
- Launching the compiled executable with the Wayland backend failed during GTK initialization. Native launch, window persistence, focus, clipboard, resizing, accessibility, and the visual database workflow therefore remain unverified.
- Windows/macOS compilation, signing, notarization, installers, and libpq loading were not tested.
- Disk-failure behavior is partly covered using read-only internal storage; this is not a full filesystem-full fault-injection test.
- No usable Git metadata was mounted. No commits or remote operations were performed.

## Measurements

An observed frontend production build completed in approximately 1.8 seconds. A clean native release build completed in approximately four minutes. Those are environment-specific build times, not startup measurements.

The SQL-editor chunk is lazy loaded and was approximately 402 kB raw / 130 kB gzip in a measured build. The initial application JavaScript was approximately 475 kB raw / 142 kB gzip; styling approximately 55 kB raw / 11 kB gzip. These values can change with final changes and dependency versions.

Startup latency, idle process RSS, frame timing, and real-grid interaction latency could not be measured because graphical launch was blocked. No unmeasured performance target is presented as achieved.

## Manual desktop acceptance on an unrestricted host

1. Install platform prerequisites and libpq; launch with `bun run tauri dev`.
2. Connect to the disposable SQLite fixture, browse data/structure, filter, sort, page, resize/reorder columns, and inspect large values.
3. Execute selected/current SQL, cancel a long statement, save a query, reopen history, and verify errors and sequential-script outcomes.
4. Investigate order 5821; expand its customer, items, products, and payments; check the address/customer cycle and composite-key fixture.
5. Save and reopen the investigation, move nodes, and verify labels/values are fetched afresh.
6. Watch the order, update its status externally twice, and compare captured states in Time Machine. Repeat with metadata-only capture and excluded fields.
7. Test query/table scope overflow, unkeyed result reordering, pause/resume, delete, clear history, retention, and disconnection during polling.
8. Restart; verify paused watches, restored tabs/geometry, and a fresh credential prompt.
9. Repeat the workflow against the isolated PostgreSQL fixture, including TLS configuration, JSONB/numeric/bytea/arrays, cancellation, read-only DML-in-CTE, and connection loss.
10. Check light/dark/system themes, all shortcuts, dialog focus, keyboard-only operation, Wayland resizing/clipboard, and Production write/capture review.

## Schema/select iteration

Added real SQLite service tests for schema details, incoming relationships, actual source SQL, composite keys, missing tables, malicious identifier text, batch limits, and queued cancellation. A read-only schema request leaves the source file byte-for-byte unchanged in the integration fixture. SQLite nullability checks distinguish legacy composite keys, rowid aliases, descending primary keys, STRICT tables, and WITHOUT ROWID tables.

Frontend tests cover catalog filtering, namespace identity, composite foreign-key edges, cycles/self-references, unavailable references, graph limits, schema-tab reuse, and server-rendered select semantics (required/disabled controls, raw numeric form values, zero, and empty placeholders). These are not a claim that live keyboard/focus interactions were browser-tested.

A separate read-only metadata/layout check on Kagura produced 30 nodes and 50 declared relationships, with no omitted edges. Only schema metadata was read; no source row contents were fetched, and the temporary schema file was deleted afterward.

The new schema workspace is lazy loaded: approximately 24 kB raw / 7.6 kB gzip in the verified build. The final Linux optimized build and Debian bundle succeeded after this iteration. No new runtime packages were added.

Native SQLite picker follow-up: 34 Rust tests passed (2 ignored: live PostgreSQL and the separately executed contract helper); 26 frontend tests passed; 12 real service response contracts validated. Type checking, Clippy, and the frontend production build passed. Picker tests verify cancellation and that selection neither creates nor replaces files. Interactive native dialog behavior still requires a desktop session; this sandbox cannot initialize the graphical application.

Connection/diagram UX follow-up: 28 frontend tests pass, including selected-table centering, readable initial zoom for large schemas, Fit all bounds, and empty/hidden canvas behavior. Type checking, generated contracts, formatting, and frontend production build pass. The connection form now uses a database-selection step and responsive configuration layout; the container focus outline from Radix is suppressed while control focus indicators remain. Native desktop interaction and visual acceptance remain manual checks in an unrestricted desktop session. No new database adapter is claimed by this delivery.

SQLite SQL-error follow-up: the supplied sprint SELECT with an unbound placeholder and UPDATE with incorrect quoting reproduce in a disposable database. The corrected UPDATE affects exactly one fixture record; failed statements leave it unchanged and the connection remains usable. Diagnostics redact raw values/paths and classify quoting, parameter-count, locking, constraint, file-format, and open failures. 36 Rust tests passed (2 ignored; the contract helper passed separately), 29 frontend tests passed, 12 IPC contracts passed, and Rust check/Clippy passed. The user's database was not modified.

Watch/tab/layout/editing follow-up: 39 Rust tests passed (2 ignored; the contract helper also passed separately), 32 frontend tests passed, and 13 real SQLite IPC response contracts passed. Type checking, formatting and Clippy passed. New coverage includes parameterized composite-key cell edits, stale-value conflicts, NULL versus empty strings, explicit confirmation, identity and read-only guards, constraint enforcement, missing query identity columns, invalid watch actions retaining their task, numeric precision, tab context, and non-overlapping diagram groups. No connected user database was modified. Interactive desktop visual/keyboard acceptance and live PostgreSQL edit verification remain outstanding because those environments are unavailable in this sandbox.

Disconnected-state presentation follow-up: fixed shared alerts stretching vertically inside the row-oriented workspace. Table disconnection is now a neutral, centered state with a Reconnect action that opens the existing connection settings. Actual errors remain compact alerts with wrapping text and retry controls. Type checking and all 32 frontend tests passed; desktop visual confirmation remains pending.

Schema gesture follow-up: 36 frontend tests pass, including click jitter, zoom-aware dragging, return-to-origin drag suppression, pointer identity/cancellation, viewport-sized edge rendering and keyboard button semantics. The old title-button-only selection and uncaptured window drag listeners were replaced for the schema diagram. Desktop WebKit rendering and real pointer/keyboard acceptance remain manual checks; the automated tests cover gesture logic and server-rendered markup, not a graphical browser session.

Desktop interaction follow-up: TypeScript checking, formatting, all 36 frontend tests, and the frontend production build pass. Document-level handlers suppress browser context menus and incidental image/link drags while leaving intentional column dragging and keyboard editing intact. Native context-menu behavior still needs confirmation in the desktop WebView.

Bulk rows and appearance follow-up: 41 Rust tests passed (2 ignored; contract helper separately passed), 38 frontend tests passed, and 16 real SQLite IPC response contracts passed. Type checking, formatting, generated contracts, Clippy and the frontend production build passed. New integration coverage exercises composite-key bulk updates/deletes, SQL injection values, default/automatic-key insertion, single-use and reconnect-invalidated reviews, read-only rejection, stale cells, constraints, and trigger-skipped rows causing rollback of partial writes. Appearance tests cover all seven persisted themes, device-theme resolution, and preserving unrelated settings. Real desktop clicks/visual acceptance and live PostgreSQL bulk-write behavior remain unverified in this environment. User-connected databases were not modified.

Controls/restore/diagnostics delivery: 46 Rust tests passed with 3 ignored (two live PostgreSQL tests and the separately executed IPC fixture); 41 frontend tests passed; 21 real SQLite response contracts passed. Type checking, generated types, formatting, Clippy and the frontend production build passed. Coverage includes a real watch → observed change → reviewed restore chain; composite identities; excluded fields; trigger/cascade blocks; partial capture; record recreation/removal and computed fields; schema changes; stale values; source history deletion; repeated approvals; constraints rolling back; and receipt storage failure preserving confirmed write success. Diagnostics cover parameters, rejected writes/scripts, partial measurements, timeout recovery, and queued cancellation. Control tests cover mixed/required checkbox semantics and disabled tooltip focus without native title balloons.

The existing live PostgreSQL test was explicitly attempted and failed because libpq cannot be loaded (POSTGRES_DRIVER). Docker API access was also attempted and denied by the sandbox. The new PostgreSQL >=12 restore/diagnostics fixture is provided but not executed here. Native graphical keyboard/hover/focus/required-checkbox acceptance across the seven themes, Windows/macOS, and live PostgreSQL remain unverified. No user-connected database was modified. Initial frontend bundle loading was reduced by lazy-loading watch/history UI; build asset sizes are not runtime performance measurements.

## Workspace tools delivery (2026-10-25)

Executed successfully: TypeScript checking, generated-contract consistency, Prettier/Rust formatting checks, Clippy with warnings denied, 45 frontend tests, 50 Rust tests, 21 real SQLite IPC response contracts, the frontend production build, and `bun run tauri build --bundles deb`. Rust's three ignored tests consist of the separately executed IPC fixture plus two unavailable live PostgreSQL fixtures. Native packaging completed with exit status 0; the first detached packaging session ended without a result and was rerun to obtain a confirmed outcome.

New automated coverage includes grouped filter precedence plus mandatory navigation scope, literal wildcard handling and invalid filters; selected-column typed exports, row bounds, exact large integers/base64/empty text, sensitive-column rejection and cancellation leaving the connection usable; diagnostic comparison/retention; duplicate-column layout keys; and real grouped/timed-watch lifecycle plus layout persistence. The watch deadline test runs against temporary SQLite with real polling and verifies a stopped definition, removed task, and lifecycle event.

Linux Debian package: `src-tauri/target/release/bundle/deb/Kitsune_0.1.0_amd64.deb`. This is a build/package check, not a successful GUI launch. Browser/Wayland interaction, native save-dialog clicks, live PostgreSQL export snapshot behavior, Windows/macOS, and runtime performance remain unverified. MySQL/MariaDB remains an unimplemented adapter; the local C ABI probe is not adapter certification. No user-connected database was modified.

## SQL engines and portable query delivery (2026-10-25)

Executed successfully: 52 frontend tests; 54 Rust unit/integration tests; the separately invoked native embedded-MariaDB fixture; 22 real SQLite IPC response contracts; generated-contract checks; TypeScript; Clippy with warnings denied; Prettier/Rust formatting; frontend production build; and Linux Tauri Debian packaging (exit status 0). The Rust default run has four ignored tests: the separately executed embedded and IPC fixtures, plus two unavailable live PostgreSQL fixtures. After moving the normal-runtime MySQL watchdog to Tokio timers, targeted MySQL tests, embedded integration, Clippy/type checking and production packaging passed again.

Portable SQL tests exercise actual SELECT ASTs, native SQLite execution, joins/predicates/aggregates, large literals, dialect quoting/paging, SQL Server Unicode/semantic restrictions, MySQL placeholder rebinding, comments/hostile strings, unsupported syntax, offsets and nesting bounds. Native MariaDB tests cover Connector/C ABI layout, redacted configuration/TLS validation, parameter binding and decoding, real composite-key metadata/relationships, cell updates and stale conflicts, read-only enforcement, row-count rollback, schema signatures, and typed watch differences. Structured completion is included in the real IPC contracts.

A socket MariaDB server was attempted but the sandbox denied socket bind. The native embedded library allowed genuine table/query/transaction tests without sockets. Repeated execution initially uncovered an embedded-library shutdown fault; process-lifetime library retention and fresh fixture directories corrected it, and subsequent runs passed. The test shuts down its server and removes the temporary database. It does not replace live client/server network/TLS verification. Debugger attachment was denied by ptrace restrictions.

SQL Server and DuckDB libraries/crates are absent and downloads fail DNS resolution. Those adapters are **unimplemented**, not merely untested. Their SQL emission is preview-only. Live MySQL/MariaDB authentication/TLS/remote cancellation, graphical keyboard/modal/autocomplete acceptance, PostgreSQL, Windows/macOS and runtime performance remain unverified. MySQL schema mutation/routines and historical restore remain intentionally unsupported. No user-connected database was modified.

## Main-engine verification preparation (2026-10-26)

DuckDB adapter work is deferred at the user's request. Added isolated PostgreSQL/MySQL/MariaDB Docker fixtures, an optional SQL Server bootstrap, generated fixture TLS certificates, source identity guards, host preflight and exact-name live-test commands. Added real client/server MySQL and MariaDB test cases for TLS, relationships, exact values, watch changes from another connection, timeout/cancellation recovery and reconnect. These new network tests compile but remain ignored/unexecuted here; SQL Server's adapter remains unimplemented.

Fixed MySQL/MariaDB cancellation requests arriving between native calls: requests are latched for the active generation and checked before preparation/execution/fetch, without cancelling later operations. UTF-8 configuration is now checked instead of silently ignoring an option failure. The expanded native embedded fixture passed cancellation-before-write with unchanged source values and the full MySQL/MariaDB bootstrap schema, including unsigned BIGINT and DECIMAL(40,20) values.

Executed successfully: 54 Rust tests (6 ignored), separate expanded embedded-MariaDB integration, 52 frontend tests, 22 SQLite IPC contracts, Clippy/type checking, strict standalone test-runner type checking, Docker Compose configuration validation, frontend production build and Linux Debian build (exit status 0). The six ignored tests comprise the separately run IPC/embedded fixtures and four unavailable live PostgreSQL/MySQL/MariaDB fixtures. Formatting was checked after documentation updates.

`bun run engines:check` was actually executed and reported BLOCKED registry DNS, loopback sockets and Docker API access; Docker Compose and OpenSSL passed. Therefore no live network/TLS success, SQL Server support, or cross-platform acceptance is claimed. The host access instructions and precise remaining work are in main-engine-verification.md. No user-connected database was modified.

## Main engines verified with host access (2026-10-26)

This entry supersedes the earlier environment-blocked status. Network, loopback and Docker preflight now pass. Implemented the SQL Server Tiberius/TDS adapter, bounded AST-validated execution, metadata/relationships, typed values, generated edits, monitoring and estimated/actual diagnostics. The SQL editor now uses the maintained CodeMirror SQL dialect grammars while preserving explicit, bounded portable-query translation as a separate workflow. DuckDB remains deferred.

Executed successfully: 53 frontend tests; 55 Rust tests (7 ignored by the default run); all five exact-name network fixtures (two PostgreSQL, MySQL, MariaDB and SQL Server); the separate native embedded-MariaDB fixture; 22 real SQLite response contracts; generated contracts; TypeScript; Clippy with warnings denied; formatting; standalone fixture-runner type checking; Compose configuration; frontend production build; debug native build; and Linux Tauri Debian packaging (exit status 0). The seven default-ignored tests were separately executed through the network, embedded and contract commands. Release package: `src-tauri/target/release/bundle/deb/Kitsune_0.1.0_amd64.deb`.

A genuine Linux WebKit/Tauri desktop smoke also passed with an isolated temporary application profile: connected to all four fixture servers through native IPC, rendered their table grids, and clicked the SQL Server editor Run query action with real results. The reproducible standard-library WebDriver script is `tests/native-engine-smoke.py`. This is not full connection-form, keyboard, clipboard or visual acceptance. No user-connected database was modified; only isolated fixture data was changed. Test containers and the temporary development server were stopped afterward.

Live testing exposed Connector/C accepting an untrusted local certificate despite its verification flag. MySQL/MariaDB verify-full now fails closed with TLS_VERIFY_UNSUPPORTED before authentication; encryption-only require remains available for trusted endpoints and is not certificate authentication. SQL Server interrupted operations close the client transport without a confirmed server cancellation acknowledgement; interrupted writes can have uncertain outcomes. SQL Server estimates use typed unknown parameters and may differ from value-specific plans. New-engine DDL/routines and historical restoration remain unsupported. Windows/macOS, broader vendor type/version coverage and runtime performance measurements remain unverified. Project-local libpq was extracted for testing; a normal desktop launch needs system libpq or an explicit loader path. No system packages were installed.

## Product review, Git and desktop distribution (2026-10-26)

Connected the project to `git@github.com:gustawalk/kitsune.git`, imported the existing application into the previously empty repository, and pushed branch main. No previous Git history was overwritten. Local credentials, databases/journals, generated runtime libraries and build outputs are ignored. The product assessment and measured native Linux footprint are in product-review.md; packaging instructions and platform limitations are in desktop-builds.md.

The manually dispatched [desktop workflow run 40331162862](https://github.com/gustawalk/kitsune/actions/runs/40331162862) completed successfully at code revision `ad3d98963f8354f883001afbe615cc13eff71e19`. Shared verification, Linux and Windows jobs passed. Publication was intentionally skipped for a manual run; no release tag was pushed. Subsequent changes only document installation/results.

Executed successfully: 55 frontend tests (including real generated-contract checks against CRLF checkouts and rejection of semantic drift); 56 Rust tests on both Linux and Windows (7 external-service/fixture tests ignored by the default suite); 22 real SQLite IPC response contracts on each OS; TypeScript, generated contracts, Clippy with warnings denied, formatting, frontend production builds, Ubuntu 22.04 Debian/AppImage builds and Windows x64 NSIS packaging. Native Windows tests genuinely executed after their Common Controls v6 manifests were embedded; no failing test was disabled. Earlier live-engine verification remains recorded above; Windows live PostgreSQL/MySQL/SQL Server workflows were not exercised by this packaging run.

The Windows job silently installed the setup into its temporary runner directory, verified installed `Kitsune.exe` and ProductName=Kitsune, checked the coral icon in the setup and installed executable, loaded installed libpq/MariaDB DLLs with their dependencies, and launched the installed application successfully for a five-second startup smoke. This does not certify every Windows GUI interaction. The Linux launcher name, command and icon are Kitsune. An earlier hosted AppImage was downloaded and launched through native WebKit automation in extract-and-run mode; driver-load probes reached genuine connection-refused errors rather than missing-library errors. A separate isolated native Linux SQLite fixture rendered its table, opened the edit dialog, saved a value, and confirmed it through another database connection. No user-managed database was modified.

Verification caught and fixed three product/portability issues: bootstrap omitted the current session write mode after a WebView reload; timed watches published stopped status before removing their task and saving the lifecycle event; and generated contract checks treated CRLF as a contract difference. Windows test executables also needed the native Common Controls manifest. An initial attempt to re-run Cargo after embedding it rebuilt the executable and removed the resource; the helper now executes the compiled harnesses directly. The original strict watch cleanup assertion remains intact and passes on both OSes.

Final downloads, copied into `src-tauri/target/release/bundle/` (not committed):

| Artifact                                |      Bytes | SHA-256                                                            |
| --------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `nsis/Kitsune_0.1.0_x64-setup.exe`      |  7,501,181 | `3cf8f3f74d9762f1c49f7dd0160d6eb50ace9baa1e0e814bb3b60ce0fb2f83c7` |
| `deb/Kitsune_0.1.0_amd64.deb`           |  5,291,798 | `4dcc788d810c82798ec5f7ea245db1ce07c617f2d03e0b04de571f9792b11bfe` |
| `appimage/Kitsune_0.1.0_amd64.AppImage` | 86,174,200 | `b64e9be13bfbe4bf2fcf9e00bdf1456410b8ba68f63edbc616207791ade16147` |

Windows downloads are unsigned. Manual-run artifacts are retained for seven days. AppImage's GTK launcher currently selects X11/XWayland; the ordinary native Linux build uses its host backend. macOS and broader native keyboard/clipboard/connection-form acceptance remain unverified. The app has moderate webview memory usage despite its compact installer; single-run native startup/idle/1–30-tab samples and their limits are documented in product-review.md. This delivery does not claim the entire original version 0.1 definition of done.
