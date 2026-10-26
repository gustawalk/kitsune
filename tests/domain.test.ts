import { describe, expect, test } from "bun:test";
import {
  defaults,
  display,
  identity,
  qualified,
  rowKey,
  type Metadata,
  type RecordRef,
} from "../src/lib/types";
import { currentStatement, splitSql } from "../src/lib/sql";
import {
  connectionSchema,
  settingsSchema,
  validateResponse,
  valueSchema,
} from "../src/lib/validation";
import {
  closeTab,
  getWorkspace,
  newQuery,
  openTab,
  patchTab,
  update,
} from "../src/lib/store";
describe("SQL selection", () => {
  test("delimits strings, dollar quotes, nested comments and scripts", () => {
    expect(
      splitSql("select ';'; /* a /* b */ c */ select $$a;b$$; select 3"),
    ).toHaveLength(3);
  });
  test("executes the current statement without splitting a literal", () => {
    const sql = "select 'a;b';\nselect 2;";
    expect(currentStatement(sql, 8)).toBe("select 'a;b'");
    expect(currentStatement(sql, 17)).toBe("select 2");
  });
});
describe("lossless values and identity", () => {
  test("preserves null, empty string, zero and large integers", () => {
    expect(display({ kind: "null" })).toBe("NULL");
    expect(display({ kind: "text", value: "" })).toBe("");
    expect(display({ kind: "integer", value: "0" })).toBe("0");
    expect(display({ kind: "integer", value: "9223372036854775807" })).toBe(
      "9223372036854775807",
    );
    expect(display({ kind: "binary", value: "AP+A" })).toContain("binary");
  });
  test("composite identities do not depend on object insertion order", () => {
    const record: RecordRef = {
      connectionId: "c",
      table: { schema: "", name: "t", kind: "table" },
      key: {
        a: { kind: "integer", value: "1" },
        b: { kind: "text", value: "x" },
      },
    };
    expect(identity(record)).toBe(
      identity({ ...record, key: { b: record.key.b, a: record.key.a } }),
    );
  });
  test("requires every primary key field", () => {
    const metadata: Metadata = {
      table: { schema: "", name: "t", kind: "table" },
      columns: [
        {
          name: "a",
          pk: 1,
          dataType: "INTEGER",
          nullable: false,
          defaultValue: null,
        },
        {
          name: "b",
          pk: 2,
          dataType: "TEXT",
          nullable: false,
          defaultValue: null,
        },
      ],
      foreignKeys: [],
      indexes: [],
    };
    expect(
      rowKey(
        metadata,
        ["a", "b"],
        [
          { kind: "integer", value: "1" },
          { kind: "text", value: "" },
        ],
      ),
    ).toEqual({
      a: { kind: "integer", value: "1" },
      b: { kind: "text", value: "" },
    });
    expect(rowKey(metadata, ["a"], [{ kind: "integer", value: "1" }])).toEqual(
      {},
    );
    expect(
      rowKey(
        metadata,
        ["a", "b"],
        [{ kind: "integer", value: "1" }, { kind: "null" }],
      ),
    ).toEqual({});
  });
  test("quotes identifiers without treating them as SQL", () => {
    expect(
      qualified({ schema: 'a"b', name: "t;drop table x", kind: "table" }),
    ).toBe('"a""b"."t;drop table x"');
  });
});
describe("external data validation", () => {
  test("rejects invalid drivers and malformed values", () => {
    expect(connectionSchema.safeParse({ driver: "mysql" }).success).toBe(false);
    expect(
      valueSchema.safeParse({ kind: "integer", value: 9007199254740992 })
        .success,
    ).toBe(false);
    expect(valueSchema.safeParse({ kind: "null" }).success).toBe(true);
  });
  test("validates settings bounds", () => {
    expect(settingsSchema.safeParse(defaults).success).toBe(true);
    expect(
      settingsSchema.safeParse({ ...defaults, pollInterval: 0 }).success,
    ).toBe(false);
  });
  test("rejects malformed result rows", () => {
    expect(() =>
      validateResponse("browse", {
        columns: ["id"],
        types: ["int"],
        rows: [[]],
        affected: 0,
        durationMs: 1,
        truncated: false,
      }),
    ).toThrow();
  });
});
describe("workspace state", () => {
  test("keeps independent SQL tabs and selects a remaining tab on close", () => {
    update({ tabs: [], activeTab: "", activeConnection: "c" });
    newQuery("select 1");
    const first = getWorkspace().activeTab;
    newQuery("select 2");
    const second = getWorkspace().activeTab;
    patchTab(first, { sql: "select 3" });
    expect(getWorkspace().tabs.find((t) => t.id === second)?.sql).toBe(
      "select 2",
    );
    closeTab(second);
    expect(getWorkspace().activeTab).toBe(first);
    expect(getWorkspace().tabs[0].sql).toBe("select 3");
  });
  test("deduplicates a table workspace", () => {
    update({ tabs: [], activeTab: "" });
    const table = { schema: "", name: "orders", kind: "table" };
    openTab({ kind: "table", title: "orders", connectionId: "c", table });
    openTab({ kind: "table", title: "orders", connectionId: "c", table });
    expect(getWorkspace().tabs).toHaveLength(1);
  });
});
import { graphReferences, mergeGraph } from "../src/lib/graph";
test("graph cycles deduplicate records and edges; persistence excludes labels", () => {
  const record: RecordRef = {
    connectionId: "c",
    table: { schema: "", name: "orders", kind: "table" },
    key: { id: { kind: "integer", value: "1" } },
  };
  const node = {
    id: identity(record),
    record,
    x: 0,
    y: 0,
    depth: 0,
    label: "sensitive label",
  };
  const graph = { nodes: [node], edges: [], selected: node.id };
  const merged = mergeGraph(
    graph,
    [node, node],
    [
      { from: node.id, to: node.id, label: "cycle" },
      { from: node.id, to: node.id, label: "cycle" },
    ],
  );
  expect(merged.nodes).toHaveLength(1);
  expect(merged.edges).toHaveLength(1);
  expect(JSON.stringify(graphReferences(merged))).not.toContain(
    "sensitive label",
  );
});
import { stateComparison } from "../src/lib/timeline";
import type { ChangeEvent } from "../src/lib/types";
test("current statement respects PostgreSQL escape strings and SQLite bracket identifiers", () => {
  expect(splitSql("SELECT E'it\\'s;safe'; SELECT 2")).toHaveLength(2);
  expect(splitSql("SELECT [column;name] FROM t;SELECT 2")).toHaveLength(2);
});
test("historical comparison uses captured states and preserves unchanged fields", () => {
  const event: ChangeEvent = {
    id: "e",
    watchId: "w",
    connectionId: "c",
    observedAt: "2026-01-01T00:00:00Z",
    eventType: "recordChanged",
    summary: "changed",
    capture: "full",
    record: null,
    changes: [],
    beforeState: [
      { column: "status", value: { kind: "text", value: "pending" } },
      { column: "id", value: { kind: "integer", value: "1" } },
    ],
    afterState: [
      { column: "status", value: { kind: "text", value: "completed" } },
      { column: "id", value: { kind: "integer", value: "1" } },
    ],
  };
  const rows = stateComparison(event);
  expect(rows).toHaveLength(2);
  expect(rows[0].before).toEqual({ kind: "text", value: "pending" });
  expect(rows[0].after).toEqual({ kind: "text", value: "completed" });
  expect(rows[1].before).toEqual(rows[1].after);
});
import { watchMatchesRecord } from "../src/lib/types";
test("watch indicators use complete, schema-qualified composite identities", () => {
  const record: RecordRef = {
    connectionId: "c",
    table: { schema: "public", name: "items", kind: "table" },
    key: {
      order_id: { kind: "integer", value: "1" },
      line: { kind: "integer", value: "2" },
    },
  };
  const watch = {
    kind: "record" as const,
    connectionId: "c",
    table: record.table,
    key: { line: record.key.line, order_id: record.key.order_id },
  };
  expect(watchMatchesRecord(watch, record)).toBe(true);
  expect(
    watchMatchesRecord(
      { ...watch, table: { ...record.table, schema: "other" } },
      record,
    ),
  ).toBe(false);
});

test("editing a generated query or switching its connection clears stale bound values", () => {
  update({ tabs: [], activeTab: "" });
  openTab({
    kind: "query",
    title: "Record",
    connectionId: "a",
    sql: "SELECT * FROM sprints WHERE id = ?1;",
    boundParams: [{ kind: "text", value: "record-key" }],
  });
  const id = getWorkspace().activeTab;
  patchTab(id, { title: "Renamed" });
  expect(getWorkspace().tabs[0].boundParams).toHaveLength(1);
  patchTab(id, { sql: "SELECT * FROM sprints WHERE id = ?1;" });
  expect(getWorkspace().tabs[0].boundParams).toHaveLength(1);
  patchTab(id, { sql: "UPDATE sprints SET name = 'teste';" });
  expect(getWorkspace().tabs[0].boundParams).toBeUndefined();
  patchTab(id, { boundParams: [{ kind: "integer", value: "1" }] });
  patchTab(id, { connectionId: "b" });
  expect(getWorkspace().tabs[0].boundParams).toBeUndefined();
  closeTab(id);
});
