import { expect, test } from "bun:test";
import {
  loadReferenceLabels,
  referencePreferencesSchema,
} from "../src/lib/reference-values";
import { relationshipKey } from "../src/lib/schema";
import type {
  DbValue,
  ForeignKey,
  Metadata,
  ResultSet,
} from "../src/lib/types";

const text = (value: string): DbValue => ({ kind: "text", value });
const table = { schema: "main", name: "events", kind: "table" };
const target = { ...table, name: "issues" };
const fk: ForeignKey = {
  name: "event_issue",
  from: table,
  to: target,
  columns: ["issue_id"],
  targetColumns: ["id"],
};
const metadata: Metadata = {
  table,
  columns: [],
  foreignKeys: [fk],
  indexes: [],
  enums: [],
};
const targetMetadata: Metadata = {
  ...metadata,
  table: target,
  foreignKeys: [],
  columns: ["id", "tenant", "title"].map((name) => ({
    name,
    dataType: "text",
    nullable: true,
    defaultValue: null,
    pk: 0,
    enumType: null,
  })),
};
function result(columns: string[], rows: DbValue[][]): ResultSet {
  return {
    columns,
    rows,
    types: columns.map(() => "text"),
    affected: 0,
    durationMs: 0,
    truncated: false,
    nextCursor: null,
    keysetSupported: false,
  };
}
const preference = {
  issue_id: { relationship: relationshipKey(fk), column: "title" },
};
function reader(targetRows: ResultSet, requests: any[] = []) {
  return async <T>(method: string, payload: unknown): Promise<T> => {
    requests.push({ method, payload });
    return (method === "metadata" ? targetMetadata : targetRows) as T;
  };
}

test("replaces every matching row with its label while preserving source IDs and deduplicating lookups", async () => {
  const source = result(
    ["issue_id"],
    [[text("a")], [text("b")], [text("a")], [{ kind: "null" }]],
  );
  const before = JSON.stringify(source);
  const requests: any[] = [];
  const labels = await loadReferenceLabels(
    source,
    metadata,
    preference,
    "connection-a",
    reader(
      result(
        ["id", "title"],
        [
          [text("b"), text("Second")],
          [text("a"), text("First")],
        ],
      ),
      requests,
    ),
  );
  expect(labels.get("issue_id")).toEqual([
    "First",
    "Second",
    "First",
    undefined,
  ]);
  expect(JSON.stringify(source)).toBe(before);
  expect(requests[1].payload).toMatchObject({
    connectionId: "connection-a",
    table: target,
    groupMode: "any",
    limit: 2,
    filterGroups: [
      {
        mode: "all",
        filters: [{ column: "id", operator: "eq", value: text("a") }],
      },
      {
        mode: "all",
        filters: [{ column: "id", operator: "eq", value: text("b") }],
      },
    ],
  });
});

test("large pages use bounded batches rather than one request per row", async () => {
  const requests: any[] = [];
  await loadReferenceLabels(
    result(
      ["issue_id"],
      Array.from({ length: 35 }, (_, i) => [text(String(i))]),
    ),
    metadata,
    preference,
    "connection-a",
    reader(result(["id", "title"], []), requests),
  );
  const reads = requests.filter((r) => r.method === "browse");
  expect(reads.map((r) => r.payload.filterGroups.length)).toEqual([16, 16, 3]);
  expect(reads.map((r) => r.payload.limit)).toEqual([16, 16, 3]);
});

test("composite keys match whole tuples rather than mixing records from different tenants", async () => {
  const composite = {
    ...fk,
    columns: ["tenant_id", "issue_id"],
    targetColumns: ["tenant", "id"],
  };
  const requests: any[] = [];
  const labels = await loadReferenceLabels(
    result(
      ["issue_id", "tenant_id"],
      [
        [text("a"), text("one")],
        [text("a"), text("two")],
        [text("a"), { kind: "null" }],
      ],
    ),
    { ...metadata, foreignKeys: [composite] },
    { issue_id: { relationship: relationshipKey(composite), column: "title" } },
    "connection-a",
    reader(
      result(
        ["id", "tenant", "title"],
        [
          [text("a"), text("two"), text("Tenant two")],
          [text("a"), text("one"), text("Tenant one")],
        ],
      ),
      requests,
    ),
  );
  expect(labels.get("issue_id")).toEqual([
    "Tenant one",
    "Tenant two",
    undefined,
  ]);
  expect(requests[1].payload.filterGroups[0]).toEqual({
    mode: "all",
    filters: [
      { column: "tenant", operator: "eq", value: text("one") },
      { column: "id", operator: "eq", value: text("a") },
    ],
  });
});

test("null, empty, missing and unavailable labels fall back to original values", async () => {
  const source = result(["issue_id"], [[text("a")], [text("b")], [text("c")]]);
  const labels = await loadReferenceLabels(
    source,
    metadata,
    preference,
    "c",
    reader(
      result(
        ["id", "title"],
        [
          [text("a"), { kind: "null" }],
          [text("b"), text("")],
        ],
      ),
    ),
  );
  expect(labels.get("issue_id")).toEqual([undefined, undefined, undefined]);
  const failed = async <T>(): Promise<T> => {
    throw Error("Permission denied");
  };
  expect(
    (await loadReferenceLabels(source, metadata, preference, "c", failed)).size,
  ).toBe(0);
  const stale = {
    ...preference,
    issue_id: { ...preference.issue_id, column: "removed" },
  };
  const requests: any[] = [];
  expect(
    (
      await loadReferenceLabels(
        source,
        metadata,
        stale,
        "c",
        reader(result([], []), requests),
      )
    ).size,
  ).toBe(0);
  expect(requests.map((r) => r.method)).toEqual(["metadata"]);
});

test("changed FK definitions, null keys and cancellation never initiate unrelated lookups", async () => {
  const requests: any[] = [];
  const read = reader(result([], []), requests);
  expect(
    (
      await loadReferenceLabels(
        result(["issue_id"], [[text("a")]]),
        {
          ...metadata,
          foreignKeys: [{ ...fk, to: { ...target, name: "other" } }],
        },
        preference,
        "c",
        read,
      )
    ).size,
  ).toBe(0);
  expect(
    (
      await loadReferenceLabels(
        result(["issue_id"], [[{ kind: "null" }]]),
        metadata,
        preference,
        "c",
        read,
      )
    ).size,
  ).toBe(0);
  expect(
    (
      await loadReferenceLabels(
        result(["issue_id"], [[text("a")]]),
        metadata,
        preference,
        "c",
        read,
        () => false,
      )
    ).size,
  ).toBe(0);
  expect(requests).toEqual([]);
});

test("reference preferences validate saved settings and preserve column names", () => {
  expect(referencePreferencesSchema.parse(preference)).toEqual(preference);
  expect(
    referencePreferencesSchema.safeParse({
      issue_id: { relationship: 123, column: "title" },
    }).success,
  ).toBe(false);
  expect(
    referencePreferencesSchema.safeParse({
      issue_id: { relationship: relationshipKey(fk), column: "" },
    }).success,
  ).toBe(false);
});

test("wide composite keys stay within the 100-predicate limit", async () => {
  const columns = Array.from({ length: 9 }, (_, i) => `part_${i}`);
  const composite = { ...fk, columns, targetColumns: columns };
  const requests: any[] = [];
  await loadReferenceLabels(
    result(
      columns,
      Array.from({ length: 12 }, (_, i) => columns.map(() => text(String(i)))),
    ),
    { ...metadata, foreignKeys: [composite] },
    { part_0: { relationship: relationshipKey(composite), column: "title" } },
    "c",
    reader(result([], []), requests),
  );
  expect(
    requests
      .filter((r) => r.method === "browse")
      .map((r) =>
        r.payload.filterGroups.reduce(
          (n: number, g: any) => n + g.filters.length,
          0,
        ),
      ),
  ).toEqual([99, 9]);
});
