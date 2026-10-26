import { expect, test } from "bun:test";
import {
  editedValue,
  toggleRowSelection,
  valueKindForColumn,
} from "../src/lib/editing";
import { tabContext } from "../src/lib/tabs";
test("cell edits preserve large numbers, empty strings, NULL and boolean semantics", () => {
  expect(editedValue("integer", "9223372036854775807", false)).toEqual({
    kind: "integer",
    value: "9223372036854775807",
  });
  expect(editedValue("decimal", "1234567890.12345678912345", false)).toEqual({
    kind: "decimal",
    value: "1234567890.12345678912345",
  });
  expect(editedValue("text", "", false)).toEqual({ kind: "text", value: "" });
  expect(editedValue("text", "", true)).toEqual({ kind: "null" });
  expect(editedValue("boolean", "false", false)).toEqual({
    kind: "boolean",
    value: false,
  });
  for (const [kind, value] of [
    ["integer", "1.2"],
    ["boolean", "yes"],
    ["json", "{bad"],
    ["float", "1e9999"],
    ["binary", "oops"],
  ] as const)
    expect(() => editedValue(kind, value, false)).toThrow();
});
test("tab captions distinguish types, databases and PostgreSQL namespaces", () => {
  expect(
    tabContext(
      {
        id: "1",
        kind: "table",
        title: "orders",
        table: { schema: "sales", name: "orders", kind: "table" },
      },
      "Production",
    ),
  ).toBe("Data · Production · sales");
  expect(tabContext({ id: "2", kind: "query", title: "orders" }, "Local")).toBe(
    "SQL · Local",
  );
});

test("row selection remains unique and ordered when individual rows are toggled", () => {
  expect(toggleRowSelection([1, 3], 2, true)).toEqual([1, 2, 3]);
  expect(toggleRowSelection([1, 2], 2, true)).toEqual([1, 2]);
  expect(toggleRowSelection([1, 2, 3], 2, false)).toEqual([1, 3]);
  expect(valueKindForColumn("NUMERIC(38,10)")).toBe("decimal");
  expect(valueKindForColumn("BIGINT")).toBe("integer");
  expect(valueKindForColumn("BOOLEAN")).toBe("boolean");
});
