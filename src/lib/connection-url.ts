import { emptyConnection, type Connection } from "./types";

/** Import supported URL options into the normal form; never persist the URL. */
export function parseConnectionUrl(input: string): {
  config: Connection;
  password: string;
} {
  const invalid = () =>
    new Error("Enter a database URL with a host, username and database name.");
  const raw = input.trim();
  if (!raw || /%(?![\da-f]{2})/i.test(raw)) throw invalid();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  const drivers: Record<string, Connection["driver"]> = {
    "postgres:": "postgres",
    "postgresql:": "postgres",
    "mysql:": "mysql",
    "mariadb:": "mysql",
    "mssql:": "mssql",
    "sqlserver:": "mssql",
  };
  const driver = drivers[url.protocol];
  if (!driver)
    throw new Error("Use a PostgreSQL, MySQL/MariaDB, or SQL Server URL.");
  if (url.hash)
    throw new Error(
      "Encode special characters in the URL password (for example, # as %23).",
    );
  const allowed = new Set([
    "host",
    "port",
    "user",
    "password",
    "dbname",
    "database",
    "sslmode",
    "ssl",
    "sslrootcert",
    "sslcert",
    "sslkey",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key))
      throw new Error(
        "This URL contains an unsupported option. Use connection settings for advanced options.",
      );
    if (url.searchParams.getAll(key).length > 1)
      throw new Error("Remove duplicate options from the database URL.");
  }
  const read = (key: string, fallback: string) =>
    url.searchParams.get(key) ?? fallback;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw invalid();
    }
  };
  const host = read("host", decode(url.hostname)).replace(/^\[|\]$/g, "");
  const username = read("user", decode(url.username));
  const database = read(
    "dbname",
    read("database", decode(url.pathname.slice(1))),
  );
  const password = read("password", decode(url.password));
  const port = Number(
    read(
      "port",
      url.port ||
        (driver === "postgres" ? "5432" : driver === "mysql" ? "3306" : "1433"),
    ),
  );
  if (
    !host ||
    !username ||
    !database ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    /[\u0000-\u001f]/.test(host + username + database + password)
  )
    throw invalid();
  const ssl = url.searchParams.get("ssl");
  if (ssl !== null && !["true", "false", "1", "0"].includes(ssl))
    throw new Error("Use true or false for the URL ssl option.");
  if (ssl !== null && url.searchParams.has("sslmode"))
    throw new Error("Choose either ssl or sslmode in the database URL.");
  const sslMode = read(
    "sslmode",
    ssl === null
      ? driver === "postgres"
        ? "prefer"
        : "verify-full"
      : ["true", "1"].includes(ssl)
        ? "require"
        : "disable",
  );
  const modes =
    driver === "postgres"
      ? ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]
      : ["disable", "require", "verify-full"];
  if (!modes.includes(sslMode))
    throw new Error(
      "This TLS mode is not supported for the selected database.",
    );
  return {
    config: {
      ...emptyConnection(),
      driver,
      name: `${database} @ ${host}`,
      host,
      port,
      database,
      username,
      sslMode,
      tlsCaPath: read("sslrootcert", ""),
      tlsCertPath: read("sslcert", ""),
      tlsKeyPath: read("sslkey", ""),
    },
    password,
  };
}
