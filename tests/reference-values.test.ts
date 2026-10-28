import { expect, test } from "bun:test";
import {
  loadReferenceLabels,
  ReferenceLabelCache,
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

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("configuring another FK preserves resolved labels and only reads the changed column", async () => {
  const assigned: ForeignKey = {
    ...fk,
    name: "assignee",
    columns: ["assignee_id"],
    to: { ...target, name: "users" },
  };
  const meta = { ...metadata, foreignKeys: [fk, assigned] };
  const source = result(["issue_id", "assignee_id"], [[text("a"), text("u")]]);
  const calls: string[] = [];
  let release!: (value: ResultSet) => void;
  const pending = new Promise<ResultSet>((resolve) => {
    release = resolve;
  });
  const read = async <T>(method: string, payload: any): Promise<T> => {
    calls.push(`${method}:${payload.table.name}`);
    if (method === "metadata") return targetMetadata as T;
    return (
      payload.table.name === "users"
        ? await pending
        : result(["id", "title"], [[text("a"), text("First")]])
    ) as T;
  };
  const cache = new ReferenceLabelCache(
    source,
    meta,
    "c",
    read,
    () => undefined,
  );
  cache.update(preference);
  await settled();
  expect(cache.labels(preference).get("issue_id")).toEqual(["First"]);
  const both = {
    ...preference,
    assignee_id: { relationship: relationshipKey(assigned), column: "title" },
  };
  cache.update(both);
  expect(cache.labels(both).get("issue_id")).toEqual(["First"]);
  await settled();
  expect(calls).toEqual([
    "metadata:issues",
    "browse:issues",
    "metadata:users",
    "browse:users",
  ]);
  expect(cache.labels(both).has("assignee_id")).toBe(false);
  release(result(["id", "title"], [[text("u"), text("Assigned user")]]));
  await settled();
  expect([...cache.labels(both)]).toEqual([
    ["issue_id", ["First"]],
    ["assignee_id", ["Assigned user"]],
  ]);
  cache.update({ assignee_id: both.assignee_id });
  expect([...cache.labels({ assignee_id: both.assignee_id })]).toEqual([
    ["assignee_id", ["Assigned user"]],
  ]);
  expect(calls.length).toBe(4);
  cache.dispose();
});

test("unchanged pending lookups are reused while another FK is configured", async () => {
  const assigned: ForeignKey = {
    ...fk,
    name: "assignee",
    columns: ["assignee_id"],
  };
  let release!: (value: ResultSet) => void;
  const pending = new Promise<ResultSet>((resolve) => {
    release = resolve;
  });
  let browses = 0;
  const cache = new ReferenceLabelCache(
    result(["issue_id", "assignee_id"], [[text("a"), text("a")]]),
    { ...metadata, foreignKeys: [fk, assigned] },
    "c",
    async <T>(method: string): Promise<T> => {
      if (method === "metadata") return targetMetadata as T;
      browses++;
      return (await pending) as T;
    },
    () => undefined,
  );
  cache.update(preference);
  await settled();
  const both = {
    ...preference,
    assignee_id: { relationship: relationshipKey(assigned), column: "title" },
  };
  cache.update(both);
  await settled();
  expect(browses).toBe(2);
  release(result(["id", "title"], [[text("a"), text("Shared label")]]));
  await settled();
  expect([...cache.labels(both)]).toEqual([
    ["issue_id", ["Shared label"]],
    ["assignee_id", ["Shared label"]],
  ]);
  expect(browses).toBe(2);
  cache.dispose();
});

test("changing a field rejects its old response while keeping the new label", async () => {
  const releases: Array<(result: ResultSet) => void> = [];
  const cache = new ReferenceLabelCache(
    result(["issue_id"], [[text("a")]]),
    metadata,
    "c",
    async <T>(method: string): Promise<T> => {
      if (method === "metadata") return targetMetadata as T;
      return (await new Promise<ResultSet>((resolve) =>
        releases.push(resolve),
      )) as T;
    },
    () => undefined,
  );
  cache.update(preference);
  await settled();
  const next = { issue_id: { ...preference.issue_id, column: "id" } };
  cache.update(next);
  await settled();
  expect(releases.length).toBe(2);
  releases[1](result(["id", "title"], [[text("a"), text("New")]]));
  await settled();
  expect(cache.labels(next).get("issue_id")).toEqual(["a"]);
  releases[0](result(["id", "title"], [[text("a"), text("Old title")]]));
  await settled();
  expect(cache.labels(next).get("issue_id")).toEqual(["a"]);
  cache.dispose();
});

test("disposed page caches never publish delayed labels", async () => {
  let release!: (result: ResultSet) => void;
  let published = 0;
  const cache = new ReferenceLabelCache(
    result(["issue_id"], [[text("a")]]),
    metadata,
    "c",
    async <T>(method: string): Promise<T> => {
      if (method === "metadata") return targetMetadata as T;
      return (await new Promise<ResultSet>((resolve) => {
        release = resolve;
      })) as T;
    },
    () => published++,
  );
  cache.update(preference);
  await settled();
  cache.dispose();
  release(result(["id", "title"], [[text("a"), text("Old page")]]));
  await settled();
  expect(cache.labels(preference).size).toBe(0);
  expect(published).toBe(0);
});

test("each resolved batch updates its own rows without waiting for remaining rows", async () => {
  const source = result(
    ["issue_id"],
    Array.from({ length: 20 }, (_, i) => [text(String(i))]),
  );
  let release!: (result: ResultSet) => void;
  const remaining = new Promise<ResultSet>((resolve) => {
    release = resolve;
  });
  let browseCount = 0;
  let updates = 0;
  const cache = new ReferenceLabelCache(
    source,
    metadata,
    "c",
    async <T>(method: string): Promise<T> => {
      if (method === "metadata") return targetMetadata as T;
      browseCount++;
      return (
        browseCount === 1
          ? result(
              ["id", "title"],
              Array.from({ length: 16 }, (_, i) => [
                text(String(i)),
                text(`Issue ${i}`),
              ]),
            )
          : await remaining
      ) as T;
    },
    () => updates++,
  );
  cache.update(preference);
  await settled();
  expect(cache.labels(preference).get("issue_id")).toEqual([
    ...Array.from({ length: 16 }, (_, i) => `Issue ${i}`),
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(updates).toBe(1);
  expect(source.rows[19]).toEqual([text("19")]);
  release(
    result(
      ["id", "title"],
      Array.from({ length: 4 }, (_, i) => [
        text(String(i + 16)),
        text(`Issue ${i + 16}`),
      ]),
    ),
  );
  await settled();
  expect(cache.labels(preference).get("issue_id")).toEqual(
    Array.from({ length: 20 }, (_, i) => `Issue ${i}`),
  );
  expect(browseCount).toBe(2);
  expect(updates).toBe(2);
  cache.dispose();
});
