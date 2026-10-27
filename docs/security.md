# Security boundaries

Kitsune is a local desktop application handling potentially sensitive databases. This implementation has automated safety tests, not a production security certification.

## Credentials and local data

Passwords are session-only by default. The saved-connection serializer excludes the password field. When **Remember password securely** is enabled, Rust stores/retrieves the password through the native credential store: Secret Service on Linux, Windows Credential Manager, and macOS Keychain. An unavailable or locked store returns an error; there is no plaintext fallback. Remembered passwords are never returned by bootstrap or exposed to general frontend state. Passwords remain in Rust session memory until disconnect/drop; memory is not explicitly zeroized and crash dumps are outside the application's protection. Turning the option off removes the associated credential; deleting a remembered connection removes it before deleting the saved settings.

The frontend has no SQL plugin, shell permission, general filesystem permission, or direct database driver. Tauri exposes application operations under a restrictive CSP and minimal capabilities. Rust's PostgreSQL library loader uses fixed library names and documented macOS locations.

Unix application directories/files use 0700/0600 permissions. SQLite history is not encrypted. Explicit full-value capture, saved SQL, restored SQL tabs, filters, and record references can hold sensitive information. Column-name exclusions are a safeguard, not comprehensive content classification or anonymization.

Structured logging accepts an allowlist of operational fields. Arbitrary Debug fields, SQL, connection strings, identifiers, and result values are not recorded. There is no remote telemetry, cloud synchronization, or sensitive OS notification channel.

## Source database safety

Production defaults read-only, enforced by read-only SQLite file handles/prepared-statement checks or PostgreSQL read-only transactions. Monitoring always uses the read path. Development, Staging, and Custom default writable by project choice.

Session write enablement requires explicit confirmation. Destructive and unclassified SQL requires a short-lived one-use approval bound to exact SQL, parameters, connection, and session. Transaction/session controls are engine-specific: MySQL/MariaDB supports isolated per-tab sessions; other adapters block manual transaction controls. Attaching files and unsupported external-file modes are blocked. Statement classification alone is not the read-only boundary.

PostgreSQL read-only transactions do not sandbox privileged functions, external network calls, or every possible side effect. Restricted database credentials remain necessary. The application does not promise that arbitrary SQL invoked with a powerful database role is harmless.

Generated operations bind values and quote identifiers. Record SQL opens with typed bound parameters; parameters are omitted from saved workspace/query/history records. Scripts commit each statement separately and stop on failure. A commit acknowledgement failure must be verified on the source before retrying. Local history failures never replace successful database outcomes.

SQLite source journal mode and PRAGMAs are not silently changed. Managed SQLite connections enable foreign-key enforcement through connection-local sqlite3_db_config; source PRAGMAs, journal mode and persistent database settings are not changed.

## Capture and deletion

Production full-value capture requires per-watch authorization. Development authorization cannot silently become production authorization when connection labels change. Automatic exclusions cover password, secret, token, private_key, and ssn column-name patterns plus explicit column exclusions for all watch types. Nested JSON/text secrets and misleading aliases may bypass naming heuristics; use metadata-only mode or explicit projections for sensitive data.

Polling is observational. Result membership changes are not proof of database insertion/deletion, and observation timestamps are not transaction timestamps. Failed/oversized observations do not generate deletion events.

Retention bounds stored event payloads and query history. Full events exceeding 1 MiB retain metadata only. Cleanup failure stops monitoring; persistence errors stay visible in runtime state. Clear-history operations remove logical records, with secure-delete enabled for the internal database. SQLite file allocation, operating-system caches, backups, and snapshots may remain; this is not a forensic-erasure guarantee.

## Verification limits

Live PostgreSQL, native graphical operation, platform credential facilities, and Windows/macOS packaging require additional verification. See [validation](validation.md). Do not treat the current test suite as proof of complete adversarial SQL isolation or cross-platform production readiness.

## Reviewed watch restoration

Restore is an explicit source write, separate from read-only observation. It requires full-value provenance, a reliable identity, live write permission and review of generated SQL/current/proposed values. Captured newer values must still match. Incomplete captures support only safe field changes; excluded values are neither disclosed by restore previews nor overwritten. Complete Record Watch capture is required for inverse insertion/deletion. Metadata-only history, legacy provenance gaps, arbitrary query projections, unsupported values, active triggers and mutating cascades are ineligible. PostgreSQL partition/inheritance/RLS cases are conservatively blocked. Database roles and external-function restrictions still matter; this is not a general sandbox or rewind mechanism.

Restoration approvals are single-use, expire after 120 seconds, are bound to source event contents/session generation, and cannot be reused through ordinary table mutation approvals. Explicit history clearing invalidates them. Source transactions verify the result before commit; unavailable local receipts do not turn a committed source write into a retryable failure. Diagnostics do not persist plans or execute measurements automatically. EXPLAIN ANALYZE executes the eligible query and can consume resources; read-only transactions do not sandbox arbitrary external effects of privileged functions.

## Explicit local filters and exports

Saved filter presets and restorable workspace filters contain user-entered values in local metadata. Their persistence is intentional and visible; do not put secrets in saved filters. Grid/panel/diagram layout documents contain references and geometry, not record contents.

Export chooses a bounded scope and explicit columns. Name-based secret detection and configured column exclusions require explicit authorization to include those columns; naming heuristics do not detect secrets nested in JSON or disguised aliases. CSV spreadsheet protection prefixes formula-like text; typed JSON is preferable for lossless round-tripping. Exported files contain plaintext user data by explicit request and are not encrypted. Unix files are created with mode 0600. Atomic publication refuses overwrite; errors remove the temporary file, without a forensic-erasure guarantee.

## MySQL/MariaDB

The Rust worker owns credentials and transport. Driver errors are redacted into stable categories. Rustls verify-full enforces CA and hostname checks; require explicitly provides encryption without verification. TLS failures never trigger a downgrade. Passwords remain session-only unless the user explicitly opts into OS credential storage.

Generated reads use server read-only transactions; native read-only sessions also use server read-only defaults and AST checks. Managed edits require InnoDB and reject visible triggers. Historical restore additionally rejects cascading/SET NULL incoming relationships and checks captured data under locks. Grants may hide trigger metadata; privileged functions can have external effects. This is not a general SQL sandbox. Native reviewed DDL/routines/multi-table writes are available and can commit implicitly. Native SQL tabs own isolated connections; closing a transaction requires confirmation. KILL QUERY is requested on cancellation/timeout before discarding the connection; UI does not claim server-confirmed cancellation. Never automatically repeat a write after an uncertain outcome.

Portable SELECT generation is an explicit SQL-editor workflow. It is not a backend application-generated data operation: backend browsing/editing still binds all values. Translation does not execute, expand privileges, import SQL or remove write confirmations. SQL Server now has a tested TDS adapter; DuckDB output is preview-only and cannot create a connection.

## SQL Server boundary

SQL Server has a separate Rustls/TDS transport, AST-based supported-query checks and credential permission checks for explicit read-only/Production connections. The fixture read-only account is tested against actual server-denied DML; a writable account is rejected for that mode. Unknown/qualified functions, external/table-valued functions, cross-database references and SELECT INTO are rejected in read paths. This is not a sandbox for privileged server code or view/UDF side effects; restricted roles remain necessary. User SQL never controls session state, SHOWPLAN toggles or transaction commands.

Timeout/cancel closes the SQL Server connection; acknowledgement of a server Attention cancellation is unavailable. Interrupted writes are reported as uncertain. Lost multi-call transactions are invalidated instead of being committed on another connection. Later independent reads can reconnect. Original SQL text is preserved while placeholders are adapted lexically; values are bound through TDS. Native driver errors are redacted.

MySQL/MariaDB now uses mysql_async/Rustls rather than Connector/C. verify-full checks CA and hostname without fallback, including private endpoints. Custom CA files replace default trust; optional client identities remain file-based in Rust. require explicitly provides encryption without certificate verification. Certificate/key paths are saved, their contents and passwords are not.
