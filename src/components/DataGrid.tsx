import { copyRowsJson, jsonSelectionRows } from "../lib/record-copy";
import { startResize } from "../lib/resize";
import type { ReferenceLabels } from "../lib/reference-values";
import { ContextMenu } from "radix-ui";
import {
  columnPreferenceKeys,
  gridLayoutSchema,
  reconciledColumns,
  useLayoutPreference,
} from "../lib/layout-preferences";
import { Tooltip } from "./ui/tooltip";
import { Checkbox } from "./ui/checkbox";
import { toggleRowSelection } from "../lib/editing";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  Columns3,
  Link2,
  Copy,
  Search,
  Pencil,
  X,
} from "lucide-react";
import {
  display,
  type DbValue,
  type ForeignKey,
  type ResultSet,
} from "../lib/types";
import { copyFeedback, Empty } from "./shared";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
interface Props {
  result: ResultSet;
  busy?: boolean;
  resetScrollKey?: string;
  preferenceKey?: string;
  onVisibleColumns?: (columns: string[]) => void;
  onInvestigate?: (row: DbValue[]) => void;
  onWatch?: (row: DbValue[]) => void;
  onDeleteRows?: (indices: number[]) => void;
  density?: "compact" | "comfortable";
  selectedRows?: number[];
  onSelectionChange?: (indices: number[]) => void;
  onEdit?: (row: DbValue[], column: string, value: DbValue) => void;
  onRow?: (row: DbValue[]) => void;
  foreignKeys?: ForeignKey[];
  referenceLabels?: ReferenceLabels;
  referenceForeignKeys?: ReadonlyMap<string, ForeignKey>;
  onReferenceDisplay?: (column: string) => void;
  onForeignKey?: (key: ForeignKey, row: DbValue[]) => void;
  selected?: number;
  onSort?: (column: string) => void;
  sort?: string;
  descending?: boolean;
  actions?: React.ReactNode;
}
const emptyRowSelection: number[] = [];
export function DataGrid({
  result,
  busy = false,
  resetScrollKey,
  preferenceKey,
  onVisibleColumns,
  onInvestigate,
  onWatch,
  onDeleteRows,
  density = "compact",
  selectedRows = emptyRowSelection,
  onSelectionChange,
  onRow,
  foreignKeys,
  referenceLabels,
  referenceForeignKeys,
  onReferenceDisplay,
  onForeignKey,
  onEdit,
  selected,
  onSort,
  sort,
  descending,
  actions,
}: Props) {
  const [layout, setLayout] = useLayoutPreference(
    preferenceKey,
    gridLayoutSchema,
    { hidden: [], order: [], widths: {} },
  );
  const columnKeys = useMemo(
    () => columnPreferenceKeys(result.columns),
    [result.columns],
  );
  const { hidden, order, widths } = useMemo(
    () => ({
      hidden: layout.hidden
        .map((name) => columnKeys.indexOf(name))
        .filter((i) => i >= 0),
      order: reconciledColumns(columnKeys, layout).map((name) =>
        columnKeys.indexOf(name),
      ),
      widths: Object.fromEntries(
        columnKeys.map((name, i) => [i, layout.widths[name] ?? 180]),
      ) as Record<number, number>,
    }),
    [layout, columnKeys],
  );
  const setHidden = (change: (old: number[]) => number[]) =>
    setLayout((l) => ({
      ...l,
      hidden: change(hidden).map((i) => columnKeys[i]),
    }));
  const setOrder = (next: number[]) =>
    setLayout((l) => ({ ...l, order: next.map((i) => columnKeys[i]) }));
  const setWidths = (
    change: (old: Record<number, number>) => Record<number, number>,
  ) =>
    setLayout((l) => ({
      ...l,
      widths: Object.fromEntries(
        Object.entries(change(widths)).map(([i, width]) => [
          columnKeys[Number(i)],
          width,
        ]),
      ),
    }));
  const lastSelected = useRef(0);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [viewport, setViewport] = useState({ left: 0, width: 900 });
  const [cell, setCell] = useState<[number, number]>([0, 0]);
  const [anchor, setAnchor] = useState<[number, number]>([0, 0]);
  const [viewer, setViewer] = useState<{
    column: string;
    value: DbValue;
  } | null>(null);
  const [contextCell, setContextCell] = useState<[number, number]>([0, 0]);
  const [viewerSearch, setViewerSearch] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const dragged = useRef<number>(-1);
  const signature = result.columns.join("\u0001");
  useEffect(() => {
    setCell([0, 0]);
    setAnchor([0, 0]);
  }, [signature]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setViewport({ left: el.scrollLeft, width: el.clientWidth });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (container.current) container.current.scrollTop = 0;
    setScroll(0);
    setCell([0, 0]);
    setAnchor([0, 0]);
  }, [resetScrollKey]);
  const cols = useMemo(
    () =>
      (order.length === result.columns.length
        ? order
        : result.columns.map((_, i) => i)
      ).filter((i) => !hidden.includes(i)),
    [order, result.columns, hidden],
  );
  const visibleSignature = cols.map((i) => result.columns[i]).join("\u0001");
  useEffect(() => {
    onVisibleColumns?.(cols.map((i) => result.columns[i]));
  }, [visibleSignature, onVisibleColumns]);
  useEffect(() => {
    setCell(([row, col]) => [row, Math.max(0, Math.min(col, cols.length - 1))]);
    setAnchor(([row, col]) => [
      row,
      Math.max(0, Math.min(col, cols.length - 1)),
    ]);
  }, [visibleSignature]);
  const rowHeight = density === "comfortable" ? 40 : 32;
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 8);
  const end = Math.min(
    result.rows.length,
    start + Math.ceil(height / rowHeight) + 16,
  );
  const rowNumberWidth = onSelectionChange ? 70 : 44;
  const columnLayout = useMemo(() => {
    let left = rowNumberWidth;
    return cols.map((index, position) => {
      const width = widths[index] || 180;
      const column = { index, position, left, width };
      left += width;
      return column;
    });
  }, [cols, widths, rowNumberWidth]);
  const renderedColumns = columnLayout.filter(
    (column) =>
      column.left + column.width >= viewport.left - 360 &&
      column.left <= viewport.left + viewport.width + 360,
  );
  const template = `${rowNumberWidth}px ${cols.map((i) => `${widths[i] || 180}px`).join(" ")}`;
  const totalWidth =
    rowNumberWidth + cols.reduce((n, i) => n + (widths[i] || 180), 0);
  function resize(index: number, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const x = event.clientX;
    const initial = widths[index] || 180;
    const move = (e: PointerEvent) =>
      setWidths((w) => ({
        ...w,
        [index]: Math.max(80, Math.min(900, initial + e.clientX - x)),
      }));
    startResize(event, move);
  }
  const jsonRows = useMemo(
    () =>
      jsonSelectionRows(result.rows.length, selectedRows, cell[0], anchor[0]),
    [result.rows.length, selectedRows, cell[0], anchor[0]],
  );
  function copySelection() {
    const minRow = Math.min(cell[0], anchor[0]),
      maxRow = Math.max(cell[0], anchor[0]);
    const minCol = Math.min(cell[1], anchor[1]),
      maxCol = Math.max(cell[1], anchor[1]);
    void copyFeedback(
      result.rows
        .slice(minRow, maxRow + 1)
        .map((row) =>
          cols
            .slice(minCol, maxCol + 1)
            .map((i) => display(row[i]))
            .join("\t"),
        )
        .join("\n"),
    );
  }
  function navigate(e: React.KeyboardEvent) {
    if (busy || !cols.length) return;
    if (
      (e.target as HTMLElement).closest(
        'input,textarea,[role="checkbox"],[role="menu"]',
      )
    )
      return;
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      const target = container.current?.querySelector<HTMLElement>(
        `[data-grid-cell="${cell[0]}:${cell[1]}"]`,
      );
      if (target) {
        e.preventDefault();
        const bounds = target.getBoundingClientRect();
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: bounds.left + Math.min(bounds.width / 2, 80),
            clientY: bounds.top + bounds.height / 2,
          }),
        );
      }
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "a" &&
      onSelectionChange
    ) {
      e.preventDefault();
      if (result.rows.length <= 500)
        onSelectionChange(result.rows.map((_, i) => i));
      return;
    }
    if (e.key === " " && onSelectionChange) {
      e.preventDefault();
      onSelectionChange(
        toggleRowSelection(
          selectedRows,
          cell[0],
          !selectedRows.includes(cell[0]),
        ),
      );
      return;
    }
    if (e.key === "Delete" && onDeleteRows) {
      e.preventDefault();
      onDeleteRows(selectedRows.length ? selectedRows : [cell[0]]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      const next: [number, number] = [
        Math.max(0, Math.min(result.rows.length - 1, cell[0] + dr)),
        Math.max(0, Math.min(cols.length - 1, cell[1] + dc)),
      ];
      setCell(next);
      if (!e.shiftKey) setAnchor(next);
      onRow?.(result.rows[next[0]]);
      const el = container.current;
      if (el) {
        const column = columnLayout[next[1]];
        if (column) {
          if (column.left < el.scrollLeft + rowNumberWidth)
            el.scrollLeft = column.left - rowNumberWidth;
          else if (column.left + column.width > el.scrollLeft + el.clientWidth)
            el.scrollLeft = column.left + column.width - el.clientWidth;
        }
        const top = next[0] * rowHeight;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + rowHeight > el.scrollTop + el.clientHeight - 32)
          el.scrollTop = top - el.clientHeight + 64;
      }
    }
    if (e.key === "F2" && onEdit && result.rows[cell[0]]) {
      e.preventDefault();
      onEdit(
        result.rows[cell[0]],
        result.columns[cols[cell[1]]],
        result.rows[cell[0]][cols[cell[1]]],
      );
    }
    if (e.key === "Enter" && result.rows[cell[0]])
      setViewer({
        column: result.columns[cols[cell[1]]],
        value: result.rows[cell[0]][cols[cell[1]]],
      });
  }
  const valueText = viewer ? display(viewer.value) : "";
  let pretty = valueText;
  if (viewer && viewer.value.kind !== "binary") {
    try {
      pretty = JSON.stringify(JSON.parse(valueText) as unknown, null, 2);
    } catch {
      /* Text values remain text. */
    }
  }
  function renderContextMenu() {
    const [r, col] = contextCell;
    const row = result.rows[r];
    if (!row) return null;
    const v = row[col];
    return (
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="app-context-menu"
          collisionPadding={10}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            container.current?.focus({ preventScroll: true });
          }}
        >
          <ContextMenu.Label>{result.columns[col]}</ContextMenu.Label>
          <ContextMenu.Item onSelect={() => void copyFeedback(display(v))}>
            Copy value
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() =>
              void copyFeedback(
                copyRowsJson(
                  result,
                  selectedRows.length && !selectedRows.includes(r)
                    ? [r]
                    : jsonRows,
                ),
              )
            }
          >
            {(selectedRows.length && !selectedRows.includes(r)) ||
            jsonRows.length === 1
              ? "Copy row as JSON"
              : `Copy ${jsonRows.length} rows as JSON`}
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() =>
              setViewer({
                column: result.columns[col],
                value: v,
              })
            }
          >
            Inspect full value
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!onEdit}
            onSelect={() => onEdit?.(row, result.columns[col], v)}
          >
            Edit value <kbd>F2</kbd>
          </ContextMenu.Item>
          {onInvestigate && (
            <ContextMenu.Item onSelect={() => onInvestigate(row)}>
              Investigate record
            </ContextMenu.Item>
          )}
          {onWatch && (
            <ContextMenu.Item onSelect={() => onWatch(row)}>
              Watch record
            </ContextMenu.Item>
          )}
          {onSelectionChange && (
            <ContextMenu.Item
              onSelect={() =>
                onSelectionChange(
                  toggleRowSelection(
                    selectedRows,
                    r,
                    !selectedRows.includes(r),
                  ),
                )
              }
            >
              {selectedRows.includes(r) ? "Deselect" : "Select"} row
            </ContextMenu.Item>
          )}
          {onDeleteRows && (
            <>
              <ContextMenu.Separator />
              <ContextMenu.Item
                className="danger-text"
                onSelect={() =>
                  onDeleteRows(selectedRows.includes(r) ? selectedRows : [r])
                }
              >
                Delete {selectedRows.includes(r) ? selectedRows.length : 1}{" "}
                selected row(s)…
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    );
  }
  return (
    <ContextMenu.Root>
      <div className="grid-component" aria-busy={busy}>
        <div className="grid-tools" inert={busy}>
          <span className="muted">
            {result.rows.length.toLocaleString()} rows
            {result.truncated && " · more available"}
          </span>
          <div className="spacer" />
          {actions}
          {onEdit && (
            <Button
              variant="secondary"
              size="sm"
              title="Edit selected cell (F2)"
              disabled={!cols.length || !result.rows[cell[0]]}
              onClick={() =>
                onEdit(
                  result.rows[cell[0]],
                  result.columns[cols[cell[1]]],
                  result.rows[cell[0]][cols[cell[1]]],
                )
              }
            >
              <Pencil size={13} />
              Edit value
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!cols.length || !result.rows.length}
            title="Copy selected cells (Ctrl/Cmd+C)"
            onClick={copySelection}
          >
            <Copy size={13} />
            Copy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!jsonRows.length}
            title={
              jsonRows.length > 1
                ? `Copy ${jsonRows.length} selected rows as a JSON array, including all columns`
                : "Copy the complete row as JSON, including all columns"
            }
            onClick={() => void copyFeedback(copyRowsJson(result, jsonRows))}
          >
            <Braces size={13} />
            {jsonRows.length > 1
              ? `Rows JSON (${jsonRows.length})`
              : "Row JSON"}
          </Button>
          <details className="column-menu">
            <summary>
              <Columns3 size={14} />
              Columns
            </summary>
            <div>
              <div className="column-menu-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!hidden.length}
                  onClick={() => setHidden(() => [])}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={hidden.length === result.columns.length}
                  onClick={() =>
                    setHidden(() => result.columns.map((_, i) => i))
                  }
                >
                  Unselect all
                </Button>
              </div>
              {result.columns.map((name, i) => (
                <label key={`${name}-${i}`}>
                  <Checkbox
                    checked={!hidden.includes(i)}
                    onCheckedChange={(checked) =>
                      setHidden((v) =>
                        checked ? v.filter((n) => n !== i) : [...v, i],
                      )
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </details>
        </div>
        {!result.columns.length ? (
          <Empty
            icon={<Check size={24} />}
            title="Statement completed"
            detail={`${result.affected.toLocaleString()} affected rows · ${result.durationMs} ms`}
          />
        ) : (
          <div
            className="data-grid"
            ref={container}
            tabIndex={0}
            role="grid"
            aria-rowcount={result.rows.length + 1}
            aria-colcount={cols.length}
            aria-label="Database results"
            aria-multiselectable={onSelectionChange ? true : undefined}
            onKeyDown={navigate}
            inert={busy}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScroll(Math.floor(el.scrollTop / rowHeight) * rowHeight);
              setViewport((old) =>
                old.left === el.scrollLeft && old.width === el.clientWidth
                  ? old
                  : { left: el.scrollLeft, width: el.clientWidth },
              );
            }}
          >
            <div
              className="grid-header"
              role="row"
              style={{ gridTemplateColumns: template, width: totalWidth }}
            >
              <div className="row-number">
                {onSelectionChange ? (
                  <Checkbox
                    aria-label="Select all rows on this page"
                    title={
                      result.rows.length > 500
                        ? "Choose a page size of 500 or fewer to select all"
                        : "Select all rows on this page"
                    }
                    disabled={!result.rows.length || result.rows.length > 500}
                    checked={
                      !!result.rows.length &&
                      selectedRows.length === result.rows.length
                    }
                    indeterminate={
                      selectedRows.length > 0 &&
                      selectedRows.length < result.rows.length
                    }
                    onCheckedChange={(checked) =>
                      onSelectionChange(
                        checked ? result.rows.map((_, i) => i) : [],
                      )
                    }
                  />
                ) : (
                  "#"
                )}
              </div>
              {renderedColumns.map(({ index: i, position }) => (
                <div
                  style={{ gridColumn: position + 2 }}
                  role="columnheader"
                  className="grid-heading"
                  key={i}
                  draggable
                  onDragStart={() => {
                    dragged.current = i;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const next = [...order];
                    const from = next.indexOf(dragged.current),
                      to = next.indexOf(i);
                    if (from >= 0 && to >= 0) {
                      next.splice(from, 1);
                      next.splice(to, 0, dragged.current);
                      setOrder(next);
                    }
                  }}
                >
                  <Tooltip content={onSort ? "Sort column" : result.types[i]}>
                    <button onClick={() => onSort?.(result.columns[i])}>
                      <span className="type-marker">
                        {typeAbbreviation(result.types[i])}
                      </span>
                      <span>{result.columns[i]}</span>
                      {sort === result.columns[i] &&
                        (descending ? (
                          <ArrowDown size={12} />
                        ) : (
                          <ArrowUp size={12} />
                        ))}
                    </button>
                  </Tooltip>
                  {onReferenceDisplay &&
                    foreignKeys?.some((fk) =>
                      fk.columns.includes(result.columns[i]),
                    ) && (
                      <button
                        type="button"
                        className={`reference-display-button ${referenceForeignKeys?.has(result.columns[i]) ? "active" : ""}`}
                        aria-label={`Display referenced value for ${result.columns[i]}`}
                        title="Display referenced value"
                        onClick={() => onReferenceDisplay(result.columns[i])}
                      >
                        <Link2 size={12} />
                      </button>
                    )}
                  <span
                    className="column-resize"
                    onPointerDown={(e) => resize(i, e)}
                  />
                </div>
              ))}
            </div>
            <div
              style={{
                height: cols.length ? result.rows.length * rowHeight : 0,
                width: totalWidth,
                position: "relative",
              }}
            >
              {result.rows
                .slice(start, cols.length ? end : start)
                .map((row, n) => {
                  const r = start + n;
                  return (
                    <div
                      role="row"
                      aria-rowindex={r + 2}
                      key={r}
                      className={`grid-row ${selected === r || selectedRows.includes(r) ? "selected-row" : ""}`}
                      style={{
                        gridTemplateColumns: template,
                        height: rowHeight,
                        position: "absolute",
                        top: r * rowHeight,
                        width: totalWidth,
                      }}
                    >
                      <div className="row-number">
                        {onSelectionChange && (
                          <Checkbox
                            aria-label={`Select row ${r + 1}`}
                            onClickCapture={(e) => {
                              if (e.shiftKey) {
                                e.preventDefault();
                                e.stopPropagation();
                                const from = Math.min(lastSelected.current, r),
                                  to = Math.max(lastSelected.current, r);
                                const next = Array.from(
                                  { length: to - from + 1 },
                                  (_, i) => from + i,
                                );
                                if (next.length <= 500)
                                  onSelectionChange?.(next);
                              } else lastSelected.current = r;
                            }}
                            checked={selectedRows.includes(r)}
                            disabled={
                              selectedRows.length >= 500 &&
                              !selectedRows.includes(r)
                            }
                            onCheckedChange={(checked) =>
                              onSelectionChange(
                                toggleRowSelection(selectedRows, r, checked),
                              )
                            }
                          />
                        )}
                        <span>{r + 1}</span>
                      </div>
                      {renderedColumns.map(({ index: col, position: c }) => {
                        const v = row[col];
                        const referenceLabel = referenceLabels?.get(
                          result.columns[col],
                        )?.[r];
                        const active =
                          r >= Math.min(cell[0], anchor[0]) &&
                          r <= Math.max(cell[0], anchor[0]) &&
                          c >= Math.min(cell[1], anchor[1]) &&
                          c <= Math.max(cell[1], anchor[1]);
                        return (
                          <ContextMenu.Trigger key={col} asChild>
                            <div
                              title={
                                onEdit
                                  ? "Double-click to edit · Enter to inspect"
                                  : "Double-click to inspect full value"
                              }
                              data-app-context-menu
                              data-grid-cell={`${r}:${c}`}
                              tabIndex={-1}
                              onContextMenu={() => {
                                setContextCell([r, col]);
                                if (!(
                                  r >= Math.min(cell[0], anchor[0]) &&
                                  r <= Math.max(cell[0], anchor[0]) &&
                                  c >= Math.min(cell[1], anchor[1]) &&
                                  c <= Math.max(cell[1], anchor[1])
                                )) {
                                  setCell([r, c]);
                                  setAnchor([r, c]);
                                }
                                onRow?.(row);
                              }}
                              style={{ gridColumn: c + 2 }}
                              role="gridcell"
                              aria-selected={active}
                              key={col}
                              className={`grid-cell ${v.kind === "null" ? "null" : ""} ${["integer", "decimal", "float"].includes(v.kind) ? "numeric" : ""} ${active ? "active-cell" : ""}`}
                              onClick={(e) => {
                                setCell([r, c]);
                                if (!e.shiftKey) setAnchor([r, c]);
                                onRow?.(row);
                              }}
                              onDoubleClick={() =>
                                onEdit
                                  ? onEdit(row, result.columns[col], v)
                                  : setViewer({
                                      column: result.columns[col],
                                      value: v,
                                    })
                              }
                            >
                              {foreignKeys?.some((fk) =>
                                fk.columns.includes(result.columns[col]),
                              ) && onForeignKey ? (
                                <button
                                  type="button"
                                  className="foreign-key-value"
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === "Enter" ||
                                      event.key === " "
                                    )
                                      event.stopPropagation();
                                  }}
                                  disabled={v.kind === "null"}
                                  title={
                                    referenceLabel !== undefined
                                      ? `${referenceLabel} · ${display(v)} · Open referenced record`
                                      : "Open the referenced record"
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    const key =
                                      referenceForeignKeys?.get(
                                        result.columns[col],
                                      ) ??
                                      foreignKeys.find((fk) =>
                                        fk.columns.includes(
                                          result.columns[col],
                                        ),
                                      );
                                    if (
                                      key &&
                                      key.columns.every((name) => {
                                        const index =
                                          result.columns.indexOf(name);
                                        return (
                                          index >= 0 &&
                                          row[index]?.kind !== "null"
                                        );
                                      })
                                    )
                                      onForeignKey(key, row);
                                  }}
                                >
                                  {(referenceLabel ?? display(v)).slice(0, 240)}
                                </button>
                              ) : (
                                display(v).slice(0, 240)
                              )}
                            </div>
                          </ContextMenu.Trigger>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
            {!cols.length && (
              <div className="grid-empty">
                All columns are hidden. Use Columns to show them.
              </div>
            )}
            {!!cols.length && !result.rows.length && (
              <div className="grid-empty">No rows match this query.</div>
            )}
          </div>
        )}
        {viewer && (
          <Dialog
            open
            wide
            onClose={() => {
              setViewer(null);
              setViewerSearch("");
            }}
            title={viewer.column}
            description={`${viewer.value.kind} · ${valueText.length.toLocaleString()} characters`}
          >
            <div className="value-tools">
              <Search size={14} />
              <input
                placeholder="Find in value…"
                value={viewerSearch}
                onChange={(e) => setViewerSearch(e.target.value)}
              />
              {viewerSearch && (
                <span className="muted">
                  {pretty.includes(viewerSearch) ? "Match found" : "No match"}
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void copyFeedback(
                    viewer.value.kind === "binary"
                      ? viewer.value.value
                      : pretty,
                  )
                }
              >
                <Copy size={13} />
                Copy{viewer.value.kind === "binary" && " base64"}
              </Button>
            </div>
            <pre className="value-viewer">{pretty}</pre>
            <footer>
              <Button variant="ghost" onClick={() => setViewer(null)}>
                <X size={14} />
                Close
              </Button>
            </footer>
          </Dialog>
        )}
      </div>
      {renderContextMenu()}
    </ContextMenu.Root>
  );
}
function typeAbbreviation(type = "") {
  const s = type.toLowerCase();
  if (/int|numeric|decimal|float|real/.test(s)) return "#";
  if (/json|array/.test(s)) return "{}";
  if (/date|time/.test(s)) return "◷";
  if (/blob|bytea/.test(s)) return "01";
  return "Aa";
}
