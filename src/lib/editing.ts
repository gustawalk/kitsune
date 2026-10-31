import {
  display,
  identity,
  rowKey,
  type DbValue,
  type RecordRef,
  type Metadata,
  type ResultSet,
} from "./types";
export function editedValue(
  kind: DbValue["kind"],
  text: string,
  isNull: boolean,
): DbValue {
  if (isNull) return { kind: "null" };
  if (kind === "boolean") {
    if (text !== "true" && text !== "false")
      throw new Error("Enter true or false.");
    return { kind, value: text === "true" };
  }
  if (kind === "integer" && !/^[+-]?\d+$/.test(text))
    throw new Error("Enter a whole number.");
  if (
    (kind === "decimal" || kind === "float") &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
  )
    throw new Error("Enter a valid number.");
  if (kind === "float" && !Number.isFinite(Number(text)))
    throw new Error("This number exceeds the supported floating-point range.");
  if (kind === "json") JSON.parse(text);
  if (kind === "binary" || kind === "array" || kind === "unknown")
    throw new Error("Use the SQL editor for this value type.");
  return { kind: kind === "null" ? "text" : kind, value: text };
}

export function valueKindForColumn(type: string): DbValue["kind"] {
  const normalized = type.toLowerCase();
  if (/blob|bytea/.test(normalized)) return "binary";
  if (/\[\]/.test(normalized)) return "array";
  if (/bool/.test(normalized)) return "boolean";
  if (/int|serial/.test(normalized)) return "integer";
  if (/numeric|decimal/.test(normalized)) return "decimal";
  if (/real|float|double/.test(normalized)) return "float";
  if (/json/.test(normalized)) return "json";
  return "text";
}
export function toggleRowSelection(
  indices: number[],
  index: number,
  checked: boolean,
): number[] {
  return checked
    ? [...new Set([...indices, index])].sort((a, b) => a - b)
    : indices.filter((i) => i !== index);
}

export interface FieldDraft {
  text: string;
  kind: DbValue["kind"];
  isNull: boolean;
}

export function recordChanges<T extends { column: string; before: DbValue }>(
  fields: T[],
  drafts: Record<string, FieldDraft>,
): T[] {
  return fields.filter((f) => {
    const d = drafts[f.column];
    return (
      d &&
      (d.isNull
        ? f.before.kind !== "null"
        : f.before.kind === "null" ||
          d.text !== display(f.before) ||
          d.kind !== f.before.kind)
    );
  });
}

export interface CellChange {
  column: string;
  before: DbValue;
  value: DbValue;
}
export interface PendingRow {
  record: RecordRef;
  changes: CellChange[];
}
const sameValue = (a: DbValue, b: DbValue) =>
  a.kind === b.kind &&
  (a.kind === "null" || (b.kind !== "null" && a.value === b.value));
export function stageRowChanges(
  pending: PendingRow[],
  record: RecordRef,
  changes: CellChange[],
): PendingRow[] {
  const id = identity(record);
  const previous = pending.find((row) => identity(row.record) === id);
  const merged = new Map(
    (previous?.changes || []).map((change) => [change.column, change]),
  );
  for (const change of changes) {
    const before = merged.get(change.column)?.before || change.before;
    if (sameValue(before, change.value)) merged.delete(change.column);
    else merged.set(change.column, { ...change, before });
  }
  const next = pending.filter((row) => identity(row.record) !== id);
  if (merged.size) next.push({ record, changes: [...merged.values()] });
  if (next.reduce((total, row) => total + row.changes.length, 0) > 500)
    throw new Error(
      "Apply or discard the current 500 changes before editing more cells.",
    );
  return next;
}
export function pendingResult(
  result: ResultSet | undefined,
  metadata: Metadata | undefined,
  connectionId: string,
  pending: PendingRow[],
): { result: ResultSet | undefined; cells: Set<string> } {
  const cells = new Set<string>();
  if (!result || !metadata || !pending.length) return { result, cells };
  const byId = new Map(
    pending.map((row) => [
      identity(row.record),
      new Map(row.changes.map((change) => [change.column, change.value])),
    ]),
  );
  const rows = result.rows.map((row, index) => {
    const changes = byId.get(
      identity({
        connectionId,
        table: metadata.table,
        key: rowKey(metadata, result.columns, row),
      }),
    );
    if (!changes) return row;
    return row.map((value, column) => {
      const name = result.columns[column];
      if (!changes.has(name)) return value;
      cells.add(`${index}:${name}`);
      return changes.get(name)!;
    });
  });
  return { result: { ...result, rows }, cells };
}
