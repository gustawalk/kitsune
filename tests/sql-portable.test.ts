import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  parsePortableSql,
  emitPortableSql,
  translatePortableSql,
  tokenizeSql,
  SqlParseError,
  type SqlDialect,
} from "../src/lib/sql-portable";
test("portable SELECT keeps relationships, predicates and exact literal values", () => {
  const source =
    "SELECT o.id, COALESCE(o.name, 'can''t; DROP TABLE x') AS label, SUM(o.amount * 2) AS total FROM orders AS o LEFT JOIN customers AS c ON c.id = o.customer_id WHERE (o.status = 'pending' OR o.status = 'paid') AND o.amount BETWEEN 1 AND 9223372036854775807 GROUP BY o.id, o.name HAVING COUNT(*) > 0 ORDER BY o.id DESC LIMIT 50 OFFSET 10;";
  const ast = parsePortableSql(source);
  expect(ast.joins).toHaveLength(1);
  expect(ast.limit).toBe("50");
  for (const dialect of [
    "postgres",
    "sqlite",
    "mysql",
    "duckdb",
    "mssql",
  ] as SqlDialect[]) {
    const sql = translatePortableSql(source, dialect);
    expect(sql).toContain("can''t; DROP TABLE x");
    expect(sql).toContain("9223372036854775807");
    if (dialect !== "mssql")
      expect(parsePortableSql(sql).columns).toHaveLength(3);
  }
  expect(translatePortableSql(source, "mssql")).toContain(
    "OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY",
  );
});
test("portable query executes against real SQLite without dropping NULL, integers or safe quoting", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE orders(id INTEGER PRIMARY KEY,name TEXT,amount INTEGER); INSERT INTO orders VALUES(1,'a',2),(2,NULL,3),(3,'b',1)",
  );
  const sql = translatePortableSql(
    "SELECT id, COALESCE(name, 'empty') AS label, amount * 2 AS total FROM orders WHERE amount >= 2 AND id NOT IN (3, 4) ORDER BY id LIMIT 10",
    "sqlite",
  );
  expect(db.query(sql).all()).toEqual([
    { id: 1, label: "a", total: 4 },
    { id: 2, label: "empty", total: 6 },
  ]);
  db.close();
});
test("parser handles nested function calls, unary/boolean precedence, parameters and paging", () => {
  expect(
    translatePortableSql(
      "SELECT SUM(COALESCE(a, 0)), t.* FROM t WHERE NOT a = ?1 OR a IS NULL ORDER BY a LIMIT 1",
      "postgres",
    ),
  ).toContain("$1");
  expect(
    translatePortableSql("SELECT TOP (10) id FROM t ORDER BY id", "sqlite"),
  ).toContain("LIMIT 10");
  expect(
    translatePortableSql("SELECT id FROM t ORDER BY id LIMIT 5, 10", "mssql"),
  ).toContain("OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY");
  expect(translatePortableSql("SELECT NOW()", "sqlite")).toBe(
    "SELECT CURRENT_TIMESTAMP;",
  );
  expect(translatePortableSql("SELECT a || b FROM t", "mysql")).toContain(
    "CONCAT(`a`, `b`)",
  );
  expect(translatePortableSql('SELECT "a""b" FROM "t"', "mysql")).toContain(
    '`a"b`',
  );
});
test("unsupported translation is explicit and does not guess dialect semantics", () => {
  for (const sql of [
    "DELETE FROM t",
    "SELECT * FROM (SELECT 1) x",
    "SELECT x::text FROM t",
    "SELECT 1; DELETE FROM t",
    "SELECT x FROM t FOR UPDATE",
    "SELECT /* executable */ 1 UNION SELECT 2",
    "SELECT 'a\\b'",
    "SELECT 1 /* unterminated",
  ]) {
    expect(() => translatePortableSql(sql, "sqlite")).toThrow();
  }
  expect(() =>
    translatePortableSql("SELECT * FROM a FULL JOIN b ON a.id=b.id", "mysql"),
  ).toThrow("FULL JOIN");
  expect(() => translatePortableSql("SELECT RAND()", "sqlite")).toThrow(
    "engine-specific",
  );
  expect(() =>
    translatePortableSql("SELECT * FROM t OFFSET 1", "mssql"),
  ).toThrow("ORDER BY");
  expect(() =>
    translatePortableSql(
      "SELECT * FROM t LIMIT 99999999999999999999",
      "sqlite",
    ),
  ).toThrow();
});
test("lexer preserves offsets, nested comments, quotes and bounded nesting", () => {
  const tokens = tokenizeSql(
    "/* outer /* inner */ */ SELECT 'a;''b' -- end\nFROM t",
  );
  expect(tokens[0].text).toBe("SELECT");
  expect(tokens[1].text).toBe("a;'b");
  try {
    parsePortableSql("SELECT (1");
    throw new Error("should fail");
  } catch (e) {
    expect(e).toBeInstanceOf(SqlParseError);
    expect((e as SqlParseError).from).toBe(9);
  }
  expect(() =>
    parsePortableSql("SELECT " + "(".repeat(100) + "1" + ")".repeat(100)),
  ).toThrow("nesting");
  expect(() => parsePortableSql("SELECT /*!50000 1 */ 1")).toThrow(
    "Executable",
  );
});

test("MySQL emission rebinds repeated and out-of-order parameters in SQL order", () => {
  const ast = parsePortableSql(
    "SELECT ?2, ?1, ?2 FROM t WHERE a=?3 ORDER BY ?1",
  );
  const order: number[] = [];
  const sql = emitPortableSql(ast, "mysql", order);
  expect(order).toEqual([2, 1, 2, 3, 1]);
  expect(sql).toContain("SELECT ?, ?, ?");
  expect(parsePortableSql("SELECT ?2, ?").columns[1].value).toEqual({
    kind: "parameter",
    index: 3,
  });
  expect(parsePortableSql("SELECT @p1").columns[0].value).toEqual({
    kind: "parameter",
    index: 1,
  });
  expect(
    translatePortableSql('SELECT "a.b" FROM "table with space"', "mysql"),
  ).toBe("SELECT `a.b`\nFROM `table with space`;");
});

test("SQL Server preview keeps Unicode literals and rejects unsupported boolean/date semantics", () => {
  expect(
    translatePortableSql("SELECT N'日本語' AS name", "postgres"),
  ).toContain("'日本語'");
  expect(() => translatePortableSql("SELECT TRUE", "mssql")).toThrow(
    "boolean literal",
  );
  expect(() => translatePortableSql("SELECT CURRENT_DATE", "mssql")).toThrow(
    "date expression",
  );
  expect(() =>
    translatePortableSql(
      "SELECT id FROM t ORDER BY id LIMIT 0 OFFSET 1",
      "mssql",
    ),
  ).toThrow("positive");
});
