<p align="center">
  <img src="src-tauri/icons/128x128.png" width="80" alt="Kitsune fox icon" />
</p>

<h1 align="center">Kitsune</h1>

Kitsune is a local-first desktop database client for developers. Browse tables, write SQL, follow a record’s relationships, watch it change, and inspect the observations in one workspace.

Built with Tauri 2, Rust, React, and TypeScript. Database connections, credentials, query execution, and monitoring stay in Rust. No account, cloud service, telemetry, remote fonts, or AI integration is required.

## What you can do

- **Explore:** searchable schema catalog, table structure, indexes, composite keys, and a focused or database-wide relationship diagram.
- **Browse and edit:** server-side pagination, filters, sorting, column controls, staged multi-row editing with Apply changes, row insertion, and reviewed bulk updates/deletes. Editing requires a reliable row identity and supported transactional tables.
- **Write SQL:** CodeMirror editor, metadata completion, multiple result sets, query history, saved queries, cancellation, and execution timing. A separate portable SELECT builder previews translations between dialects before opening native SQL.
- **Referenced values:** hover a foreign-key column header and use its link button to choose a field from the referenced table. Labels apply to the whole page and the choice is saved locally. Choose **Original value** to restore IDs; copying, sorting, editing, and navigation use the original keys.
- **Investigate:** start with a record and lazily expand declared incoming/outgoing foreign keys. Save references and graph positions locally.
- **Observe:** record, bounded-table, and read-only query watches, with pause/resume, backoff, exclusions, and configurable capture/retention.
- **Review:** Time Machine shows captured before/after fields. Eligible SQLite, PostgreSQL, and MySQL/MariaDB events can generate a reviewed, conflict-checked inverse operation.
- **Diagnose:** estimated plans and explicitly requested measurements, with database-specific cost units. Estimated cost is a planner estimate, not a monetary charge.

The interface includes dark/light theme choices, immediate appearance previews, themed Radix/shadcn controls, Lucide icons, native file pickers, a command palette, and keyboard shortcuts.

## Database support

| Engine          | Connectivity and exploration                                         | SQL execution                                                       | Important boundaries                                                                                                    |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| SQLite          | Existing files, explicit creation, read-only mode, tables/views/keys | Managed statements and scripts                                      | External-file helpers, arbitrary PRAGMAs and manual transaction controls are blocked                                    |
| PostgreSQL      | libpq, schemas, TLS, native metadata                                 | Managed statements and scripts                                      | Each statement has a managed transaction; manual editor transactions are not available                                  |
| MySQL / MariaDB | Rust wire-protocol driver, strict TLS, native catalogs               | Native SQL, DDL, routines, multi-table writes, per-tab transactions | Managed edits/restores require InnoDB and reject visible triggers; restores guard cascading writes to referenced fields |
| SQL Server      | Rust TDS driver, native catalogs, TLS                                | Supported reads and transactional DML                               | Restricted credentials required for enforced read-only mode; DDL/routines and historical restore are unavailable        |

The automated server fixtures target PostgreSQL 17, MySQL 8.4, MariaDB 11.4, and SQL Server 2022. Support does not imply every vendor extension, version, authentication plugin, or deployment has been certified. DuckDB connectivity is deferred; its portable SQL preview is not a database adapter.

## Install

The [desktop build workflow](https://github.com/gustawalk/kitsune/actions/workflows/build-desktop.yml) produces Windows and Linux packages. Successful manual runs retain downloadable artifacts for seven days; tagged builds publish release assets and remove temporary platform artifacts. Check the run’s status before downloading.

- **Windows:** extract the `kitsune-windows` artifact and run `Kitsune_*_x64-setup.exe`. The installer and installed `Kitsune.exe` carry the Kitsune icon and product name. Installers are currently unsigned.
- **Debian/Ubuntu:** extract `kitsune-linux`, then run `sudo apt install ./Kitsune_0.1.0_amd64.deb`.
- **Other Linux distributions:** make the AppImage executable and launch it. Without FUSE, use `APPIMAGE_EXTRACT_AND_RUN=1 ./Kitsune_0.1.0_amd64.AppImage`. The upstream AppImage launcher currently uses X11/XWayland; the native build can use the host Wayland backend.

macOS packaging is not verified. See [build and installation details](docs/desktop-builds.md) and [executed validation](docs/validation.md).

## Updates and releases

Packaged desktop builds check for signed updates at startup. Settings → General shows the installed version, checks again, and displays patch notes.
Review the release notes and choose **Update Kitsune** to install and restart.
Save unsaved SQL tabs and finish active transactions first.

Tagged releases publish signed Windows NSIS and Linux Debian/AppImage packages
plus `updater.json`. See [release setup](docs/desktop-builds.md#updater-signing-and-version-releases)
for signing secrets and versioning. The first updater-enabled build needs a manual
installation. Updates download from Kitsune’s public GitHub Releases.

## Start investigating

1. Add a connection. Use the file picker for SQLite, or enter server settings. Test and connect. Passwords are session-only by default; **Remember password securely** lets you choose the OS credential manager or an encrypted local vault.
2. For server databases, you can paste a connection URL when adding a connection. Double-click a saved connection or choose **Quick connect** to connect without opening its settings. Saved passwords load from the keyring or unlocked local vault; otherwise a compact dialog asks for credentials.
3. Search the sidebar and open a table. Select a record to inspect it, double-click a supported cell to stage edits across records, then use **Apply changes** above the table, or choose **Investigate**.
4. Expand a declared relationship in Detective. Start a watch on the selected record.
5. Change the record from your application or another client. Open **Live Watch** and **Time Machine** to inspect the captured fields and observation timestamps.
6. Save the investigation to reopen its references and layout later.

Time Machine opens on **Data changes**; choose **All events** or **Watch lifecycle** to see start, stop, baseline, and failure messages. Wait for **Baseline ready** before making a test change. Choose **Yes · save values for comparison** under **Save record values on this device?** to save values; metadata-only capture saves field names. New query watches default to **Old and new values for each record** and ask which table contains the records. Select the table and include all of its primary key (or non-null unique key) columns with their original names. Each key must appear only once in the result. Choose **Rows added to or removed from the results** for aggregates or queries without a unique row identity. In that mode, an update appears as an old row leaving and a new row entering the result, each with only one state. **Outside result** and **Record absent** describe those missing sides; they are different from values that were not captured. Existing metadata-only events cannot recover omitted values.

Expandable **How to…** guidance in the table, SQL, schema, investigation, and watch workspaces explains the main controls. Icon buttons expose their action on hover and keyboard focus.

Polling can miss intermediate changes, including a row inserted and deleted between polls. Time Machine contains only observations captured by Kitsune; it is not a complete audit log or a database backup.

### MySQL / MariaDB transactions

Each SQL tab owns a separate session, isolated from table browsing, watches, and other tabs. Click **Begin transaction** or execute `START TRANSACTION`. An active banner and **TX** tab marker remain visible until the server reports completion. **Commit** requires SQL review; **Roll back** discards the transaction. Closing a tab with an active transaction asks for confirmation and closes its connection.

DDL and some native statements commit implicitly on these engines. Kitsune reports when a statement ends an active transaction; rollback cannot reverse an implicit commit. A timeout, error, or connection loss discards the session and marks an active transaction as lost. Verify uncertain writes before retrying. Up to four SQL sessions are allowed per connection.

Native scripts support `DELIMITER` directives for compound routines and preserve each result set returned by `CALL`. For application-generated quoting, sessions enable `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES`; use single-quoted strings with doubled quote escapes. Changing those SQL modes yourself can invalidate editor parsing assumptions.

## Keyboard shortcuts

| Shortcut             | Action                        |
| -------------------- | ----------------------------- |
| Ctrl/Cmd + K         | Command palette               |
| Ctrl/Cmd + P         | Search connections and tables |
| Ctrl/Cmd + Shift + F | Workspace search              |
| Ctrl/Cmd + T         | New SQL tab                   |
| Ctrl/Cmd + W         | Close current tab             |
| Ctrl/Cmd + Enter     | Execute selected/current SQL  |
| Ctrl/Cmd + S         | Save query                    |
| Ctrl/Cmd + ,         | Settings                      |
| Escape               | Dismiss overlay               |

## Security and local data

Production connections start read-only. Enabling writes requires an explicit session decision; destructive/unclassified SQL requires a short-lived approval bound to the exact SQL, parameters, connection, and SQL session. Prefer restricted database roles. Read-only execution is not a sandbox for privileged functions or external side effects.

MySQL/MariaDB connections default to **verify-full**: certificate chain and hostname validation, system/public trust roots, or an explicitly selected custom CA. A custom CA replaces default trust roots. Client certificate/key files can also be selected. **require** means encryption without certificate verification; existing saved choices are preserved. There is no silent TLS downgrade.

Plaintext passwords are never written to Kitsune metadata. Remembered passwords use either the OS credential manager (Secret Service on Linux, Credential Manager on Windows, Keychain on macOS) or the **encrypted local vault**. To use the vault, select it under connection settings → Remember password securely → Password storage. Create a master password of at least 12 characters, then unlock once per app session; vault controls are also available in Settings. This master password is separate from your database password. Unlocking the vault automatically fills the saved database password for the current connection, masked in the password field. You can edit it to replace it. Autofilled passwords are cleared from the form when you lock the vault. Kitsune derives the vault key with Argon2id (64 MiB, 3 passes, 1 lane) and encrypts credentials with XChaCha20-Poly1305 using fresh random nonces. The key stays in Rust memory and is cleared on lock or exit; the master password is never saved. A forgotten master password cannot be recovered. Locking does not close existing database sessions. Changing a connection’s storage option requires re-entering its database password and keeps any old entry in the previous store. Vault ciphertext and its public salt/nonce are stored in the metadata database; secure credential storage never falls back to plaintext. Metadata, SQL history, and captured values remain local and are **not encrypted at rest**; SQL text and record references may themselves be sensitive. History can be disabled or cleared. Production watches default to metadata-only capture. Column exclusions help reduce capture but cannot discover every secret embedded in text or JSON.

Cancellation closes interrupted transports where necessary and does not promise server-confirmed cancellation. Never automatically retry a write whose outcome is uncertain. Restore previews are not backups; they recheck current data and schema and can refuse unsafe operations. Read [security boundaries](docs/security.md) before connecting to sensitive systems.

## Develop

Requirements: Bun, stable Rust, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). Linux development needs GTK 3 and WebKitGTK 4.1 development packages. PostgreSQL needs libpq (`postgresql-libs` on Arch, `libpq5` on Debian/Ubuntu). SQLite is bundled; MySQL/MariaDB and SQL Server need no native client-library installation.

```sh
bun install --frozen-lockfile
bun run tauri dev
```

`bun run dev` starts the frontend in a browser. Database operations require the desktop runtime; browser preview does not provide substitute data.

```sh
bun run typecheck
bun run types:check
bun run lint
bun test
bun run test:rust
bun run test:contracts
bun run format:check
```

Use `bun run types:generate` after changing Rust IPC models and `bun run format` to format the project. On Windows, `test:rust` embeds the Windows SDK activation manifest required by Tauri’s test harness.

### Live integration tests

Docker Compose and OpenSSL are required. These commands create disposable databases on fixed loopback ports, verify a fixture identity before mutations, and remove their volumes afterward. They do not use saved connections.

```sh
bun run engines:check
bun run engines:up --sqlserver
bun run engines:test --sqlserver
bun run engines:down
```

Windows CI additionally runs checksum-pinned portable MySQL/MariaDB servers without installing services. See [engine verification](docs/main-engine-verification.md).

### Build

```sh
bun run build
bun run tauri build
```

Packages appear in `src-tauri/target/release/bundle/`. For distributable packages with staged libpq dependencies, follow [desktop builds](docs/desktop-builds.md). A Linux build does not verify Windows or macOS.

## Architecture and project status

Rust owns connection pools/sessions, execution, metadata, monitoring, diffs, retention, and a separate migrated SQLite metadata store. The typed Tauri IPC boundary connects to React’s workspace, editor, grids, graphs, and timelines. The application does not install source triggers, extensions, or replication infrastructure.

- [Architecture](docs/architecture.md)
- [Database adapters](docs/database-adapters.md)
- [Security](docs/security.md)
- [Product review and measurements](docs/product-review.md)
- [Validation evidence](docs/validation.md)
- [Roadmap and known gaps](docs/roadmap.md)

Kitsune is under active development. The full original 0.1 specification is not certified complete. Remaining work includes broader graphical acceptance/accessibility checks, additional database types and server versions, secure credential-vault integration, macOS builds, and performance measurements across real workloads. Cloud services, telemetry, AI-generated SQL, full CDC, and automatic restoration are outside the current scope.

Workspace tabs can be dragged to reorder them. Right-click a tab for move-left/right and close-tab/others/left/right/all actions. Closing unsaved SQL or an active transaction still asks for confirmation; cancelling stops the remaining bulk close operation.

For Time Machine restoration, start or resume a full-value watch and capture a new change. Direct-column SELECT queries from the schema-qualified identity table can now restore changed fields after review. Joins, calculated/renamed fields, query result entry/exit, and events without verified source metadata cannot be restored as table writes. When restoration is unavailable, the timeline shows the reason. Use the watch dialog’s example query or a record/table watch to capture restorable history.
