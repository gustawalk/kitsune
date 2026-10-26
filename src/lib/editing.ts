import type { DbValue } from "./types";
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
