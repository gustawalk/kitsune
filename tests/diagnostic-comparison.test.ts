import { expect, test } from "bun:test";
import {
  compareDiagnostics,
  planSummary,
  rememberDiagnostic,
  diagnosticRuns,
  type DiagnosticRun,
} from "../src/lib/diagnostic-comparison";
function run(
  id: string,
  cost: number,
  ms: number,
  complete = true,
): DiagnosticRun {
  return {
    id,
    connectionId: "comparison-test",
    sql: "select 1",
    context: '["select 1",[]]',
    at: "2026-01-01",
    result: {
      engine: "postgres",
      mode: "measure",
      plan: {
        columns: [],
        types: [],
        rows: [],
        durationMs: 0,
        affected: 0,
        truncated: false,
      },
      structuredPlan: [
        {
          Plan: {
            "Node Type": "Seq Scan",
            "Total Cost": cost,
            Plans: [{ "Node Type": "Result" }],
          },
        },
      ],
      elapsedMs: ms,
      measurementMs: ms,
      rowsConsumed: 1,
      complete,
      costUnit: "planner units",
    },
  };
}
test("diagnostics compare measured duration, planner cost and plan nodes", () => {
  const comparison = compareDiagnostics(run("a", 10, 20), run("b", 4, 8));
  expect(comparison).toMatchObject({
    sameContext: true,
    complete: true,
    elapsedDelta: -12,
    costDelta: -6,
  });
  expect(comparison.nodes).toContainEqual({
    kind: "Seq Scan",
    before: 1,
    after: 1,
  });
  const partial = run("c", 1, 1, false);
  partial.context = "different parameters";
  expect(compareDiagnostics(run("a", 10, 20), partial)).toMatchObject({
    sameContext: false,
    complete: false,
  });
});
test("diagnostic retention is bounded and isolated by connection", () => {
  for (let i = 0; i < 12; i++) rememberDiagnostic(run(String(i), i, i));
  expect(diagnosticRuns("comparison-test")).toHaveLength(10);
  expect(diagnosticRuns("other")).toEqual([]);
  const huge = run("huge", 1, 1);
  huge.sql = "x".repeat(2 * 1024 * 1024);
  rememberDiagnostic(huge);
  expect(diagnosticRuns("comparison-test").some((r) => r.id === "huge")).toBe(
    false,
  );
});
test("malformed and prototype-like plan names do not corrupt counters", () => {
  expect(planSummary(null).estimatedCost).toBeNull();
  expect(
    planSummary([
      { Plan: { "Node Type": "__proto__", "Total Cost": Infinity } },
    ]),
  ).toMatchObject({ nodes: { __proto__: 1 }, estimatedCost: null });
});
