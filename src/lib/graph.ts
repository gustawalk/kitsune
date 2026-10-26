import type { GraphNode, GraphState } from "./types";
export function mergeGraph(
  graph: GraphState,
  additions: GraphNode[],
  edges: GraphState["edges"],
): GraphState {
  const known = new Set(graph.nodes.map((n) => n.id));
  const unique = additions.filter((n) => {
    if (known.has(n.id)) return false;
    known.add(n.id);
    return true;
  });
  if (graph.nodes.length + unique.length > 200)
    throw new Error(
      "Maximum graph size is 200 records. Collapse a branch before expanding.",
    );
  const edgeIds = new Set(
    graph.edges.map((e) => JSON.stringify([e.from, e.to, e.label])),
  );
  return {
    ...graph,
    nodes: [...graph.nodes, ...unique],
    edges: [
      ...graph.edges,
      ...edges.filter((e) => {
        const id = JSON.stringify([e.from, e.to, e.label]);
        if (edgeIds.has(id)) return false;
        edgeIds.add(id);
        return true;
      }),
    ],
  };
}
export function graphReferences(graph: GraphState): GraphState {
  return {
    ...graph,
    nodes: graph.nodes.map(({ label: _label, ...node }) => node),
  };
}
