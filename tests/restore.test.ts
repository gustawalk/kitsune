import { expect, test } from "bun:test";
import { restoreBlockedReason } from "../src/components/RestoreEvent";
import type { ChangeEvent } from "../src/lib/types";
function event(): ChangeEvent {
  return {
    id: "e",
    watchId: "w",
    connectionId: "c",
    observedAt: "2026-01-01",
    eventType: "recordChanged",
    summary: "Changed",
    changes: [],
    record: {
      connectionId: "c",
      table: { schema: "", name: "orders", kind: "table" },
      key: { id: { kind: "integer", value: "1" } },
    },
    beforeState: [{ column: "status", value: { kind: "text", value: "old" } }],
    afterState: [{ column: "status", value: { kind: "text", value: "new" } }],
    capture: "full",
    restoreSource: {
      watchKind: "record",
      schemaFingerprint: "signature",
      complete: false,
    },
  };
}
test("partial field capture can be reviewed but membership and incomplete existence changes cannot", () => {
  expect(restoreBlockedReason(event())).toBeUndefined();
  expect(restoreBlockedReason({ ...event(), capture: "metadata" })).toContain(
    "not captured",
  );
  expect(restoreBlockedReason({ ...event(), restoreSource: null })).toContain(
    "verified source table",
  );
  expect(
    restoreBlockedReason({ ...event(), eventType: "resultLeft" }),
  ).toContain("membership");
  expect(
    restoreBlockedReason({ ...event(), eventType: "recordAppeared" }),
  ).toContain("complete");
  expect(
    restoreBlockedReason({
      ...event(),
      restoreSource: {
        watchKind: "query",
        schemaFingerprint: "signature",
        complete: false,
      },
    }),
  ).toBeUndefined();
  expect(
    restoreBlockedReason({
      ...event(),
      eventType: "resultEntered",
      restoreSource: {
        watchKind: "query",
        schemaFingerprint: "signature",
        complete: false,
      },
    }),
  ).toContain("membership");
});
