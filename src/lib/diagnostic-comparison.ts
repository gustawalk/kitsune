import type { DiagnosticResult } from "../components/QueryDiagnostics";
export interface DiagnosticRun {
  id: string;
  connectionId: string;
  sql: string;
  context: string;
  at: string;
  result: DiagnosticResult;
}
const runs: DiagnosticRun[] = [];
export function rememberDiagnostic(run: DiagnosticRun): DiagnosticRun[] {
  const size = (r: DiagnosticRun) => JSON.stringify(r).length * 2;
  if (size(run) <= 2 * 1024 * 1024) runs.push(run);
  while (
    runs.length > 10 ||
    runs.reduce((n, r) => n + size(r), 0) > 5 * 1024 * 1024
  )
    runs.shift();
  return [...runs];
}
export function diagnosticRuns(connectionId: string): DiagnosticRun[] {
  return runs.filter((r) => r.connectionId === connectionId);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function planSummary(value: unknown): {
  nodes: Record<string, number>;
  estimatedCost: number | null;
  actualRows: number | null;
  executionMs: number | null;
} {
  const root = object(Array.isArray(value) ? value[0] : value);
  const nodes: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  let count = 0;
  function walk(value: unknown) {
    if (++count > 10000) return;
    const node = object(value);
    if (!node) return;
    const kind = node["Node Type"];
    if (typeof kind === "string") nodes[kind] = (nodes[kind] || 0) + 1;
    const plans = node.Plans;
    if (Array.isArray(plans)) plans.forEach(walk);
  }
  walk(root?.Plan);
  const plan = object(root?.Plan);
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    nodes,
    estimatedCost: number(plan?.["Total Cost"]),
    actualRows: number(plan?.["Actual Rows"]),
    executionMs: number(root?.["Execution Time"]),
  };
}
export function compareDiagnostics(
  before: DiagnosticRun,
  after: DiagnosticRun,
) {
  const a = planSummary(before.result.structuredPlan),
    b = planSummary(after.result.structuredPlan);
  return {
    sameContext: before.context === after.context,
    complete: before.result.complete === true && after.result.complete === true,
    elapsedDelta:
      before.result.measurementMs !== null &&
      after.result.measurementMs !== null
        ? after.result.measurementMs - before.result.measurementMs
        : null,
    costDelta:
      a.estimatedCost !== null && b.estimatedCost !== null
        ? b.estimatedCost - a.estimatedCost
        : null,
    nodes: [...new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])].map(
      (kind) => ({
        kind,
        before: a.nodes[kind] || 0,
        after: b.nodes[kind] || 0,
      }),
    ),
  };
}
