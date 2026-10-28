import { useLayoutPreference } from "../lib/layout-preferences";
import { z } from "zod";
import { Tooltip } from "./ui/tooltip";
import {
  moveDiagramGesture,
  finishDiagramGesture,
  zoomDiagramAtPoint,
  type DiagramGesture,
} from "../lib/diagram-gesture";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Focus,
  GitBranch,
  KeyRound,
  LayoutGrid,
  LocateFixed,
  Minus,
  Network,
  Plus,
  RotateCcw,
  Table2,
  Undo2,
} from "lucide-react";
import type { SchemaGraph, SchemaNode } from "../lib/schema";
import { relatedSchemaNodeIds, schemaViewport, tableKey } from "../lib/schema";
import type { TableRef } from "../lib/types";
const SchemaNodeCard = memo(function SchemaNodeCard({
  node,
  selected,
  manual,
  onSelect,
}: {
  node: SchemaNode;
  selected: boolean;
  manual: React.MutableRefObject<boolean>;
  onSelect: (table: TableRef) => void;
}) {
  const inspect = (event: React.MouseEvent) => {
    if (event.detail === 0) {
      manual.current = true;
      onSelect(node.table);
    }
  };
  return (
    <section
      className={`schema-node ${selected ? "selected" : ""} ${node.external ? "external" : ""}`}
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
          content={`Click to inspect ${[node.table.schema, node.table.name].filter(Boolean).join(".")} · Drag to move · Right-click to filter`}
        >
          <button type="button" aria-pressed={selected} onClick={inspect}>
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
          <button onClick={inspect}>
            +{node.metadata.columns.length - 6} columns
          </button>
        ) : (
          <span>{node.metadata?.columns.length ?? "—"} columns</span>
        )}
      </footer>
    </section>
  );
});
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
  const [hiddenNodes, setHiddenNodes] = useState<Set<string>>(() => new Set());
  const [canUndo, setCanUndo] = useState(false);
  const history = useRef<
    {
      hidden: Set<string>;
      positions: Record<string, { x: number; y: number }>;
    }[]
  >([]);
  const dragSnapshot = useRef<{
    hidden: Set<string>;
    positions: Record<string, { x: number; y: number }>;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    left: number;
    top: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  const gesture = useRef<DiagramGesture | null>(null);
  function snapshot() {
    return { hidden: hiddenNodes, positions };
  }
  function pushHistory(previous = snapshot()) {
    history.current.push(previous);
    if (history.current.length > 100) history.current.shift();
    setCanUndo(true);
  }
  function undo() {
    if (gesture.current) return;
    const previous = history.current.pop();
    if (!previous) return;
    setHiddenNodes(previous.hidden);
    setPositions(previous.positions);
    setCanUndo(history.current.length > 0);
    manual.current = true;
    setContextMenu(null);
  }
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.key.toLowerCase() !== "z" ||
        !canvas.current ||
        canvas.current.closest("[hidden]") ||
        gesture.current
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], .cm-editor, [role='dialog']",
        )
      )
        return;
      event.preventDefault();
      undoRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (!contextMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".schema-context-menu"))
        setContextMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const focus = requestAnimationFrame(() =>
      contextMenuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus(),
    );
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => {
      cancelAnimationFrame(focus);
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [contextMenu]);
  const visibleGraphNodes = useMemo(
    () => graph.nodes.filter((node) => !hiddenNodes.has(node.id)),
    [graph.nodes, hiddenNodes],
  );
  const visibleGraphEdges = useMemo(
    () =>
      graph.edges.filter(
        (edge) => !hiddenNodes.has(edge.from) && !hiddenNodes.has(edge.to),
      ),
    [graph.edges, hiddenNodes],
  );
  const nodes = useMemo(
    () =>
      visibleGraphNodes.map((node) => {
        const position = positions[node.id];
        return position && (position.x !== node.x || position.y !== node.y)
          ? { ...node, ...position }
          : node;
      }),
    [visibleGraphNodes, positions],
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
  const selectedId =
    selected && visibleGraphNodes.some((node) => node.id === tableKey(selected))
      ? tableKey(selected)
      : undefined;
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
    dragSnapshot.current = node ? snapshot() : null;
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
      setPositions((previous) => ({ ...previous, [active.nodeId!]: next }));
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
    if (active.nodeId && active.moved && !cancelled && dragSnapshot.current)
      pushHistory(dragSnapshot.current);
    dragSnapshot.current = null;
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
      node.metadata?.columns.findIndex((item) => item.name === column) ?? -1;
    return {
      x: node.x + (right ? node.width : 0),
      y: node.y + (index >= 0 ? 49 + Math.min(index, 5) * 22 : 42),
    };
  }
  const edgeElements = useMemo(
    () =>
      visibleGraphEdges.map((edge) => {
        const from = nodeMap.get(edge.from),
          to = nodeMap.get(edge.to);
        if (!from || !to) return null;
        const self = from.id === to.id;
        const right = self || from.x <= to.x;
        const a = anchor(from, edge.foreignKey.columns[0], right);
        const b = anchor(to, edge.foreignKey.targetColumns[0], self || !right);
        const bend = self ? 75 : Math.max(60, Math.abs(b.x - a.x) * 0.45);
        const direction = right ? 1 : -1;
        const d = self
          ? `M${a.x},${a.y} C${a.x + bend},${a.y - 70} ${b.x + bend},${b.y + 75} ${b.x},${b.y + 12}`
          : `M${a.x},${a.y} C${a.x + direction * bend},${a.y} ${b.x - direction * bend},${b.y} ${b.x},${b.y}`;
        return (
          <g
            key={edge.id}
            className={
              selectedId && [edge.from, edge.to].includes(selectedId)
                ? "schema-edge emphasized"
                : "schema-edge"
            }
          >
            <title>
              {edge.foreignKey.name}: {edge.foreignKey.from.name} (
              {edge.foreignKey.columns.join(", ")}) → {edge.foreignKey.to.name}{" "}
              ({edge.foreignKey.targetColumns.join(", ")})
            </title>
            <path d={d} />
            <circle cx={a.x} cy={a.y} r="3" />
            <circle cx={b.x} cy={b.y + (self ? 12 : 0)} r="3" />
          </g>
        );
      }),
    [visibleGraphEdges, nodeMap, selectedId],
  );
  function openContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-schema-node]",
    );
    if (!target) {
      setContextMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      id: target.dataset.schemaNode!,
      left: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 258)),
      top: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 270)),
    });
  }
  function applyContextAction(
    action: "hide" | "hide-related" | "isolate" | "reveal" | "all",
  ) {
    const id = contextMenu?.id;
    if (!id) {
      if (action === "all" && hiddenNodes.size) {
        pushHistory();
        setHiddenNodes(new Set());
        // Keep the current pan/zoom; only the visible cards change.
        manual.current = true;
        setContextMenu(null);
      }
      return;
    }
    const related = relatedSchemaNodeIds(id, graph.edges);
    let next = hiddenNodes;
    if (action === "hide") next = new Set([...hiddenNodes, id]);
    else if (action === "isolate")
      next = new Set(
        graph.nodes
          .filter((node) => !related.has(node.id))
          .map((node) => node.id),
      );
    else if (action === "hide-related")
      next = new Set([
        ...hiddenNodes,
        ...[...related].filter((nodeId) => nodeId !== id),
      ]);
    else if (action === "reveal")
      next = new Set([...hiddenNodes].filter((nodeId) => !related.has(nodeId)));
    else next = new Set();
    const changed =
      next.size !== hiddenNodes.size ||
      [...next].some((nodeId) => !hiddenNodes.has(nodeId));
    if (changed) {
      pushHistory();
      setHiddenNodes(next);
    }
    // Filtering only adds/removes cards. Do not re-arrange or re-fit the view.
    manual.current = true;
    setContextMenu(null);
  }
  const contextNode = contextMenu
    ? graph.nodes.find((node) => node.id === contextMenu.id)
    : undefined;
  const contextRelated = contextMenu
    ? relatedSchemaNodeIds(contextMenu.id, graph.edges)
    : new Set<string>();
  const hiddenRelated = contextMenu
    ? [...contextRelated].filter(
        (nodeId) => nodeId !== contextMenu.id && hiddenNodes.has(nodeId),
      ).length
    : 0;
  return (
    <div
      className="schema-canvas"
      ref={canvas}
      onContextMenu={openContextMenu}
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
        event.preventDefault();
        setContextMenu(null);
        manual.current = true;
        if (event.ctrlKey || event.metaKey) {
          const rect = event.currentTarget.getBoundingClientRect();
          const cursor = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          };
          const next = zoomDiagramAtPoint(zoom, pan, cursor, event.deltaY);
          setZoom(next.zoom);
          setPan(next.pan);
        } else
          setPan((p) => ({ x: p.x - event.deltaX, y: p.y - event.deltaY }));
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
        {visibleGraphNodes.filter((n) => !n.external).length}
        {hiddenNodes.size
          ? ` / ${graph.nodes.filter((n) => !n.external).length}`
          : ""}{" "}
        tables/views · {visibleGraphEdges.length}
        {hiddenNodes.size ? ` / ${graph.edges.length}` : ""} relationships
      </div>
      {hiddenNodes.size > 0 && (
        <button
          className="schema-control-button schema-filter-reset"
          onClick={() => applyContextAction("all")}
        >
          <Eye size={12} />
          Show all tables · {hiddenNodes.size} hidden
        </button>
      )}
      <svg
        className="schema-edges schema-edge-viewport"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {edgeElements}
        </g>
      </svg>
      <div
        className="graph-transform"
        style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}
      >
        {nodes.map((node) => (
          <SchemaNodeCard
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            manual={manual}
            onSelect={onSelect}
          />
        ))}
      </div>
      {contextMenu && (
        <div
          className="schema-context-menu"
          ref={contextMenuRef}
          role="menu"
          aria-label="Table filters"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header>
            <small>Table filters</small>
            <strong
              title={
                contextNode
                  ? [contextNode.table.schema, contextNode.table.name]
                      .filter(Boolean)
                      .join(".")
                  : undefined
              }
            >
              {contextNode
                ? [contextNode.table.schema, contextNode.table.name]
                    .filter(Boolean)
                    .join(".")
                : "Table"}
            </strong>
          </header>
          <button role="menuitem" onClick={() => applyContextAction("hide")}>
            <EyeOff size={13} />
            Hide table
          </button>
          <button role="menuitem" onClick={() => applyContextAction("isolate")}>
            <Network size={13} />
            Show only this table + relations
            <span>{Math.max(0, contextRelated.size - 1)}</span>
          </button>
          <button
            role="menuitem"
            disabled={!hiddenRelated}
            onClick={() => applyContextAction("reveal")}
          >
            <Eye size={13} />
            Reveal related tables
            <span>{hiddenRelated || ""}</span>
          </button>
          <button
            role="menuitem"
            disabled={contextRelated.size <= 1}
            onClick={() => applyContextAction("hide-related")}
          >
            <GitBranch size={13} />
            Hide related tables
          </button>
          <hr />
          <button
            role="menuitem"
            disabled={!hiddenNodes.size}
            onClick={() => applyContextAction("all")}
          >
            <RotateCcw size={13} />
            Show all tables
            <span>{hiddenNodes.size || ""}</span>
          </button>
        </div>
      )}
      <div className="graph-controls">
        <Tooltip
          content={
            canUndo ? "Undo last canvas change (Ctrl/⌘ Z)" : "Nothing to undo"
          }
        >
          <button
            aria-label="Undo last canvas change"
            disabled={!canUndo}
            onClick={undo}
          >
            <Undo2 size={16} />
          </button>
        </Tooltip>
        <Tooltip content={"Arrange related tables"}>
          <button
            aria-label="Arrange related tables"
            onClick={() => {
              if (Object.keys(positions).length) pushHistory();
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
        Right-click a table to filter · Drag background to pan · Ctrl/⌘ + scroll
        to zoom · Ctrl/⌘ Z to undo
      </div>
    </div>
  );
}
