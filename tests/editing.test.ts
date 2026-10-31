import { expect, test } from "bun:test";
import {
  editedValue,
  recordChanges,
  stageRowChanges,
  pendingResult,
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

test("record editing collects only changed fields and preserves NULL versus empty text", () => {
  const fields = [
    { column: "name", before: { kind: "text", value: "Original" } as const },
    { column: "note", before: { kind: "null" } as const },
    { column: "active", before: { kind: "boolean", value: false } as const },
  ];
  const drafts = {
    name: { kind: "text", text: "Renamed", isNull: false } as const,
    note: { kind: "text", text: "", isNull: false } as const,
    active: { kind: "boolean", text: "false", isNull: false } as const,
  };
  expect(recordChanges(fields, drafts).map((f) => f.column)).toEqual([
    "name",
    "note",
  ]);
  expect(
    recordChanges(fields, {
      ...drafts,
      name: { ...drafts.name, text: "Original" },
      note: { ...drafts.note, isNull: true },
    }),
  ).toEqual([]);
});

test("pending edits merge across rows, retain original values and unstage reversions", () => {
  const ref = (id: string) => ({
    connectionId: "db",
    table: { schema: "main", name: "items", kind: "table" },
    key: { id: { kind: "integer" as const, value: id } },
  });
  const text = (value: string) => ({ kind: "text" as const, value });
  let pending = stageRowChanges([], ref("1"), [
    { column: "name", before: text("old 1"), value: text("first edit") },
  ]);
  pending = stageRowChanges(pending, ref("2"), [
    { column: "name", before: text("old 2"), value: text("second edit") },
  ]);
  pending = stageRowChanges(pending, ref("1"), [
    { column: "name", before: text("first edit"), value: text("revised edit") },
  ]);
  expect(pending).toHaveLength(2);
  expect(
    pending.find((row) => row.record.key.id.value === "1")!.changes[0],
  ).toEqual({
    column: "name",
    before: text("old 1"),
    value: text("revised edit"),
  });
  pending = stageRowChanges(pending, ref("1"), [
    { column: "name", before: text("revised edit"), value: text("old 1") },
  ]);
  expect(pending).toHaveLength(1);
  expect(pending[0].record.key.id.value).toBe("2");
});

test("staged NULL and empty values differ; previews follow record identity across result pages", () => {
  const table = { schema: "", name: "items", kind: "table" };
  const metadata = {
    table,
    columns: [
      {
        name: "id",
        pk: 1,
        nullable: false,
        dataType: "INTEGER",
        defaultValue: null,
      },
      {
        name: "name",
        pk: 0,
        nullable: true,
        dataType: "TEXT",
        defaultValue: null,
      },
    ],
    indexes: [],
    foreignKeys: [],
  };
  const value = (text: string) => ({ kind: "text" as const, value: text });
  const record = {
    connectionId: "db",
    table,
    key: { id: { kind: "integer" as const, value: "2" } },
  };
  const pending = stageRowChanges([], record, [
    { column: "name", before: { kind: "null" }, value: value("") },
  ]);
  const result = {
    columns: ["id", "name"],
    types: ["integer", "text"],
    rows: [
      [{ kind: "integer" as const, value: "2" }, { kind: "null" as const }],
      [{ kind: "integer" as const, value: "1" }, value("other")],
    ],
    affected: 0,
    durationMs: 0,
    truncated: false,
    nextCursor: null,
    keysetSupported: false,
  };
  const preview = pendingResult(result, metadata, "db", pending);
  expect(preview.result!.rows[0][1]).toEqual(value(""));
  expect([...preview.cells]).toEqual(["0:name"]);
  expect(result.rows[0][1]).toEqual({ kind: "null" });
  expect(
    pendingResult(result, metadata, "another-db", pending).cells.size,
  ).toBe(0);
  expect(
    stageRowChanges(pending, record, [
      { column: "name", before: value(""), value: { kind: "null" } },
    ]),
  ).toEqual([]);
});
