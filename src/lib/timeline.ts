import type { ChangeEvent, DbValue } from "./types";
export function stateComparison(event: ChangeEvent, other?: ChangeEvent) {
  const before = other?.afterState ?? event.beforeState;
  const after = event.afterState;
  const beforeValues = new Map((before || []).map((f) => [f.column, f.value]));
  const afterValues = new Map((after || []).map((f) => [f.column, f.value]));
  const columns = [...new Set([...beforeValues.keys(), ...afterValues.keys()])];
  return columns.map((column) => ({
    column,
    before: beforeValues.get(column) ?? null,
    after: afterValues.get(column) ?? null,
  }));
}
export function equalValue(a: DbValue | null, b: DbValue | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Lifecycle messages have no row values; membership events have only one side. */
export function isDataEvent(event: ChangeEvent) {
  return (
    event.changes.length > 0 ||
    [
      "recordChanged",
      "recordAppeared",
      "recordDisappeared",
      "resultEntered",
      "resultLeft",
    ].includes(event.eventType)
  );
}
export function eventExplanation(event: ChangeEvent) {
  if (event.eventType === "baselineCaptured")
    return "The first observation is ready. Make a change while the watch is running; the next successful poll will compare it with this baseline.";
  if (!isDataEvent(event))
    return "This is a watch status event. It has no record values to compare. Start the watch, wait for its first observation, then change the data while it is running.";
  if (
    event.capture === "metadata" &&
    event.summary.includes("1 MiB capture limit")
  )
    return "This event exceeded the 1 MiB history limit, so only field names were saved. Exclude large columns in watch settings to capture values in future events.";
  if (event.capture === "metadata")
    return "This watch saved field names only. Edit the watch and enable Save record values on this device? to capture future changes. Previously omitted values cannot be recovered.";
  if (["resultEntered", "resultLeft"].includes(event.eventType))
    return "This row entered or left the query result. It may have changed, been inserted or deleted, or stopped matching the filter. For query watches, choose a row identity table and include its unique key columns to pair updates with their previous values.";
  if (event.eventType === "recordAppeared")
    return "The record was absent at the previous observation. Only its new state exists.";
  if (event.eventType === "recordDisappeared")
    return "The record was absent at this observation. Only its previous state exists.";
  return "Values are compared between consecutive successful observations. Excluded fields are not saved.";
}
export function missingStateLabel(
  event: ChangeEvent,
  side: "before" | "after",
) {
  if (side === "before" && event.eventType === "recordAppeared")
    return "Record absent";
  if (side === "after" && event.eventType === "recordDisappeared")
    return "Record absent";
  if (side === "before" && event.eventType === "resultEntered")
    return "Outside result";
  if (side === "after" && event.eventType === "resultLeft")
    return "Outside result";
  return "Not captured";
}
