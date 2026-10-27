import { Tooltip } from "../components/ui/tooltip";
import { arrangeCards } from "../lib/schema";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Copy,
  Eye,
  FileCode2,
  Focus,
  LayoutGrid,
  GitBranch,
  KeyRound,
  Maximize2,
  Minus,
  Network,
  Plus,
  Save,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import {
  Empty,
  ErrorState,
  Field,
  Loading,
  Tag,
  copyFeedback,
} from "../components/shared";
import { mergeGraph, graphReferences } from "../lib/graph";
import { api, errorMessage, useRemote } from "../lib/api";
import { notify, openTab, update, useWorkspace } from "../lib/store";
import {
  display,
  identity,
  readableKey,
  rowKey,
  watchMatchesRecord,
  type GraphNode,
  type GraphState,
  type Investigation,
  type Metadata,
  type RecordData,
  type RecordRef,
  type Relationship,
  type ResultSet,
  type Tab,
} from "../lib/types";
export async function openRecordSql(record: RecordRef) {
  try {
    const query = await api<{
      sql: string;
      params: import("../lib/types").DbValue[];
    }>("record_sql", record);
    openTab({
      kind: "query",
      title: `${record.table.name} query`,
      connectionId: record.connectionId,
      sql: query.sql,
      boundParams: query.params,
      savedSql: "",
    });
  } catch (error) {
    notify(errorMessage(error), true);
  }
}
export function inspectInTable(record: RecordRef) {
  openTab({
    kind: "table",
    title: record.table.name,
    connectionId: record.connectionId,
    table: record.table,
    filters: Object.entries(record.key).map(([column, value]) => ({
      column,
      operator: "eq",
      value,
    })),
  });
}
export function Inspector({
  record,
  onClose,
}: {
  record: RecordRef;
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  const data = useRemote<RecordData>(
    "record",
    record,
    workspace.activeConnections.includes(record.connectionId),
  );
  const [expanded, setExpanded] = useState<string[]>([]);
  const watching = workspace.watches.filter((w) =>
    watchMatchesRecord(w, record),
  );
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <span>
          <Table2 size={14} />
          Record inspector
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X size={15} />
        </Button>
      </div>
      <div className="inspector-scroll">
        <div className="eyebrow">
          {record.table.schema ||
            workspace.connections.find((c) => c.id === record.connectionId)
              ?.name}
        </div>
        <h2>{record.table.name}</h2>
        <Tooltip content={"Copy identifier"}>
          <button
            className="record-key"
            onClick={() =>
              void copyFeedback(JSON.stringify(record.key, null, 2))
            }
          >
            <KeyRound size={13} />
            {readableKey(record)}
            <Copy size={12} />
          </button>
        </Tooltip>
        <div className="inspector-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              openTab({
                kind: "investigation",
                title: `Investigate ${record.table.name}`,
                connectionId: record.connectionId,
                root: record,
              })
            }
          >
            <Network size={14} />
            Investigate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("kitsune:watch", { detail: record }),
              )
            }
          >
            <Eye size={14} />
            Watch
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Open record in table"
            onClick={() => inspectInTable(record)}
          >
            <Table2 size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Open parameterized record SQL"
            onClick={() => void openRecordSql(record)}
          >
            <FileCode2 size={14} />
          </Button>
        </div>
        {watching.map((w) => (
          <div className="watch-indicator" key={w.id}>
            <span
              className={`connection-dot ${w.status === "running" ? "online" : ""}`}
            />
            {w.name} · {w.status}
          </div>
        ))}
        {data.loading && <Loading />}
        {data.error && (
          <ErrorState error={data.error} retry={() => void data.refresh()} />
        )}{" "}
        {data.data && !data.data.result.rows.length && (
          <ErrorState error="This record no longer exists. Saved references have been preserved." />
        )}
        {data.data?.result.rows[0] && (
          <>
            <div className="section-label">
              Fields <Tag>{data.data.metadata.columns.length}</Tag>
            </div>
            {data.data.metadata.columns.map((c, i) => {
              const value =
                data.data!.result.rows[0][
                  data.data!.result.columns.indexOf(c.name)
                ];
              const text = display(value);
              return (
                <div className="inspector-field" key={i}>
                  <div>
                    <span>
                      {c.pk > 0 && <KeyRound size={10} />} {c.name}
                    </span>
                    <span className="type-label">{c.dataType}</span>
                  </div>
                  <Tooltip content={"Expand/collapse value"}>
                    <button
                      className={value?.kind === "null" ? "null" : ""}
                      onClick={() =>
                        setExpanded((a) =>
                          a.includes(c.name)
                            ? a.filter((n) => n !== c.name)
                            : [...a, c.name],
                        )
                      }
                    >
                      {expanded.includes(c.name) ? text : text.slice(0, 180)}
                      {text.length > 180 && !expanded.includes(c.name) && "…"}
                    </button>
                  </Tooltip>
                </div>
              );
            })}
            <div className="section-label">
              Relationships <Tag>{data.data.relationships.length}</Tag>
            </div>
            {data.data.relationships.map((r, i) => (
              <button
                key={i}
                className="relationship-link"
                onClick={() =>
                  openTab({
                    kind: "investigation",
                    title: `Investigate ${record.table.name}`,
                    connectionId: record.connectionId,
                    root: record,
                  })
                }
              >
                {r.direction === "incoming" ? (
                  <ArrowDownLeft size={14} />
                ) : (
                  <ArrowUpRight size={14} />
                )}
                <span>
                  {r.direction === "incoming"
                    ? r.foreignKey.from.name
                    : r.foreignKey.to.name}
                  <small>
                    {r.foreignKey.columns.join(", ")} →{" "}
                    {r.foreignKey.targetColumns.join(", ")}
                  </small>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
export function DetectiveWorkspace({ tab }: { tab: Tab }) {
  const root = tab.root || tab.investigation?.root;
  const rootNode: GraphNode | null = root
    ? { id: identity(root), record: root, x: 80, y: 130, depth: 0 }
    : null;
  const initial = tab.investigation?.graph;
  const [graph, setGraph] = useState<GraphState>(
    initial?.nodes?.length
      ? initial
      : {
          nodes: rootNode ? [rootNode] : [],
          edges: [],
          selected: rootNode?.id || "",
        },
  );
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(tab.investigation?.name || "");
  const [savedId, setSavedId] = useState(tab.investigation?.id || "");
  const [pages, setPages] = useState<Record<string, number>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [saveBusy, setSaveBusy] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace();
  const selected = graph.nodes.find((n) => n.id === graph.selected);
  const data = useRemote<RecordData>(
    "record",
    selected?.record,
    !!selected &&
      workspace.activeConnections.includes(selected.record.connectionId),
  );
  useEffect(() => {
    if (selected) update({ inspector: selected.record });
  }, [selected?.id]);
  async function expand(relationship: Relationship, nextPage = false) {
    if (!selected || !data.data?.result.rows[0]) return;
    if (selected.depth >= 3) {
      notify(
        "Maximum traversal depth reached (3). Start a new investigation from this record.",
      );
      return;
    }
    const key = `${selected.id}:${relationship.direction}:${relationship.foreignKey.name}`;
    setBusy(key);
    setError("");
    try {
      const offset = nextPage ? (pages[key] || 0) + 50 : 0;
      const row = data.data.result.rows[0];
      const values = Object.fromEntries(
        data.data.result.columns.map((c, i) => [c, row[i]]),
      );
      const result = await api<{
        metadata: Metadata | null;
        result: ResultSet;
      }>("expand", {
        connectionId: selected.record.connectionId,
        foreignKey: relationship.foreignKey,
        direction: relationship.direction,
        values,
        offset,
      });
      if (!result.result.rows.length) notify("No related records found.");
      const additions: GraphNode[] = [];
      const edges: GraphState["edges"] = [];
      for (const row of result.result.rows) {
        if (!result.metadata) continue;
        const pk = rowKey(result.metadata, result.result.columns, row);
        if (!Object.keys(pk).length) {
          notify(
            "Related table has no usable primary key. Open it in the table browser.",
          );
          continue;
        }
        const record = {
          connectionId: selected.record.connectionId,
          table: result.metadata.table,
          key: pk,
        };
        const id = identity(record);
        const labelIndex = result.result.columns.findIndex((c) =>
          /^(name|title|email|status|label)$/.test(c),
        );
        if (!graph.nodes.some((n) => n.id === id))
          additions.push({
            id,
            record,
            x: selected.x + 320,
            y: selected.y + additions.length * 145 - 60,
            depth: selected.depth + 1,
            label:
              labelIndex >= 0
                ? display(row[labelIndex]).slice(0, 70)
                : undefined,
          });
        edges.push({
          from: selected.id,
          to: id,
          label: relationship.foreignKey.name,
        });
      }
      const merged = mergeGraph(graph, additions, edges);
      const positions = arrangeCards(
        merged.nodes.map((n) => ({
          id: n.id,
          x: n.depth,
          width: 260,
          height: 150,
        })),
        merged.edges,
      );
      setGraph({
        ...merged,
        nodes: merged.nodes.map((n) => ({ ...n, ...positions[n.id] })),
      });
      setPages((p) => ({ ...p, [key]: offset }));
      setHasMore((m) => ({ ...m, [key]: result.result.truncated }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  function collapse() {
    if (!selected) return;
    const targets = new Set(
      graph.edges
        .filter((e) => e.from === selected.id && e.to !== rootNode?.id)
        .map((e) => e.to),
    );
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => !targets.has(n.id)),
      edges: g.edges.filter((e) => !targets.has(e.from) && !targets.has(e.to)),
    }));
  }
  function dragNode(event: React.PointerEvent, node: GraphNode) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.stopPropagation();
    const x = event.clientX,
      y = event.clientY;
    setGraph((g) => ({ ...g, selected: node.id }));
    const move = (e: PointerEvent) =>
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === node.id
            ? {
                ...n,
                x: node.x + (e.clientX - x) / zoom,
                y: node.y + (e.clientY - y) / zoom,
              }
            : n,
        ),
      }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function fit() {
    const width = canvas.current?.clientWidth || 800,
      height = canvas.current?.clientHeight || 600;
    const minX = Math.min(...graph.nodes.map((n) => n.x)),
      minY = Math.min(...graph.nodes.map((n) => n.y));
    const maxX = Math.max(...graph.nodes.map((n) => n.x + 260)),
      maxY = Math.max(...graph.nodes.map((n) => n.y + 115));
    const scale = Math.min(
      1.2,
      Math.max(
        0.02,
        Math.min((width - 80) / (maxX - minX), (height - 80) / (maxY - minY)),
      ),
    );
    setZoom(scale);
    setPan({
      x: (width - (maxX - minX) * scale) / 2 - minX * scale,
      y: (height - (maxY - minY) * scale) / 2 - minY * scale,
    });
  }
  async function save() {
    if (!root) return;
    setSaveBusy(true);
    try {
      const i = await api<Investigation>("save_investigation", {
        id: savedId,
        name,
        root,
        graph: graphReferences(graph),
      });
      setSavedId(i.id);
      setSaving(false);
      notify("Investigation saved. Record values are not persisted.");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaveBusy(false);
    }
  }
  if (!root)
    return (
      <Empty
        icon={<Network size={26} />}
        title="Start with a record"
        detail="Select a record in a table, then choose Investigate."
      />
    );
  return (
    <div className="detective-workspace">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">Investigation mode / Detective</div>
          <h1>
            <Network size={20} />
            {name || root.table.name}
            <Tag>
              {graph.nodes.length} record{graph.nodes.length === 1 ? "" : "s"}
            </Tag>
          </h1>
        </div>
        <div className="spacer" />
        <Button variant="secondary" size="sm" onClick={() => setSaving(true)}>
          <Save size={14} />
          Save investigation
        </Button>
      </div>
      <div className="graph-body">
        <div
          className="graph-canvas"
          ref={canvas}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest(".graph-node,button")) return;
            const x = e.clientX,
              y = e.clientY,
              origin = pan;
            const move = (event: PointerEvent) =>
              setPan({
                x: origin.x + event.clientX - x,
                y: origin.y + event.clientY - y,
              });
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey)
              setZoom((z) => Math.max(0.02, Math.min(2, z - e.deltaY * 0.002)));
            else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
          }}
        >
          <div className="graph-context">
            <span className="connection-dot online" />
            {
              workspace.connections.find((c) => c.id === root.connectionId)
                ?.name
            }
            <span>Foreign-key relationships</span>
          </div>
          <div
            className="graph-transform"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            <svg
              className="graph-edges"
              width={10000}
              height={10000}
              aria-hidden="true"
            >
              {graph.edges.map((e, i) => {
                const a = graph.nodes.find((n) => n.id === e.from),
                  b = graph.nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const forward = a.x <= b.x;
                const x1 = a.x + (forward ? 260 : 0),
                  y1 = a.y + 55,
                  x2 = b.x + (forward ? 0 : 260),
                  y2 = b.y + 55;
                const bend =
                  Math.max(65, Math.abs(x2 - x1) * 0.45) * (forward ? 1 : -1);
                const related =
                  e.from === graph.selected || e.to === graph.selected;
                return (
                  <g key={i} opacity={related ? 1 : 0.25}>
                    <title>{e.label}</title>
                    <path
                      d={
                        a.id === b.id
                          ? `M${x1},${y1} C${x1 + 80},${y1 - 80} ${x1 + 80},${y1 + 80} ${x1},${y1 + 12}`
                          : `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
                      }
                      fill="none"
                      stroke="var(--edge)"
                      strokeWidth="1.5"
                    />
                    {related && (
                      <text
                        x={(x1 + x2) / 2}
                        y={(y1 + y2) / 2 - 10}
                        textAnchor="middle"
                        fill="var(--muted)"
                        fontSize="10"
                      >
                        {e.label.slice(0, 24)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {graph.nodes.map((node) => (
              <div
                className={`graph-node ${node.id === graph.selected ? "selected" : ""}`}
                key={node.id}
                style={{ left: node.x, top: node.y }}
                onPointerDown={(e) => dragNode(e, node)}
                onClick={() => setGraph((g) => ({ ...g, selected: node.id }))}
                tabIndex={0}
                role="button"
                aria-label={`Inspect ${node.record.table.name} ${readableKey(node.record)}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    setGraph((g) => ({ ...g, selected: node.id }));
                }}
              >
                <div className="node-heading">
                  <Table2 size={15} />
                  <strong>{node.record.table.name}</strong>
                  {node.depth === 0 && <span className="node-root">ROOT</span>}
                  {workspace.watches.some(
                    (w) =>
                      w.status === "running" &&
                      watchMatchesRecord(w, node.record),
                  ) && <Eye size={13} className="accent" />}
                </div>
                <div className="node-key">
                  <KeyRound size={11} />
                  {readableKey(node.record)}
                </div>
                {node.label && <div className="node-label">{node.label}</div>}
                <div className="node-footer">
                  <span>{node.record.table.schema || "record"}</span>
                  <Tooltip content={"Open record in table"}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        inspectInTable(node.record);
                      }}
                    >
                      <Maximize2 size={12} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
          <div className="graph-controls">
            <button
              onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
              aria-label="Zoom in"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.02, z - 0.15))}
              aria-label="Zoom out"
            >
              <Minus size={16} />
            </button>
            <Tooltip content={"Arrange related records"}>
              <button
                aria-label="Arrange records"
                onClick={() => {
                  const positions = arrangeCards(
                    graph.nodes.map((n) => ({
                      id: n.id,
                      x: n.depth,
                      width: 260,
                      height: 150,
                    })),
                    graph.edges,
                  );
                  setGraph((g) => ({
                    ...g,
                    nodes: g.nodes.map((n) => ({ ...n, ...positions[n.id] })),
                  }));
                }}
              >
                <LayoutGrid size={16} />
              </button>
            </Tooltip>
            <button onClick={fit} aria-label="Fit graph">
              <Focus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
          </div>
          <div className="graph-caption">
            Drag to pan · Drag records to arrange · Ctrl/⌘ + scroll to zoom
          </div>
        </div>
        <div className="graph-relations">
          <div className="panel-heading">
            <span>
              <GitBranch size={14} />
              Relationships
            </span>
            {selected && <Tag>{selected.record.table.name}</Tag>}
          </div>
          {error && <ErrorState error={error} />} {data.loading && <Loading />}
          {data.error && <ErrorState error={data.error} />}{" "}
          {data.data && !data.data.result.rows.length && (
            <ErrorState error="This saved record no longer exists." />
          )}
          {data.data?.relationships.map((r, i) => {
            const key = `${selected?.id}:${r.direction}:${r.foreignKey.name}`;
            return (
              <div className="relationship-card" key={i}>
                <div>
                  {r.direction === "outgoing" ? (
                    <ArrowUpRight size={15} />
                  ) : (
                    <ArrowDownLeft size={15} />
                  )}
                  <strong>
                    {r.direction === "incoming"
                      ? r.foreignKey.from.name
                      : r.foreignKey.to.name}
                  </strong>
                  <Tag>{r.direction}</Tag>
                </div>
                <code>
                  {r.foreignKey.columns.join(", ")} →{" "}
                  {r.foreignKey.targetColumns.join(", ")}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() => void expand(r, !!hasMore[key])}
                >
                  {busy === key
                    ? "Loading…"
                    : hasMore[key]
                      ? "Load next 50"
                      : "Expand relationship"}
                  <Plus size={12} />
                </Button>
              </div>
            );
          })}
          {data.data && !data.data.relationships.length && (
            <p className="muted pad">No declared relationships.</p>
          )}
          {selected && (
            <div className="pad">
              <Button variant="ghost" size="sm" onClick={collapse}>
                <Trash2 size={13} />
                Collapse direct relations
              </Button>
            </div>
          )}
        </div>
      </div>
      {saving && (
        <Dialog
          open
          onClose={() => setSaving(false)}
          title="Save investigation"
          description="Only record references and graph layout are stored. Values are fetched when reopened."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Name">
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Investigate unexpected order status"
              />
            </Field>
            <footer>
              <Button disabled={saveBusy}>
                <Save size={14} />
                Save investigation
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
