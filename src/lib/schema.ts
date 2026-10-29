import { rankSearch } from "./search";
import type { ForeignKey, Metadata, TableRef } from "./types";
export const SCHEMA_DIAGRAM_LIMIT = 200;
export function tableKey(table: TableRef): string {
  return JSON.stringify([table.schema, table.name]);
}
export function relationshipKey(key: ForeignKey): string {
  return JSON.stringify([
    tableKey(key.from),
    tableKey(key.to),
    key.name,
    key.columns,
    key.targetColumns,
  ]);
}
export function relatedTables(table: TableRef, keys: ForeignKey[]): TableRef[] {
  const root = tableKey(table);
  const tables = new Map<string, TableRef>();
  for (const key of keys)
    for (const reference of [key.from, key.to])
      if (tableKey(reference) !== root)
        tables.set(tableKey(reference), reference);
  return [...tables.values()];
}
export function filterSchemaTables(
  tables: TableRef[],
  search: string,
  namespace: string | null,
  kind: string,
): TableRef[] {
  return rankSearch(
    tables.filter(
      (t) =>
        (namespace === null || t.schema === namespace) &&
        (kind === "all" || t.kind === kind),
    ),
    search,
    (t) => [t.name, [t.schema, t.name].filter(Boolean).join(".")],
  );
}
export interface SchemaNode {
  id: string;
  table: TableRef;
  metadata?: Metadata;
  external: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SchemaEdge {
  id: string;
  from: string;
  to: string;
  foreignKey: ForeignKey;
}
export interface SchemaGraph {
  nodes: SchemaNode[];
  edges: SchemaEdge[];
  omittedRelationships: number;
}
// Condense cycles before assigning layers. Referenced tables sit to the left of
// their dependents. Large disconnected layers wrap instead of forming one tall column.
export function buildSchemaGraph(
  metadata: Metadata[],
  extraKeys: ForeignKey[] = [],
): SchemaGraph {
  const records = new Map<string, Metadata>();
  for (const item of metadata.slice(0, SCHEMA_DIAGRAM_LIMIT))
    records.set(tableKey(item.table), item);
  const keys = new Map<string, ForeignKey>();
  for (const key of [...metadata.flatMap((m) => m.foreignKeys), ...extraKeys])
    keys.set(relationshipKey(key), key);
  const references = new Map<string, TableRef>(
    [...records].map(([id, item]) => [id, item.table]),
  );
  for (const key of keys.values())
    for (const table of [key.from, key.to])
      if (
        references.size < SCHEMA_DIAGRAM_LIMIT &&
        !references.has(tableKey(table))
      )
        references.set(tableKey(table), table);
  const edges = [...keys]
    .filter(
      ([, key]) =>
        references.has(tableKey(key.from)) && references.has(tableKey(key.to)),
    )
    .slice(0, 1000)
    .map(([id, key]) => ({
      id,
      from: tableKey(key.from),
      to: tableKey(key.to),
      foreignKey: key,
    }));
  const adjacency = new Map(
    [...references.keys()].map((id) => [id, [] as string[]]),
  );
  for (const edge of edges) adjacency.get(edge.to)!.push(edge.from);
  let sequence = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    components: string[][] = [];
  function visit(id: string) {
    indices.set(id, sequence);
    low.set(id, sequence++);
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) || []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next))
        low.set(id, Math.min(low.get(id)!, indices.get(next)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let next: string;
      do {
        next = stack.pop()!;
        onStack.delete(next);
        component.push(next);
      } while (next !== id);
      components.push(component);
    }
  }
  for (const id of references.keys()) if (!indices.has(id)) visit(id);
  const componentOf = new Map<string, number>();
  components.forEach((component, i) =>
    component.forEach((id) => componentOf.set(id, i)),
  );
  const outgoing = components.map(() => new Set<number>()),
    indegree = components.map(() => 0),
    levels = components.map(() => 0);
  for (const edge of edges) {
    const parent = componentOf.get(edge.to)!,
      child = componentOf.get(edge.from)!;
    if (parent !== child && !outgoing[parent].has(child)) {
      outgoing[parent].add(child);
      indegree[child]++;
    }
  }
  const queue = indegree
    .map((degree, i) => (degree === 0 ? i : -1))
    .filter((i) => i >= 0);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const next of outgoing[current]) {
      levels[next] = Math.max(levels[next], levels[current] + 1);
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  const nodes: SchemaNode[] = [...references].map(([id, table]) => {
    const item = records.get(id);
    return {
      id,
      table,
      metadata: item,
      external: !item,
      x: levels[componentOf.get(id)!],
      y: 0,
      width: 255,
      height: item ? 65 + Math.min(item.columns.length, 6) * 22 : 98,
    };
  });
  const arranged = arrangeCards(nodes, edges);
  for (const node of nodes) Object.assign(node, arranged[node.id]);
  return { nodes, edges, omittedRelationships: keys.size - edges.length };
}

// Keep the first view readable; Fit all remains available for a full overview.
export function schemaViewport(
  nodes: SchemaNode[],
  width: number,
  height: number,
  options: { selected?: string; overview?: boolean } = {},
): { zoom: number; pan: { x: number; y: number } } {
  if (!nodes.length || width <= 0 || height <= 0)
    return { zoom: 1, pan: { x: 0, y: 0 } };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  const fit = Math.max(
    0.015,
    Math.min(
      1,
      Math.max(1, width - 80) / (maxX - minX),
      Math.max(1, height - 120) / (maxY - minY),
    ),
  );
  const zoom = options.overview ? fit : Math.max(0.65, fit);
  const target = nodes.find((n) => n.id === options.selected) || nodes[0];
  const centerX =
    !options.overview && (options.selected || fit < 0.65)
      ? target.x + target.width / 2
      : (minX + maxX) / 2;
  const centerY =
    !options.overview && (options.selected || fit < 0.65)
      ? target.y + target.height / 2
      : (minY + maxY) / 2;
  return {
    zoom,
    pan: { x: width / 2 - centerX * zoom, y: height / 2 - centerY * zoom },
  };
}

// Pack disconnected groups separately. Within each group, order layers by their
// neighbors' positions (barycentric sweeps), then center variable-height columns.
export function arrangeCards(
  cards: { id: string; x: number; width: number; height: number }[],
  edges: { from: string; to: string }[],
): Record<string, { x: number; y: number }> {
  const byId = new Map(cards.map((n) => [n.id, n]));
  const adjacent = new Map(cards.map((n) => [n.id, new Set<string>()]));
  for (const edge of edges)
    if (edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to)) {
      adjacent.get(edge.from)!.add(edge.to);
      adjacent.get(edge.to)!.add(edge.from);
    }
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const card of cards) {
    if (visited.has(card.id)) continue;
    const group = [card.id];
    visited.add(card.id);
    for (let i = 0; i < group.length; i++)
      for (const next of adjacent.get(group[i])!) {
        if (!visited.has(next)) {
          visited.add(next);
          group.push(next);
        }
      }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const packed = groups.map((group) => {
    const layers = new Map<number, string[]>();
    for (const id of group) {
      const rank = byId.get(id)!.x;
      layers.set(rank, [...(layers.get(rank) || []), id]);
    }
    const ordered = [...layers]
      .sort(([a], [b]) => a - b)
      .map(([, ids]) => ids.sort());
    const order = new Map<string, number>();
    ordered.forEach((ids) => ids.forEach((id, i) => order.set(id, i)));
    for (let sweep = 0; sweep < 6; sweep++) {
      const sequence = sweep % 2 ? [...ordered].reverse() : ordered;
      for (const ids of sequence) {
        const scores = new Map(
          ids.map((id) => {
            const neighbors = [...adjacent.get(id)!].filter(
              (n) => !ids.includes(n),
            );
            return [
              id,
              neighbors.length
                ? neighbors.reduce((sum, n) => sum + (order.get(n) || 0), 0) /
                  neighbors.length
                : order.get(id)!,
            ];
          }),
        );
        ids.sort(
          (a, b) => scores.get(a)! - scores.get(b)! || a.localeCompare(b),
        );
        ids.forEach((id, i) => order.set(id, i));
      }
    }
    const columns: string[][] = [];
    for (const ids of ordered)
      for (let i = 0; i < ids.length; i += 4) columns.push(ids.slice(i, i + 4));
    const heights = columns.map(
      (ids) =>
        ids.reduce((sum, id) => sum + byId.get(id)!.height, 0) +
        Math.max(0, ids.length - 1) * 44,
    );
    const height = Math.max(...heights);
    const positions: Record<string, { x: number; y: number }> = {};
    let x = 0;
    columns.forEach((ids, c) => {
      let y = (height - heights[c]) / 2;
      for (const id of ids) {
        positions[id] = { x, y };
        y += byId.get(id)!.height + 44;
      }
      x += Math.max(...ids.map((id) => byId.get(id)!.width)) + 100;
    });
    return { positions, width: x - 100, height };
  });
  const area = packed.reduce(
    (sum, g) => sum + (g.width + 100) * (g.height + 100),
    0,
  );
  const shelfWidth = Math.max(900, Math.min(3600, Math.sqrt(area) * 1.5));
  const positions: Record<string, { x: number; y: number }> = {};
  let x = 60,
    y = 70,
    rowHeight = 0;
  for (const group of packed) {
    if (x > 60 && x + group.width > shelfWidth) {
      x = 60;
      y += rowHeight + 100;
      rowHeight = 0;
    }
    for (const [id, p] of Object.entries(group.positions))
      positions[id] = { x: p.x + x, y: p.y + y };
    x += group.width + 100;
    rowHeight = Math.max(rowHeight, group.height);
  }
  return positions;
}

export function relatedSchemaNodeIds(
  id: string,
  edges: SchemaEdge[],
): Set<string> {
  const related = new Set([id]);
  for (const edge of edges)
    if (edge.from === id || edge.to === id) {
      related.add(edge.from);
      related.add(edge.to);
    }
  return related;
}
