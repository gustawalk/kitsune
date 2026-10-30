import type { DbValue, ResultSet } from "./types";

/** Full stored value; never the inspector's truncated preview. */
export function copyFieldText(value: DbValue): string {
  return value.kind === "null" ? "NULL" : String(value.value);
}

export function copyRecordJson(result: ResultSet): string {
  const row = result.rows[0];
  if (!row) throw new Error("This record no longer exists.");
  return JSON.stringify(
    Object.fromEntries(
      result.columns.map((name, i) => {
        const value = row[i];
        return [name, value.kind === "null" ? null : value.value];
      }),
    ),
    null,
    2,
  );
}

/** Complete records, with ordinary JSON values and lossless numeric strings. */
export function copyRowsJson(result: ResultSet, indices: number[]): string {
  const rows = [...new Set(indices)]
    .sort((a, b) => a - b)
    .map((index) => {
      const row = result.rows[index];
      if (!row) throw new Error("A selected row is no longer available.");
      return row.map((value) => (value.kind === "null" ? null : value.value));
    });
  if (!rows.length) throw new Error("Select at least one row to copy.");
  const uniqueColumns = new Set(result.columns).size === result.columns.length;
  const records = rows.map((values) =>
    Object.fromEntries(result.columns.map((column, i) => [column, values[i]])),
  );
  return JSON.stringify(
    uniqueColumns
      ? rows.length === 1
        ? records[0]
        : records
      : rows.length === 1
        ? { columns: result.columns, values: rows[0] }
        : { columns: result.columns, rows },
    null,
    2,
  );
}

export function jsonSelectionRows(
  rowCount: number,
  selectedRows: number[],
  cellRow: number,
  anchorRow: number,
): number[] {
  if (selectedRows.length)
    return [...new Set(selectedRows)]
      .filter((r) => Number.isInteger(r) && r >= 0 && r < rowCount)
      .sort((a, b) => a - b);
  const first = Math.max(0, Math.min(cellRow, anchorRow));
  const last = Math.min(rowCount - 1, Math.max(cellRow, anchorRow));
  return Array.from(
    { length: Math.max(0, last - first + 1) },
    (_, i) => first + i,
  );
}
