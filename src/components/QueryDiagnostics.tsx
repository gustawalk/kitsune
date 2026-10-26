import {
  rememberDiagnostic,
  diagnosticRuns,
  compareDiagnostics,
  type DiagnosticRun,
} from "../lib/diagnostic-comparison";
import { Select, SelectItem } from "./ui/select";
import { useEffect, useRef, useState } from "react";
import { Activity, Play, Square } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ErrorState, Loading, Tag } from "./shared";
import { api, errorMessage } from "../lib/api";
import { display, type DbValue, type ResultSet } from "../lib/types";
export interface DiagnosticResult {
  engine: "sqlite" | "postgres" | "mysql" | "mssql";
  mode: "estimate" | "measure";
  plan: ResultSet;
  structuredPlan: unknown;
  elapsedMs: number;
  measurementMs: number | null;
  rowsConsumed: number | null;
  complete: boolean | null;
  costUnit: string | null;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function PgNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const node = object(value);
  if (!node) return null;
  if (depth > 32) return <p>Nested plan omitted here; see raw output.</p>;
  const children = Array.isArray(node.Plans) ? (node.Plans as unknown[]) : [];
  const metrics = [
    "Startup Cost",
    "Total Cost",
    "Plan Rows",
    "Actual Startup Time",
    "Actual Total Time",
    "Actual Rows",
    "Actual Loops",
    "Shared Hit Blocks",
    "Shared Read Blocks",
  ];
  return (
    <details className="diagnostic-node" open>
      <summary>
        <strong>{String(node["Node Type"] || "Plan node")}</strong>
        {node["Relation Name"] ? ` · ${String(node["Relation Name"])}` : ""}
        {node["Index Name"] ? ` · ${String(node["Index Name"])}` : ""}
      </summary>
      <dl>
        {metrics
          .filter((k) => typeof node[k] === "number")
          .map((k) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                {String(node[k])}
                {k.includes("Time") ? " ms" : ""}
              </dd>
            </div>
          ))}
      </dl>
      {children.map((child, i) => (
        <PgNode key={i} value={child} depth={depth + 1} />
      ))}
    </details>
  );
}
function SqlitePlan({ plan }: { plan: ResultSet }) {
  const id = plan.columns.indexOf("id"),
    parent = plan.columns.indexOf("parent"),
    detail = plan.columns.indexOf("detail");
  if (id < 0 || parent < 0 || detail < 0)
    return <pre className="mutation-sql">{JSON.stringify(plan, null, 2)}</pre>;
  const rows = plan.rows.map((row, i) => ({
    id: display(row[id]),
    parent: display(row[parent]),
    label: display(row[detail]),
    i,
  }));
  const rendered = new Set<number>();
  function render(row: (typeof rows)[number], depth: number): React.ReactNode {
    if (rendered.has(row.i) || depth > 32) return null;
    rendered.add(row.i);
    return (
      <li key={row.i}>
        <code>{row.label}</code>
        <ul>
          {rows
            .filter((r) => r.parent === row.id && r.i !== row.i)
            .map((r) => render(r, depth + 1))}
        </ul>
      </li>
    );
  }
  const roots = rows.filter(
    (r) => !rows.some((p) => p.id === r.parent && p.i !== r.i),
  );
  return (
    <ul className="sqlite-plan">
      {roots.map((r) => render(r, 0))}
      {rows.filter((r) => !rendered.has(r.i)).map((r) => render(r, 0))}
    </ul>
  );
}
export function QueryDiagnostics({
  connectionId,
  sql,
  params,
  onClose,
}: {
  connectionId: string;
  sql: string;
  params: DbValue[];
  onClose: () => void;
}) {
  const [result, setResult] = useState<DiagnosticResult>();
  const [runs, setRuns] = useState(() => diagnosticRuns(connectionId));
  const [currentRun, setCurrentRun] = useState<DiagnosticRun>();
  const [baselineId, setBaselineId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const operation = useRef("");
  const mounted = useRef(true);
  const version = useRef(0);
  async function diagnose(mode: "estimate" | "measure") {
    setBusy(true);
    setError("");
    setCancelling(false);
    const currentVersion = ++version.current;
    operation.current = crypto.randomUUID();
    try {
      const value = await api<DiagnosticResult>("diagnose_query", {
        connectionId,
        sql,
        params,
        mode,
        operationId: operation.current,
      });
      if (mounted.current && currentVersion === version.current) {
        setResult(value);
        const run: DiagnosticRun = {
          id: operation.current,
          connectionId,
          sql,
          context: JSON.stringify([sql, params]),
          at: new Date().toISOString(),
          result: value,
        };
        setRuns(
          rememberDiagnostic(run).filter(
            (r) => r.connectionId === connectionId,
          ),
        );
        setCurrentRun(run);
      }
    } catch (e) {
      if (mounted.current && currentVersion === version.current)
        setError(errorMessage(e));
    } finally {
      if (currentVersion === version.current) operation.current = "";
      if (mounted.current && currentVersion === version.current) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }
  function cancel() {
    if (operation.current) {
      setCancelling(true);
      void api("cancel_query", { operationId: operation.current }).catch((e) =>
        setError(errorMessage(e)),
      );
    }
  }
  useEffect(() => {
    mounted.current = true;
    void diagnose("estimate");
    return () => {
      mounted.current = false;
      version.current++;
      if (operation.current)
        void api("cancel_query", { operationId: operation.current }).catch(
          () => undefined,
        );
    };
  }, []);
  const baseline = runs.find((r) => r.id === baselineId);
  const comparison =
    baseline && currentRun
      ? compareDiagnostics(baseline, currentRun)
      : undefined;
  const root = Array.isArray(result?.structuredPlan)
    ? object(result.structuredPlan[0])
    : object(result?.structuredPlan);
  return (
    <Dialog
      open
      wide
      title="Query diagnostics"
      description="Inspect the estimated plan, then explicitly run a read-only measurement."
      onClose={() => (busy ? cancel() : onClose())}
    >
      <pre className="mutation-sql">{sql}</pre>
      <div className="diagnostic-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void diagnose("estimate")}
        >
          <Activity size={14} />
          Refresh plan
        </Button>
        <Button disabled={busy || !result} onClick={() => setConfirm(true)}>
          <Play size={14} />
          Run measurement…
        </Button>
        {busy && (
          <Button variant="secondary" disabled={cancelling} onClick={cancel}>
            <Square size={12} />
            {cancelling ? "Cancellation requested…" : "Cancel"}
          </Button>
        )}
      </div>
      {error && <ErrorState error={error} />}
      {busy && (
        <Loading
          label={
            cancelling
              ? "Waiting for the operation to stop…"
              : "Collecting diagnostics…"
          }
        />
      )}
      {result && (
        <>
          <div className="diagnostic-metrics">
            <Tag>
              {result.mode === "estimate" ? "Estimated plan" : "Measured query"}
            </Tag>
            <span>Diagnostic operation: {result.elapsedMs} ms</span>
            {result.measurementMs !== null && (
              <span>Driver elapsed: {result.measurementMs} ms</span>
            )}
            {result.rowsConsumed !== null && (
              <span>{result.rowsConsumed} rows consumed</span>
            )}
            {result.complete !== null && (
              <Tag tone={result.complete ? "" : "danger"}>
                {result.complete ? "Completed" : "Partial · row limit reached"}
              </Tag>
            )}
          </div>
          <p className="muted small">
            {result.engine === "mssql"
              ? "SQL Server estimates use typed, unassigned parameters; estimates can differ from value-specific execution. Measurement uses the actual bound values."
              : result.engine === "postgres"
                ? "Planner costs are relative units, not milliseconds or money. Instrumentation adds overhead; client result-transfer time is not measured by EXPLAIN ANALYZE."
                : "SQLite exposes scan/index choices without a comparable numeric cost. Elapsed time includes driver work and bounded row consumption."}
          </p>
          {root && (
            <div className="diagnostic-metrics">
              {["Planning Time", "Execution Time"]
                .filter((k) => typeof root[k] === "number")
                .map((k) => (
                  <span key={k}>
                    {k}: {String(root[k])} ms
                  </span>
                ))}
            </div>
          )}
          {result.engine === "postgres" ? (
            <PgNode value={root?.Plan} />
          ) : result.engine === "mssql" ? (
            <pre className="mutation-sql">
              {result.plan.rows[0]?.[0]?.kind === "text"
                ? result.plan.rows[0][0].value
                : JSON.stringify(result.plan.rows, null, 2)}
            </pre>
          ) : result.engine === "mysql" ? (
            <pre className="mutation-sql">
              {JSON.stringify(result.structuredPlan, null, 2)}
            </pre>
          ) : (
            <SqlitePlan plan={result.plan} />
          )}
          <section className="diagnostic-comparison">
            <h3>Compare runs</h3>
            <Select value={baselineId} onValueChange={setBaselineId}>
              <SelectItem value="">Choose a baseline run</SelectItem>
              {runs
                .filter((r) => r.id !== currentRun?.id)
                .map((run) => (
                  <SelectItem value={run.id} key={run.id}>
                    {new Date(run.at).toLocaleTimeString()} · {run.result.mode}{" "}
                    · {run.sql.slice(0, 70)}
                  </SelectItem>
                ))}
            </Select>
            <p className="muted small">
              Up to 10 runs / 5 MiB are retained in memory only. Timing
              comparisons are not controlled benchmarks.
            </p>
            {comparison && (
              <>
                <div className="diagnostic-metrics">
                  {comparison.elapsedDelta !== null && (
                    <span>
                      Driver time change:{" "}
                      {comparison.elapsedDelta > 0 ? "+" : ""}
                      {comparison.elapsedDelta} ms
                    </span>
                  )}
                  {comparison.costDelta !== null && (
                    <span>
                      Estimated cost change:{" "}
                      {comparison.costDelta > 0 ? "+" : ""}
                      {comparison.costDelta} planner units
                    </span>
                  )}
                </div>
                {!comparison.sameContext && (
                  <p className="notice">
                    SQL or bound values differ between these runs.
                  </p>
                )}
                {!comparison.complete && (
                  <p className="notice">
                    One or both runs are estimates or partial measurements;
                    execution-time comparisons are incomplete.
                  </p>
                )}
                {comparison.nodes.map((n) => (
                  <p className="small" key={n.kind}>
                    {n.kind}: {n.before} → {n.after}
                  </p>
                ))}
                {baseline && (
                  <details>
                    <summary>Baseline raw plan</summary>
                    <pre className="mutation-sql">
                      {JSON.stringify(
                        baseline.result.structuredPlan ?? baseline.result.plan,
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
              </>
            )}
          </section>
          <details>
            <summary>Raw plan</summary>
            <pre className="mutation-sql">
              {JSON.stringify(result.structuredPlan ?? result.plan, null, 2)}
            </pre>
          </details>
        </>
      )}
      {confirm && (
        <Dialog
          open
          title="Run read-only measurement?"
          description="This executes the query and may consume database resources. The configured timeout and cancellation controls apply."
          onClose={() => setConfirm(false)}
        >
          <footer>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                void diagnose("measure");
              }}
            >
              Run measurement
            </Button>
          </footer>
        </Dialog>
      )}
    </Dialog>
  );
}
