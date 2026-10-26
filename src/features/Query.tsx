import { PortableSql } from "../components/PortableSql";
import { QueryDiagnostics } from "../components/QueryDiagnostics";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { modKey } from "../lib/utils";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useDeferredValue,
} from "react";
import type { EditorView } from "@codemirror/view";
import {
  Activity,
  Braces,
  Clock3,
  Copy,
  Eye,
  Play,
  Save,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { SqlEditor } from "../components/SqlEditor";
import { DataGrid } from "../components/DataGrid";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Empty, ErrorState, Field, copyFeedback } from "../components/shared";
import { api, errorMessage, useRemote } from "../lib/api";
import {
  getWorkspace,
  notify,
  openTab,
  patchTab,
  useWorkspace,
} from "../lib/store";
import { currentStatement } from "../lib/sql";
import type {
  ApiError,
  Execution,
  TableRef,
  Tab,
  SqlCompletion,
} from "../lib/types";
export function QueryWorkspace({ tab }: { tab: Tab }) {
  const workspace = useWorkspace();
  const dialect =
    workspace.connections.find((c) => c.id === tab.connectionId)?.driver ||
    "sqlite";
  const [portableSource, setPortableSource] = useState<string>();
  const [diagnosing, setDiagnosing] = useState<{
    sql: string;
    params: import("../lib/types").DbValue[];
  }>();
  const [busy, setBusy] = useState(false);
  const [execution, setExecution] = useState<Execution>();
  const [error, setError] = useState("");
  const [script, setScript] = useState(false);
  const [resultIndex, setResultIndex] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [queryName, setQueryName] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const editor = useRef<EditorView | null>(null);
  const operation = useRef("");
  const pending = useRef("");
  const approval = useRef("");
  const [editorHeight, setEditorHeight] = useState(260);
  const connected = workspace.activeConnections.includes(
    tab.connectionId || "",
  );
  const deferredSql = useDeferredValue(tab.sql || "");
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId: tab.connectionId },
    connected,
  );
  const referenced = (tables.data || [])
    .filter((t) => deferredSql.toLowerCase().includes(t.name.toLowerCase()))
    .slice(0, 5);
  const columns = useRemote<SqlCompletion[]>(
    "sql_completion",
    { connectionId: tab.connectionId, tables: referenced },
    connected && referenced.length > 0,
  );
  const execute = useCallback(
    async (confirmed = false, exactSql?: string) => {
      if (busy) return;
      const current = getWorkspace();
      const currentTab = current.tabs.find((t) => t.id === tab.id);
      const connectionId = currentTab?.connectionId;
      if (!connectionId || !current.activeConnections.includes(connectionId)) {
        setError("Select a connected database before executing SQL.");
        return;
      }
      const view = editor.current;
      const selection = view?.state.selection.main;
      const sql =
        exactSql ??
        (view && selection && !selection.empty
          ? view.state.sliceDoc(selection.from, selection.to)
          : script
            ? currentTab.sql || ""
            : currentStatement(currentTab.sql || "", selection?.head || 0));
      if (!sql.trim()) {
        setError("Enter or select SQL to execute.");
        return;
      }
      pending.current = sql;
      setBusy(true);
      setError("");
      operation.current = crypto.randomUUID();
      try {
        const result = await api<Execution>("execute", {
          connectionId,
          sql,
          operationId: operation.current,
          confirmationToken: confirmed ? approval.current : undefined,
          script,
          params: currentTab?.boundParams || [],
        });
        setExecution(result);
        setResultIndex(0);
        if (result.error) setError(result.error.message);
        else notify(`Query completed in ${result.durationMs} ms`);
        if (result.warning) notify(result.warning, true);
      } catch (e) {
        if ((e as ApiError).code === "CONFIRM_REQUIRED") {
          const review = await api<{
            token: string;
          }>("review_query", {
            connectionId,
            sql,
            script,
            params: currentTab?.boundParams || [],
          });
          approval.current = review.token;
          setConfirmation(sql);
        } else setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, script, tab.id],
  );
  useEffect(() => {
    const run = () => {
      if (getWorkspace().activeTab === tab.id) void execute();
    };
    const save = () => {
      if (getWorkspace().activeTab === tab.id) setSaving(true);
    };
    window.addEventListener("kitsune:execute", run);
    window.addEventListener("kitsune:save", save);
    return () => {
      window.removeEventListener("kitsune:execute", run);
      window.removeEventListener("kitsune:save", save);
    };
  }, [execute]);
  async function cancel() {
    try {
      const result = await api<{
        requested: boolean;
      }>("cancel_query", {
        operationId: operation.current,
      });
      notify(
        result.requested
          ? "Cancellation requested. Waiting for the database outcome."
          : "The operation has already finished.",
      );
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function save() {
    setSaveBusy(true);
    try {
      await api("save_query", { name: queryName, sql: tab.sql || "" });
      patchTab(tab.id, { title: queryName, savedSql: tab.sql });
      setSaving(false);
      notify("Query saved locally");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaveBusy(false);
    }
  }
  return (
    <div className="query-workspace">
      <div className="query-toolbar">
        <Select
          aria-label="Query connection"
          value={tab.connectionId || ""}
          disabled={busy}
          onValueChange={(value) => patchTab(tab.id, { connectionId: value })}
        >
          <SelectItem value="">Select connection</SelectItem>
          {workspace.connections.map((c) => (
            <SelectItem
              key={c.id}
              value={c.id}
              disabled={!workspace.activeConnections.includes(c.id)}
            >
              {c.name}
              {!workspace.activeConnections.includes(c.id) && " (disconnected)"}
            </SelectItem>
          ))}
        </Select>
        <span className={`connection-dot ${connected ? "online" : ""}`} />
        <span className="query-dialect">
          {dialect === "mysql"
            ? "MySQL / MariaDB"
            : dialect === "postgres"
              ? "PostgreSQL"
              : "SQLite"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const view = editor.current,
              selection = view?.state.selection.main;
            setPortableSource(
              view && selection && !selection.empty
                ? view.state.sliceDoc(selection.from, selection.to)
                : tab.sql || "",
            );
          }}
        >
          <Braces size={14} />
          Portable SQL
        </Button>
        <div className="spacer" />
        <label className="check-row inline">
          <Checkbox
            checked={script}
            disabled={busy}
            onCheckedChange={(checked) => setScript(checked)}
          />
          Sequential script
        </label>
        <Button
          variant="ghost"
          size="icon"
          title="Copy SQL"
          onClick={() => void copyFeedback(tab.sql || "")}
        >
          <Copy size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Save query (Ctrl/Cmd+S)"
          onClick={() => setSaving(true)}
        >
          <Save size={15} />
        </Button>
        {busy ? (
          <Button variant="secondary" size="sm" onClick={() => void cancel()}>
            <Square size={13} />
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!connected || !tab.sql?.trim()}
            onClick={() => void execute()}
          >
            <Play size={13} />
            Run query<kbd>{modKey} ↵</kbd>
          </Button>
        )}
      </div>
      {portableSource !== undefined && (
        <PortableSql
          source={portableSource}
          dialect={dialect}
          tables={tables.data || []}
          onClose={() => setPortableSource(undefined)}
          onApply={(sql, parameterOrder) => {
            if (
              tab.boundParams &&
              parameterOrder.some((i) => !tab.boundParams?.[i - 1])
            ) {
              notify(
                "This query refers to an unavailable bound parameter. Keep the original parameter indexes or use an explicit SQL literal.",
                true,
              );
              return;
            }
            openTab({
              kind: "query",
              title: "Portable query",
              connectionId: tab.connectionId,
              sql,
              boundParams:
                dialect === "mysql" && tab.boundParams
                  ? parameterOrder.map((i) => tab.boundParams![i - 1])
                  : tab.boundParams,
            });
            setPortableSource(undefined);
          }}
        />
      )}
      {diagnosing && tab.connectionId && (
        <QueryDiagnostics
          connectionId={tab.connectionId}
          {...diagnosing}
          onClose={() => setDiagnosing(undefined)}
        />
      )}
      {!!tab.boundParams?.length && (
        <details className="bound-params">
          <summary>
            {tab.boundParams.length} values bound · editing SQL clears these
            values
          </summary>
          <div>
            {tab.boundParams.map((v, i) => (
              <code key={i}>
                {i + 1}: {JSON.stringify(v)}
              </code>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patchTab(tab.id, { boundParams: undefined })}
            >
              Clear bound values
            </Button>
          </div>
        </details>
      )}
      <div className="editor-container" style={{ height: editorHeight }}>
        <SqlEditor
          dialect={dialect}
          value={tab.sql || ""}
          onChange={(sql) => patchTab(tab.id, { sql })}
          editorRef={editor}
          suggestions={[
            ...(tables.data?.flatMap((t) => [
              {
                label: t.name,
                parts: [t.name],
                kind: "table",
                detail: t.schema || "table",
              },
              ...(t.schema
                ? [
                    {
                      label: `${t.schema}.${t.name}`,
                      parts: [t.schema, t.name],
                      kind: "table",
                      detail: "qualified table",
                    },
                  ]
                : []),
            ]) || []),
            ...(columns.data || []),
          ]}
          settings={workspace.settings}
        />
      </div>
      <div
        className="horizontal-resize"
        role="separator"
        aria-label="Resize SQL editor"
        aria-orientation="horizontal"
        onPointerDown={(e) => {
          const y = e.clientY,
            initial = editorHeight;
          const move = (event: PointerEvent) =>
            setEditorHeight(
              Math.max(120, Math.min(700, initial + event.clientY - y)),
            );
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <div className="results-header">
        <Terminal size={14} />
        <strong>Results</strong>
        {execution && (
          <>
            <span className="tag">{execution.durationMs} ms</span>
            {execution.results.length > 1 && (
              <Select
                aria-label="Statement result"
                value={resultIndex}
                onValueChange={(value) => setResultIndex(Number(value))}
              >
                {execution.results.map((_, i) => (
                  <SelectItem key={i} value={i}>
                    Statement {i + 1}
                  </SelectItem>
                ))}
              </Select>
            )}
          </>
        )}
        <div className="spacer" />
        {execution && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!!tab.boundParams?.length}
            title={
              tab.boundParams?.length
                ? "Create a record watch from the inspector; query watches do not retain bound values."
                : "Watch this query result"
            }
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("kitsune:watch", {
                  detail: {
                    connectionId: tab.connectionId,
                    sql: pending.current,
                    kind: "query",
                  },
                }),
              )
            }
          >
            <Eye size={13} />
            Watch query
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !connected || script}
          title={
            script
              ? "Choose one statement rather than a script"
              : "Inspect the query plan and performance"
          }
          onClick={() => {
            const view = editor.current;
            const selection = view?.state.selection.main;
            const sql =
              view && selection && !selection.empty
                ? view.state.sliceDoc(selection.from, selection.to)
                : currentStatement(tab.sql || "", selection?.head || 0);
            if (!sql.trim()) {
              setError("Enter or select a query to diagnose.");
              return;
            }
            setDiagnosing({ sql, params: tab.boundParams || [] });
          }}
        >
          <Activity size={14} />
          Diagnose
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openTab({ kind: "history", title: "Query history" })}
        >
          <Clock3 size={13} />
          History
        </Button>
      </div>
      {error && <ErrorState error={error} />}
      {execution?.warning && <ErrorState error={execution.warning} />}
      <div className="results-body">
        {execution?.results[resultIndex] ? (
          <DataGrid
            result={execution.results[resultIndex]}
            density={workspace.settings.density}
          />
        ) : (
          <Empty
            icon={<Terminal size={25} />}
            title={busy ? "Executing query…" : "Ready when you are"}
            detail={
              busy
                ? "You can keep working while the database responds."
                : "Run a statement to explore its results. Select SQL to execute only that selection."
            }
          >
            <span className="shortcut-hint">
              <kbd>Ctrl / ⌘</kbd> + <kbd>Enter</kbd> to execute
            </span>
          </Empty>
        )}
      </div>
      {confirmation && (
        <Dialog
          open
          onClose={() => setConfirmation("")}
          title="Review SQL execution"
          description={`${workspace.connections.find((c) => c.id === tab.connectionId)?.name} · ${workspace.connections.find((c) => c.id === tab.connectionId)?.environment}`}
        >
          <p className="notice">
            This statement may modify data or schema. Its affected-row count is
            unknown before execution.
          </p>
          <pre className="sql-preview">{confirmation}</pre>
          <footer>
            <Button variant="ghost" onClick={() => setConfirmation("")}>
              <X size={14} />
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const exact = confirmation;
                setConfirmation("");
                void execute(true, exact);
              }}
            >
              Execute reviewed SQL
            </Button>
          </footer>
        </Dialog>
      )}
      {saving && (
        <Dialog
          open
          onClose={() => setSaving(false)}
          title="Save query"
          description="Saved SQL is stored locally and may contain sensitive literals. Bound values are not saved."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Query name">
              <input
                autoFocus
                required
                value={queryName}
                onChange={(e) => setQueryName(e.target.value)}
                placeholder="Pending orders"
              />
            </Field>
            <footer>
              <Button disabled={saveBusy}>
                <Save size={14} />
                Save query
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
