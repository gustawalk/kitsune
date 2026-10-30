import { lookup } from "node:dns/promises";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = "kitsune-engine-tests";
const compose = [
  "docker",
  "compose",
  "-p",
  project,
  "-f",
  join(root, "compose.engines.yaml"),
];
const operation = process.argv[2] || "check";
const extra = process.argv.slice(3);
if (
  !["check", "up", "test", "down", "certificates"].includes(operation) ||
  extra.some((a) => a !== "--sqlserver")
) {
  console.error(
    "Usage: bun scripts/engine-fixtures.ts check|up|test|down|certificates [--sqlserver]",
  );
  process.exit(2);
}
const sqlserver = extra.includes("--sqlserver");
function run(args: string[], input?: Uint8Array) {
  const r = Bun.spawnSync(args, {
    cwd: root,
    stdin: input,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0)
    throw new Error(
      `Command failed (${r.exitCode}): ${args[0]} ${args[1] || ""}`,
    );
}
function available(args: string[]) {
  try {
    return (
      Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" })
        .exitCode === 0
    );
  } catch {
    return false;
  }
}
async function check(requireRegistry = true) {
  const diagnostics: [string, boolean, string][] = [];
  try {
    await lookup("index.crates.io");
    diagnostics.push(["Package registry DNS", true, ""]);
  } catch {
    diagnostics.push([
      "Package registry DNS",
      false,
      "Enable network/DNS access to retrieve maintained SQL Server client dependencies.",
    ]);
  }
  const bind = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    try {
      server.listen({ host: "127.0.0.1", port: 0 }, () =>
        server.close(() => resolve(true)),
      );
    } catch {
      resolve(false);
    }
  });
  diagnostics.push([
    "Loopback sockets",
    bind,
    "Allow local TCP sockets for disposable databases and clients.",
  ]);
  diagnostics.push([
    "Docker daemon",
    available(["docker", "version", "--format", "{{.Server.Version}}"]),
    "Allow Docker socket access and ensure Docker is running.",
  ]);
  diagnostics.push([
    "Docker Compose",
    available(["docker", "compose", "version"]),
    "Install Docker Compose v2.",
  ]);
  diagnostics.push([
    "OpenSSL fixture certificates",
    available(["openssl", "version"]),
    "Install OpenSSL for local self-signed TLS fixture certificates.",
  ]);
  for (const [name, pass, help] of diagnostics)
    console.log(
      `${pass ? "PASS" : "BLOCKED"} ${name}${pass ? "" : `: ${help}`}`,
    );
  console.log(
    "Host prerequisites do not certify a database adapter. Run live tests with --sqlserver for all main engines. DuckDB is deferred.",
  );
  return diagnostics
    .filter(([name]) => requireRegistry || name !== "Package registry DNS")
    .every(([, pass]) => pass);
}
async function certificates() {
  const directory = join(root, ".kitsune-engine-tests", "tls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, "server-key.pem"),
    cert = join(directory, "server.pem");
  if (
    !existsSync(join(directory, "ca.pem")) ||
    !existsSync(key) ||
    !existsSync(cert) ||
    !available(["openssl", "x509", "-checkend", "3600", "-noout", "-in", cert])
  ) {
    run([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-noenc",
      "-days",
      "2",
      "-keyout",
      join(directory, "ca-key.pem"),
      "-out",
      join(directory, "ca.pem"),
      "-subj",
      "/CN=Kitsune disposable test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    run([
      "openssl",
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-noenc",
      "-keyout",
      key,
      "-out",
      join(directory, "server.csr"),
      "-subj",
      "/CN=127.0.0.1",
    ]);
    await Bun.write(
      join(directory, "server.ext"),
      "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n",
    );
    run([
      "openssl",
      "x509",
      "-req",
      "-in",
      join(directory, "server.csr"),
      "-CA",
      join(directory, "ca.pem"),
      "-CAkey",
      join(directory, "ca-key.pem"),
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      join(directory, "server.ext"),
      "-out",
      cert,
    ]);
  }
  run([
    "openssl",
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-keyout",
    join(directory, "client-key.pem"),
    "-out",
    join(directory, "client.csr"),
    "-subj",
    "/CN=Kitsune fixture client",
  ]);
  await Bun.write(
    join(directory, "client.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n",
  );
  run([
    "openssl",
    "x509",
    "-req",
    "-in",
    join(directory, "client.csr"),
    "-CA",
    join(directory, "ca.pem"),
    "-CAkey",
    join(directory, "ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    join(directory, "client.ext"),
    "-out",
    join(directory, "client.pem"),
  ]);
  chmodSync(join(directory, "client-key.pem"), 0o600);
  chmodSync(join(directory, "ca.pem"), 0o644);
  // Bind individual files so container service accounts can read them; host parent stays private.
  chmodSync(join(root, ".kitsune-engine-tests"), 0o700);
  chmodSync(directory, 0o700);
  chmodSync(key, 0o644);
  chmodSync(cert, 0o644);
}
try {
  if (operation === "certificates") await certificates();
  if (operation === "check") {
    if (!(await check())) process.exitCode = 1;
  }
  if (operation === "up") {
    if (!(await check(false)))
      throw new Error(
        "Host prerequisites are blocked. Fix the reported permissions before starting fixtures.",
      );
    await certificates();
    run([
      ...compose,
      ...(sqlserver ? ["--profile", "sqlserver"] : []),
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "240",
    ]);
    if (sqlserver) {
      const command = available([
        ...compose,
        "exec",
        "-T",
        "sqlserver",
        "test",
        "-x",
        "/opt/mssql-tools18/bin/sqlcmd",
      ])
        ? "/opt/mssql-tools18/bin/sqlcmd"
        : "/opt/mssql-tools/bin/sqlcmd";
      const initialized = available([
        ...compose,
        "exec",
        "-T",
        "sqlserver",
        command,
        "-S",
        "localhost",
        "-U",
        "sa",
        "-P",
        "Kitsune_fixture_42!",
        "-C",
        "-b",
        "-Q",
        "IF DB_ID(N'kitsune_test') IS NULL THROW 50000, 'not initialized', 1;",
      ]);
      if (!initialized)
        run(
          [
            ...compose,
            "exec",
            "-T",
            "sqlserver",
            command,
            "-S",
            "localhost",
            "-U",
            "sa",
            "-P",
            "Kitsune_fixture_42!",
            "-C",
            "-b",
          ],
          new Uint8Array(
            await Bun.file(
              join(root, "tests/fixtures/sqlserver.sql"),
            ).arrayBuffer(),
          ),
        );
      console.log(
        "SQL Server fixture provisioned. Run bun run engines:test --sqlserver to test the adapter.",
      );
    }
    console.log(
      "Fixtures ready. Run bun run engines:test. They are separate from user connections and contain disposable data only.",
    );
  }
  if (operation === "test") {
    if (!available(["docker", "version", "--format", "{{.Server.Version}}"]))
      throw new Error(
        "Docker is unavailable. Run engines:check, then engines:up.",
      );
    for (const name of [
      "tests::postgres_live_fixture",
      "ipc_tests::postgres_restore_and_diagnostics_fixture",
      "ipc_tests::postgres_related_record_mutations_enforce_dependencies",
      "ipc_tests::mysql_network_workflow_fixture",
      "ipc_tests::mariadb_network_workflow_fixture",
      ...(sqlserver ? ["ipc_tests::sqlserver_network_workflow_fixture"] : []),
    ]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/test-rust.ts",
          name,
          "--",
          "--exact",
          "--ignored",
          "--nocapture",
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...(existsSync(
              join(root, ".kitsune-engine-tests/lib/usr/lib/libpq.so.5"),
            )
              ? {
                  LD_LIBRARY_PATH:
                    join(root, ".kitsune-engine-tests/lib/usr/lib") +
                    (process.env.LD_LIBRARY_PATH
                      ? ":" + process.env.LD_LIBRARY_PATH
                      : ""),
                }
              : {}),
          },
        },
      );
      const output = result.stdout.toString() + result.stderr.toString();
      console.log(output);
      if (
        result.exitCode !== 0 ||
        !output.includes("test result: ok. 1 passed; 0 failed;")
      )
        throw new Error(`Live test failed or did not run: ${name}`);
    }
    console.log(
      "Selected live engine tests passed. SQL Server is covered only when --sqlserver was selected; this is not cross-platform or desktop certification.",
    );
  }
  if (operation === "down")
    run([
      ...compose,
      "--profile",
      "sqlserver",
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
