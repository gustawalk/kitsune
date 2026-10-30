import { expect, test } from "bun:test";
import {
  eventExplanation,
  isDataEvent,
  missingStateLabel,
  stateComparison,
} from "../src/lib/timeline";
import type { ChangeEvent } from "../src/lib/types";
const event: ChangeEvent = {
  id: "event",
  watchId: "watch",
  connectionId: "db",
  observedAt: "2026-10-29",
  eventType: "recordChanged",
  summary: "Updated",
  capture: "full",
  changes: [
    {
      column: "status",
      before: { kind: "text", value: "pending" },
      after: { kind: "text", value: "paid" },
    },
  ],
  beforeState: [
    { column: "status", value: { kind: "text", value: "pending" } },
    { column: "note", value: { kind: "null" } },
  ],
  afterState: [
    { column: "status", value: { kind: "text", value: "paid" } },
    { column: "note", value: { kind: "text", value: "" } },
  ],
  record: null,
  restoreSource: null,
};
test("timeline compares real before/after, preserving NULL and empty text", () => {
  expect(stateComparison(event)).toEqual([
    {
      column: "status",
      before: { kind: "text", value: "pending" },
      after: { kind: "text", value: "paid" },
    },
    {
      column: "note",
      before: { kind: "null" },
      after: { kind: "text", value: "" },
    },
  ]);
  expect(isDataEvent(event)).toBe(true);
  expect(
    stateComparison(event, {
      ...event,
      afterState: [
        { column: "status", value: { kind: "text", value: "older" } },
      ],
    })[0].before,
  ).toEqual({ kind: "text", value: "older" });
});
test("status events and metadata-only events explain why values are absent", () => {
  const status = {
    ...event,
    eventType: "watchStarted",
    changes: [],
    beforeState: null,
    afterState: null,
  };
  expect(isDataEvent(status)).toBe(false);
  expect(eventExplanation(status)).toContain("watch status");
  expect(eventExplanation({ ...event, capture: "metadata" })).toContain(
    "Previously omitted values cannot be recovered",
  );
});
test("membership and existence absence are distinct from values not captured", () => {
  for (const [type, side, label] of [
    ["recordAppeared", "before", "Record absent"],
    ["recordDisappeared", "after", "Record absent"],
    ["resultEntered", "before", "Outside result"],
    ["resultLeft", "after", "Outside result"],
  ] as const) {
    const e = { ...event, eventType: type, changes: [] };
    expect(isDataEvent(e)).toBe(true);
    expect(missingStateLabel(e, side)).toBe(label);
  }
  expect(eventExplanation({ ...event, eventType: "resultEntered" })).toContain(
    "row identity",
  );
  expect(missingStateLabel(event, "before")).toBe("Not captured");
});

test("oversized event downgrade explains the history size limit rather than blaming watch configuration", () => {
  expect(
    eventExplanation({
      ...event,
      capture: "metadata",
      summary: "Values omitted: event exceeded the 1 MiB capture limit.",
    }),
  ).toContain("Exclude large columns");
  expect(
    eventExplanation({ ...event, eventType: "baselineCaptured", changes: [] }),
  ).toContain("first observation is ready");
});
