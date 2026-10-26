import { useLayoutPreference } from "../lib/layout-preferences";
import { z } from "zod";
import { Tooltip } from "./ui/tooltip";
import {
  moveDiagramGesture,
  finishDiagramGesture,
  type DiagramGesture,
} from "../lib/diagram-gesture";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Focus,
  LocateFixed,
  KeyRound,
  Minus,
  Plus,
  Table2,
  LayoutGrid,
} from "lucide-react";
import type { SchemaGraph, SchemaNode } from "../lib/schema";
import { schemaViewport, tableKey } from "../lib/schema";
import type { TableRef } from "../lib/types";
export function SchemaDiagram({
  graph,
  preferenceKey,
  selected,
  onSelect,
}: {
  graph: SchemaGraph;
  preferenceKey?: string;
  selected?: TableRef;
  onSelect: (table: TableRef) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [positions, setPositions] = useLayoutPreference(
    preferenceKey,
    z
      .record(
        z.string(),
        z.object({ x: z.number().finite(), y: z.number().finite() }),
      )
      .refine((v) => Object.keys(v).length <= 200),
    {} as Record<string, { x: number; y: number }>,
  );
  const manual = useRef(false);
  const gesture = useRef<DiagramGesture | null>(null);
  const nodes = useMemo(
    () => graph.nodes.map((n) => ({ ...n, ...positions[n.id] })),
    [graph.nodes, positions],
  );
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const frame = useCallback(
    (overview = false, focus?: string) => {
      if (!canvas.current) return;
      const viewport = schemaViewport(
        nodes,
        canvas.current.clientWidth,
        canvas.current.clientHeight,
        { overview, selected: focus },
      );
      setZoom(viewport.zoom);
      setPan(viewport.pan);
    },
    [nodes],
  );
  const selectedId = selected ? tableKey(selected) : undefined;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      if (!manual.current)
        timer = setTimeout(() => {
          if (!manual.current) frame(false, selectedId);
        }, 100);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [frame, selectedId]);
  function beginGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gesture.current) return;
    const target = event.target as Element;
    const card = target.closest<HTMLElement>("[data-schema-node]");
    if (!card && target.closest("button,.graph-controls")) return;
    const node = card ? nodeMap.get(card.dataset.schemaNode!) : undefined;
    event.preventDefault();
    manual.current = true;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node?.x ?? pan.x,
      originY: node?.y ?? pan.y,
      zoom,
      nodeId: node?.id,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveGesture(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const next = moveDiagramGesture(
      active,
      event.pointerId,
      event.clientX,
      event.clientY,
    );
    if (!next) return;
    if (active.nodeId)
      setPositions((p) => ({
        ...Object.fromEntries(
          Object.entries(p).filter(([id]) => nodeMap.has(id)),
        ),
        [active.nodeId!]: next,
      }));
    else setPan(next);
  }
  function endGesture(
    event: React.PointerEvent<HTMLDivElement>,
    cancelled = false,
  ) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Some platforms deliver pointerup without a final pointermove.
    if (!cancelled) moveGesture(event);
    const id = finishDiagramGesture(active, event.pointerId, cancelled);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (id) {
      const node = nodeMap.get(id);
      if (node) onSelect(node.table);
    }
  }
  function anchor(node: SchemaNode, column: string, right: boolean) {
    const index =
      node.metadata?.columns.findIndex((c) => c.name === column) ?? -1;
    return {
      x: node.x + (right ? node.width : 0),
      y: node.y + (index >= 0 ? 49 + Math.min(index, 5) * 22 : 42),
    };
  }
  return (
    <div
      className="schema-canvas"
      ref={canvas}
      onPointerDown={beginGesture}
      onPointerMove={moveGesture}
      onPointerUp={(event) => endGesture(event)}
      onPointerCancel={(event) => endGesture(event, true)}
      onLostPointerCapture={() => {
        gesture.current = null;
      }}
      onDragStart={(event) => event.preventDefault()}
      onWheel={(event) => {
        if (gesture.current) return;
        manual.current = true;
        if (event.ctrlKey || event.metaKey)
          setZoom((z) =>
            Math.max(0.015, Math.min(1.8, z - event.deltaY * 0.002)),
          );
        else setPan((p) => ({ x: p.x - event.deltaX, y: p.y - event.deltaY }));
      }}
    >
      <div className="schema-diagram-legend">
        <span>
          <KeyRound size={11} />
          Primary key
        </span>
        <span className="schema-fk-marker" />
        Declared foreign key
        <span className="spacer" />
        {graph.nodes.filter((n) => !n.external).length} tables/views ·{" "}
        {graph.edges.length} relationships
      </div>
      <svg
        className="schema-edges schema-edge-viewport"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {graph.edges.map((edge) => {
            const from = nodeMap.get(edge.from),
              to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const self = from.id === to.id;
            const right = self || from.x <= to.x;
            const a = anchor(from, edge.foreignKey.columns[0], right),
              b = anchor(to, edge.foreignKey.targetColumns[0], self || !right);
            const bend = self ? 75 : Math.max(60, Math.abs(b.x - a.x) * 0.45);
            const direction = right ? 1 : -1;
            const d = self
              ? `M${a.x},${a.y} C${a.x + bend},${a.y - 70} ${b.x + bend},${b.y + 75} ${b.x},${b.y + 12}`
              : `M${a.x},${a.y} C${a.x + direction * bend},${a.y} ${b.x - direction * bend},${b.y} ${b.x},${b.y}`;
            return (
              <g
                key={edge.id}
                className={
                  selected && [edge.from, edge.to].includes(tableKey(selected))
                    ? "schema-edge emphasized"
                    : "schema-edge"
                }
              >
                <title>
                  {edge.foreignKey.name}: {edge.foreignKey.from.name} (
                  {edge.foreignKey.columns.join(", ")}) →{" "}
                  {edge.foreignKey.to.name} (
                  {edge.foreignKey.targetColumns.join(", ")})
                </title>
                <path d={d} />
                <circle cx={a.x} cy={a.y} r="3" />
                <circle cx={b.x} cy={b.y + (self ? 12 : 0)} r="3" />
              </g>
            );
          })}
        </g>
      </svg>
      <div
        className="graph-transform"
        style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}
      >
        {nodes.map((node) => (
          <section
            key={node.id}
            className={`schema-node ${node.id === (selected ? tableKey(selected) : "") ? "selected" : ""} ${node.external ? "external" : ""}`}
            style={{
              left: node.x,
              top: node.y,
              width: node.width,
              height: node.height,
            }}
            data-schema-node={node.id}
          >
            <header>
              <Table2 size={14} />
              <Tooltip
                content={`Click to inspect ${[node.table.schema, node.table.name].filter(Boolean).join(".")} · Drag to move`}
              >
                <button
                  type="button"
                  aria-pressed={node.id === selectedId}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      manual.current = true;
                      onSelect(node.table);
                    }
                  }}
                >
                  {node.table.name}
                </button>
              </Tooltip>
              <small>{node.table.kind}</small>
            </header>
            {node.external ? (
              <p className="schema-external-label">Metadata not loaded</p>
            ) : (
              <div>
                {node.metadata!.columns.slice(0, 6).map((column) => (
                  <div className="schema-node-column" key={column.name}>
                    <span className={column.pk ? "accent" : "subtle"}>
                      {column.pk ? <KeyRound size={10} /> : "·"}
                    </span>
                    <Tooltip content={column.name}>
                      <span>{column.name}</span>
                    </Tooltip>
                    <Tooltip content={column.dataType}>
                      <code>{column.dataType}</code>
                    </Tooltip>
                  </div>
                ))}
              </div>
            )}
            <footer>
              <span>{node.table.schema || "SQLite"}</span>
              {node.metadata && node.metadata.columns.length > 6 ? (
                <button
                  onClick={(event) => {
                    if (event.detail === 0) {
                      manual.current = true;
                      onSelect(node.table);
                    }
                  }}
                >
                  +{node.metadata.columns.length - 6} columns
                </button>
              ) : (
                <span>{node.metadata?.columns.length ?? "—"} columns</span>
              )}
            </footer>
          </section>
        ))}
      </div>
      <div className="graph-controls">
        <Tooltip content={"Arrange related tables"}>
          <button
            aria-label="Arrange related tables"
            onClick={() => {
              manual.current = false;
              setPositions({});
            }}
          >
            <LayoutGrid size={16} />
          </button>
        </Tooltip>
        <button
          aria-label="Zoom in"
          onClick={() => {
            manual.current = true;
            setZoom((z) => Math.min(1.8, z + 0.15));
          }}
        >
          <Plus size={16} />
        </button>
        <button
          aria-label="Zoom out"
          onClick={() => {
            manual.current = true;
            setZoom((z) => Math.max(0.015, z - 0.15));
          }}
        >
          <Minus size={16} />
        </button>
        <Tooltip content={"Focus selected table"}>
          <button
            aria-label="Focus selected table"
            disabled={!selectedId}
            onClick={() => {
              manual.current = true;
              frame(false, selectedId);
            }}
          >
            <LocateFixed size={16} />
          </button>
        </Tooltip>
        <Tooltip content={"Fit all tables"}>
          <button
            aria-label="Fit schema diagram"
            onClick={() => {
              manual.current = true;
              frame(true);
            }}
          >
            <Focus size={16} />
          </button>
        </Tooltip>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <div className="graph-caption">
        Drag background to pan · Drag table cards to arrange · Ctrl/⌘ + scroll
        to zoom
      </div>
    </div>
  );
}
