import type { ChangeEvent, DbValue } from "./types";
export function stateComparison(event: ChangeEvent, other?: ChangeEvent) {
  const before = other?.afterState ?? event.beforeState;
  const after = event.afterState;
  const columns = [
    ...new Set([
      ...(before || []).map((f) => f.column),
      ...(after || []).map((f) => f.column),
    ]),
  ];
  return columns.map((column) => ({
    column,
    before: before?.find((f) => f.column === column)?.value ?? null,
    after: after?.find((f) => f.column === column)?.value ?? null,
  }));
}
export function equalValue(a: DbValue | null, b: DbValue | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}
