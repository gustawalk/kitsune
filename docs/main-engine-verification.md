# Main engine verification

The main engines are PostgreSQL, MySQL, MariaDB and SQL Server. SQLite remains supported. DuckDB adapter work is deferred at the user's request.

## Implemented and exercised

- PostgreSQL/libpq: live metadata, primary/composite/foreign keys, typed values, read-only rejection, reviewed restoration and diagnostics.
- MySQL 8.4 and MariaDB 11.4/Connector-C: live encrypted connections, catalog/relationship traversal, large unsigned integers/decimals/binary/null values, read-only rejection, diagnostics, externally modified record watches, pause/resume, timeout/cancellation recovery and reconnect.
- SQL Server 2022/Tiberius: live encrypted authentication, read-only login checks and actual server-denied writes, schema/index/composite-key discovery, relationship expansion, bound queries, exact signed integers/negative decimals/binary/date/null values, cell conflict checks, bulk edits, XML estimated plans, external-change watches, timeout/cancellation recovery and reconnect.

These are Linux backend/IPC integration results against disposable servers. A separate native WebKit/WebDriver smoke test connected to all four engines, rendered their visible table grids, opened the SQL editor and executed a SQL Server query through the actual Run button, using isolated application data. This is not complete graphical or cross-platform acceptance. Generated writes still require review; no source database is silently modified. Dedicated fixture identity markers are checked before tests mutate any record.

## Important limits

MySQL/MariaDB `verify-full` now fails closed **before connecting**. Live testing found Connector/C 3.4 skips CA/hostname checks on private/local endpoints even with its verification option enabled. The adapter therefore cannot claim strict peer verification; the UI offers encryption-only `require` for trusted endpoints and explicit `disable`. Never downgrade an untrusted connection to work around this restriction. This limitation remains until a driver with a verified strict handshake is introduced.

SQL Server uses a maintained TDS client, not the PostgreSQL or SQLite drivers. Native SQL is parsed into an AST. Read paths reject DML, SELECT INTO, table-valued/external or unknown functions and cross-database relations. Explicit read-only/Production connections also require a login without write/schema permissions; ApplicationIntent is not a security boundary. Views and privileged external effects still require restricted roles. Cancellation closes the connection; server cancellation is not claimed, and interrupted writes report uncertain outcomes. A later independent query can reconnect; an interrupted multi-step transaction cannot continue on a fresh connection.

SQL Server estimates use typed, unassigned parameter declarations because SHOWPLAN with an RPC does not return the requested parameterized plan. The preview labels this limitation; actual measurement uses real bound values. DDL/routines and historical restoration are unavailable for SQL Server/MySQL/MariaDB. Results are bounded; oversized SQL Server results fail and close the connection instead of transferring unbounded rows.

## Repeat the live tests

Requirements: Bun, stable Rust, Docker/Compose, OpenSSL and MariaDB Connector/C 3. PostgreSQL requires libpq. Native user-connected databases and application metadata are never mounted into the fixtures.

```sh
bun run engines:check
bun run engines:up --sqlserver
bun run engines:test --sqlserver
bun run engines:down
```

The isolated `kitsune-engine-tests` project uses loopback ports 55432 (PostgreSQL), 53306 (MySQL), 53307 (MariaDB) and 51433 (SQL Server). MySQL/MariaDB require TLS using short-lived self-signed fixture certificates. Certificate files are readable by container service accounts; their host parent is mode 0700 and Git-ignored. They are disposable test keys, never production credentials. The optional SQL Server fixture uses Microsoft's Developer image and its required EULA setting, with separate read/write and read-only test logins.

The runner selects exact Rust test names and rejects zero-test matches. PostgreSQL can use a project-local extracted libpq at `.kitsune-engine-tests/lib/usr/lib` for testing without a system installation; the runner adds this directory to its child process library path. A normal desktop launch still needs system libpq or an explicitly configured loader path. This delivery did not install system packages.

The earlier managed sandbox restrictions were removed by the user. Network, sockets, Docker and live tests now work; further permission changes are not currently needed.

## Remaining acceptance

Verify native desktop keyboard/modal/clipboard flows, Windows/macOS installers and native client loading, trusted production certificate chains, SQL Server diagnostics across more server versions, custom/nested types and detailed performance measurements. MySQL strict certificate verification remains unavailable rather than silently bypassed. The current adapters are bounded implementations, not universal vendor feature coverage.

## Native Linux smoke

With fixtures running and a graphical Linux session available, build the debug application, run the Vite development server on port 1420, and use the optional project-local tauri-driver:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --locked
cargo install tauri-driver --root .kitsune-engine-tests/tools --locked
# In one terminal:
bun run dev
# In another:
python3 tests/native-engine-smoke.py
```

The Python smoke uses standard-library WebDriver requests and genuine Tauri IPC, not mocked database responses. It opens an isolated temporary application-data profile and removes it after closing the session. Connection form typing, keyboard accessibility, detailed editing interactions and other OSes need broader GUI acceptance.
