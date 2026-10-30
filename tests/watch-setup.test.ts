import { expect, test } from "bun:test";
import { watchQueryExample } from "../src/lib/watch-setup";

test("watch query examples select the chosen table with native identifier quoting", () => {
  const table = { schema: "public", name: "boards", kind: "table" };
  expect(watchQueryExample(table, "postgres")).toBe(
    'SELECT *\nFROM "public"."boards";',
  );
  expect(watchQueryExample({ ...table, schema: "" }, "sqlite")).toBe(
    'SELECT *\nFROM "boards";',
  );
  expect(watchQueryExample(table, "mysql")).toBe(
    "SELECT *\nFROM `public`.`boards`;",
  );
  expect(watchQueryExample(table, "mssql")).toBe(
    "SELECT *\nFROM [public].[boards];",
  );
});
test("examples escape identifier delimiters without introducing a shifting LIMIT window", () => {
  for (const [driver, name, quoted] of [
    ["postgres", 'a"b', '"a""b"'],
    ["mysql", "a`b", "`a``b`"],
    ["mssql", "a]b", "[a]]b]"],
  ]) {
    const sql = watchQueryExample({ schema: "", name, kind: "table" }, driver);
    expect(sql).toContain(quoted);
    expect(sql).not.toContain("LIMIT");
  }
});
