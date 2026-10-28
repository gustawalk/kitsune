import { describe, expect, test } from "bun:test";
import {
  buildSchemaGraph,
  schemaViewport,
  filterSchemaTables,
  relatedSchemaNodeIds,
  relatedTables,
  tableKey,
} from "../src/lib/schema";
import type { ForeignKey, Metadata, TableRef } from "../src/lib/types";
const table = (name: string, schema = ""): TableRef => ({
  name,
  schema,
  kind: "table",
});
function metadata(
  reference: TableRef,
  foreignKeys: ForeignKey[] = [],
): Metadata {
  return {
    table: reference,
    columns: [
      {
        name: "id",
        dataType: "INTEGER",
        nullable: false,
        defaultValue: null,
        pk: 1,
      },
      {
        name: "tenant",
        dataType: "TEXT",
        nullable: false,
        defaultValue: null,
        pk: 2,
      },
    ],
    foreignKeys,
    indexes: [],
  };
}
function key(from: TableRef, to: TableRef, name = "reference"): ForeignKey {
  return {
    name,
    from,
    to,
    columns: ["id", "tenant"],
    targetColumns: ["id", "tenant"],
  };
}
describe("schema catalog", () => {
  test("searches qualified names and filters schema/object type", () => {
    const refs = [
      table("orders", "public"),
      table("orders", "archive"),
      { ...table("pending_orders", "public"), kind: "view" },
    ];
    expect(filterSchemaTables(refs, "PUBLIC.ORDERS", null, "all")).toEqual([
      refs[0],
    ]);
    expect(filterSchemaTables(refs, "orders", "public", "view")).toEqual([
      refs[2],
    ]);
    expect(filterSchemaTables(refs, "missing", null, "all")).toEqual([]);
  });
  test("keeps identical table names in separate namespaces", () => {
    expect(tableKey(table("orders", "public"))).not.toBe(
      tableKey(table("orders", "archive")),
    );
  });
});
describe("schema ER graph", () => {
  test("uses confirmed composite foreign keys without inferring name matches", () => {
    const orders = table("orders"),
      items = table("items"),
      unrelated = table("order_statistics");
    const fk = key(items, orders);
    const graph = buildSchemaGraph([
      metadata(orders),
      metadata(items, [fk]),
      metadata(unrelated),
    ]);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].foreignKey.columns).toEqual(["id", "tenant"]);
    expect(graph.edges[0].foreignKey.targetColumns).toEqual(["id", "tenant"]);
    const parent = graph.nodes.find((n) => n.id === tableKey(orders))!,
      child = graph.nodes.find((n) => n.id === tableKey(items))!;
    expect(parent.x).toBeLessThan(child.x);
  });
  test("handles cycles and self references without infinite expansion", () => {
    const a = table("a"),
      b = table("b");
    const graph = buildSchemaGraph([
      metadata(a, [key(a, b), key(a, a, "self")]),
      metadata(b, [key(b, a)]),
    ]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(3);
    expect(
      graph.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
    ).toBe(true);
  });
  test("deduplicates relationships and marks unavailable targets explicitly", () => {
    const a = table("a"),
      b = table("b");
    const fk = key(a, b);
    const graph = buildSchemaGraph([metadata(a, [fk])], [fk]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.find((n) => n.id === tableKey(b))?.external).toBe(true);
    expect(
      graph.nodes.find((n) => n.id === tableKey(b))?.metadata,
    ).toBeUndefined();
  });
  test("bounds diagrams to 200 nodes and records omitted relationships", () => {
    const root = table("root");
    const targets = Array.from({ length: 220 }, (_, i) => table(`target_${i}`));
    const graph = buildSchemaGraph([
      metadata(
        root,
        targets.map((target, i) => key(root, target, `fk_${i}`)),
      ),
    ]);
    expect(graph.nodes.length).toBe(200);
    expect(graph.omittedRelationships).toBeGreaterThan(0);
  });
  test("finds unique incoming and outgoing neighbors without losing schema", () => {
    const a = table("a"),
      b = table("b", "public"),
      c = table("b", "archive");
    const refs = relatedTables(a, [key(a, b), key(b, a), key(c, a)]);
    expect(refs).toHaveLength(2);
    expect(refs.map(tableKey)).toContain(tableKey(c));
  });
});
import { getWorkspace, openTab, update } from "../src/lib/store";
test("schema navigation keeps one workspace per connection and changes the selected table", () => {
  update({ tabs: [], activeTab: "" });
  openTab({
    kind: "schema",
    title: "Schema viewer",
    connectionId: "c",
    schemaTable: table("orders"),
  });
  openTab({
    kind: "schema",
    title: "Schema viewer",
    connectionId: "c",
    schemaTable: table("customers"),
  });
  expect(getWorkspace().tabs).toHaveLength(1);
  expect(getWorkspace().tabs[0].schemaTable?.name).toBe("customers");
  openTab({ kind: "schema", title: "Schema viewer", connectionId: "other" });
  expect(getWorkspace().tabs).toHaveLength(2);
});

describe("schema initial viewport", () => {
  test("keeps a large schema readable and centers the selected table", () => {
    const nodes = buildSchemaGraph(
      Array.from({ length: 100 }, (_, i) => metadata(table(`table_${i}`))),
    ).nodes;
    const selected = nodes[50];
    const view = schemaViewport(nodes, 800, 600, { selected: selected.id });
    expect(view.zoom).toBeGreaterThanOrEqual(0.65);
    expect(
      (selected.x + selected.width / 2) * view.zoom + view.pan.x,
    ).toBeCloseTo(400);
    expect(
      (selected.y + selected.height / 2) * view.zoom + view.pan.y,
    ).toBeCloseTo(300);
    const overview = schemaViewport(nodes, 800, 600, { overview: true });
    expect(overview.zoom).toBeLessThan(view.zoom);
    for (const node of nodes) {
      expect(node.x * overview.zoom + overview.pan.x).toBeGreaterThanOrEqual(
        39,
      );
      expect(
        (node.x + node.width) * overview.zoom + overview.pan.x,
      ).toBeLessThanOrEqual(761);
    }
  });
  test("centers small diagrams and handles an empty or hidden canvas", () => {
    const nodes = buildSchemaGraph([metadata(table("orders"))]).nodes;
    const view = schemaViewport(nodes, 800, 600);
    expect(view.zoom).toBe(1);
    expect(nodes[0].x + nodes[0].width / 2 + view.pan.x).toBe(400);
    expect(schemaViewport([], 800, 600)).toEqual({
      zoom: 1,
      pan: { x: 0, y: 0 },
    });
    expect(schemaViewport(nodes, 0, 0).zoom).toBe(1);
  });
});

test("connected groups are packed without overlapping variable-height cards", () => {
  const a = table("customers"),
    b = table("orders"),
    c = table("payments");
  const graph = buildSchemaGraph([
    metadata(a),
    metadata(b, [key(b, a)]),
    metadata(c, [key(c, b)]),
    ...Array.from({ length: 30 }, (_, i) => {
      const item = metadata(table(`unrelated_${i}`));
      item.columns = Array.from({ length: 1 + (i % 10) }, (_, j) => ({
        ...item.columns[0],
        name: `column_${j}`,
      }));
      return item;
    }),
  ]);
  for (let i = 0; i < graph.nodes.length; i++)
    for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i],
        b = graph.nodes[j];
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      ).toBe(true);
    }
  const connected = graph.nodes.filter((n) =>
    ["customers", "orders", "payments"].includes(n.table.name),
  );
  expect(
    Math.max(...connected.map((n) => n.y)) -
      Math.min(...connected.map((n) => n.y)),
  ).toBe(0);
  expect(graph.nodes.find((n) => n.table.name === "customers")!.x).toBeLessThan(
    graph.nodes.find((n) => n.table.name === "orders")!.x,
  );
});

test("table filters expose only direct relationships", () => {
  const accounts = table("accounts", "public");
  const orders = table("orders", "public");
  const payments = table("payments", "public");
  const audit = table("audit", "public");
  const graph = buildSchemaGraph([
    metadata(accounts),
    metadata(orders, [key(orders, accounts, "orders_account_fk")]),
    metadata(payments, [key(payments, orders, "payments_order_fk")]),
    metadata(audit),
  ]);

  const related = relatedSchemaNodeIds(tableKey(orders), graph.edges);

  expect([...related].sort()).toEqual(
    [accounts, orders, payments].map(tableKey).sort(),
  );
  expect(related.has(tableKey(audit))).toBe(false);
});
