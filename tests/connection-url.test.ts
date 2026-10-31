import { expect, test } from "bun:test";
import { parseConnectionUrl } from "../src/lib/connection-url";

test("database URLs decode credentials and keep the raw URL out of saved settings", () => {
  const raw =
    "postgresql://a%40b:p%40ss%3A%23%2F@db.example:6543/app%20db?sslmode=require";
  const result = parseConnectionUrl(raw);
  expect(result.config).toMatchObject({
    driver: "postgres",
    host: "db.example",
    port: 6543,
    database: "app db",
    username: "a@b",
    sslMode: "require",
    rememberPassword: false,
  });
  expect(result.password).toBe("p@ss:#/");
  expect(JSON.stringify(result.config)).not.toContain("p@ss");
  expect(Object.values(result.config)).not.toContain(raw);
});
test("URLs support driver defaults, IPv6, TLS certificate paths and PostgreSQL query overrides", () => {
  expect(parseConnectionUrl("postgres://user@[::1]/app").config).toMatchObject({
    driver: "postgres",
    host: "::1",
    port: 5432,
    sslMode: "prefer",
  });
  expect(
    parseConnectionUrl("mysql://user:pass@localhost/db").config,
  ).toMatchObject({ driver: "mysql", port: 3306, sslMode: "verify-full" });
  expect(parseConnectionUrl("mariadb://user@localhost/db").config.driver).toBe(
    "mysql",
  );
  expect(
    parseConnectionUrl("sqlserver://user@localhost/db").config,
  ).toMatchObject({ driver: "mssql", port: 1433 });
  expect(
    parseConnectionUrl(
      "postgresql:///app?host=localhost&user=me&port=5433&ssl=true&sslrootcert=%2Ftmp%2Fca.pem",
    ).config,
  ).toMatchObject({
    host: "localhost",
    username: "me",
    port: 5433,
    sslMode: "require",
    tlsCaPath: "/tmp/ca.pem",
  });
});
test("malformed, unsupported or ambiguous URLs fail without echoing credentials", () => {
  for (const raw of [
    "postgres://u:PRIVATE@/app",
    "postgres://u:PRIVATE@host/",
    "postgres://u:PRIVATE@host:0/app",
    "postgres://u:PRIVATE@host/app?sslmode=nope",
    "postgres://u:PRIVATE@host/app?sslmode=require&sslmode=disable",
    "postgres://u:PRIVATE@host/app?sslmode=require&ssl=true",
    "postgres://u:PRIVATE@host/app?unknown=PRIVATE",
    "postgres://u:PRIVATE%ZZ@host/app",
    "https://u:PRIVATE@host/app",
    "postgres://u:PRIVATE@host/app#oops",
  ]) {
    let failure = "";
    try {
      parseConnectionUrl(raw);
    } catch (e) {
      failure = String(e);
    }
    expect(failure).not.toBe("");
    expect(failure).not.toContain("PRIVATE");
  }
});
