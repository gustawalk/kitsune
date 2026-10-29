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
