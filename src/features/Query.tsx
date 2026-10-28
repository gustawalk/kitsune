import { startResize } from "../lib/resize";
import { PortableSql } from "../components/PortableSql";
import { QueryDiagnostics } from "../components/QueryDiagnostics";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { modKey } from "../lib/utils";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
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
import { api, errorMessage, useRemote, invalidate } from "../lib/api";
import {
  getWorkspace,
  notify,
  openTab,
  patchTab,
  useWorkspace,
  update,
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
  const draftSql = useRef(tab.sql || "");
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const preparing = useRef(false);
  const operation = useRef("");
  const pending = useRef("");
  const approval = useRef("");
  const [editorHeight, setEditorHeight] = useState(260);
  const connected = workspace.activeConnections.includes(
    tab.connectionId || "",
  );
  const currentSql = () =>
    editor.current?.state.doc.toString() ?? draftSql.current;
  useEffect(() => {
    if (!editor.current && draftSql.current !== (tab.sql || ""))
      draftSql.current = tab.sql || "";
  }, [tab.sql]);
  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      const sql = currentSql();
      if (sql !== (getWorkspace().tabs.find((t) => t.id === tab.id)?.sql || ""))
        patchTab(tab.id, { sql });
    },
    [tab.id],
  );
  const [completionSql, setCompletionSql] = useState(tab.sql || "");
  useEffect(() => {
    const timer = setTimeout(() => setCompletionSql(tab.sql || ""), 650);
    return () => clearTimeout(timer);
  }, [tab.sql]);
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId: tab.connectionId },
    connected && workspace.activeTab === tab.id,
  );
  const indexedTables = useMemo(
    () =>
      (tables.data || []).map((table) => ({
        table,
        lowerName: table.name.toLowerCase(),
      })),
    [tables.data],
  );
  const referenced = useMemo(() => {
    const lowerSql = completionSql.toLowerCase();
    return indexedTables
      .filter(({ lowerName }) => lowerSql.includes(lowerName))
      .slice(0, 5)
      .map(({ table }) => table);
  }, [completionSql, indexedTables]);
  const columns = useRemote<SqlCompletion[]>(
    "sql_completion",
    { connectionId: tab.connectionId, tables: referenced },
    connected && workspace.activeTab === tab.id && referenced.length > 0,
  );
  const suggestions = useMemo(
    () => [
      ...(tables.data || []).flatMap((t) => [
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
      ]),
      ...(columns.data || []),
    ],
    [tables.data, columns.data],
  );
  const execute = useCallback(
    async (confirmed = false, exactSql?: string) => {
      if (busy || preparing.current) return;
      const current = getWorkspace();
      const currentTab = current.tabs.find((t) => t.id === tab.id);
      const connectionId = currentTab?.connectionId;
      if (!connectionId || !current.activeConnections.includes(connectionId)) {
        setError("Select a connected database before executing SQL.");
        return;
      }
      const view = editor.current;
      const selection = view?.state.selection.main;
      preparing.current = true;
      let sql: string;
      try {
        sql =
          exactSql ??
          (view && selection && !selection.empty
            ? view.state.sliceDoc(selection.from, selection.to)
            : script
              ? currentSql()
              : dialect === "mysql"
                ? (
                    await api<{ sql: string }>("mysql_statement", {
                      sql: currentSql(),
                      cursor: selection?.head || 0,
                    })
                  ).sql
                : currentStatement(currentSql(), selection?.head || 0));
      } catch (e) {
        preparing.current = false;
        setError(errorMessage(e));
        return;
      }
      if (!sql.trim()) {
        preparing.current = false;
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
          tabId: tab.id,
          sql,
          operationId: operation.current,
          confirmationToken: confirmed ? approval.current : undefined,
          script,
          params: currentTab?.boundParams || [],
        });
        setExecution(result);
        if (result.schemaChanged) {
          invalidate("tables");
          invalidate("metadata");
        }
        if (result.transactionState)
          update((s) => ({
            transactions: {
              ...s.transactions,
              [tab.id]: result.transactionState!,
            },
          }));
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
            tabId: tab.id,
            sql,
            script,
            params: currentTab?.boundParams || [],
          });
          approval.current = review.token;
          setConfirmation(sql);
        } else setError(errorMessage(e));
      } finally {
        preparing.current = false;
        setBusy(false);
      }
    },
    [busy, script, tab.id, dialect],
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
  useEffect(() => {
    if (dialect !== "mysql") return;
    if (!connected) {
      if (getWorkspace().transactions[tab.id] === "active")
        update((s) => ({
          transactions: { ...s.transactions, [tab.id]: "lost" },
        }));
      return;
    }
    let disposed = false;
    void api<{ transactionState: "idle" | "active" | "lost" }>(
      "editor_status",
      { connectionId: tab.connectionId, tabId: tab.id },
    )
      .then((r) => {
        if (
          !disposed &&
          getWorkspace().transactions[tab.id] !== r.transactionState
        )
          update((s) => ({
            transactions: { ...s.transactions, [tab.id]: r.transactionState },
          }));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [connected, dialect, tab.id, tab.connectionId]);
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
      const sql = currentSql();
      await api("save_query", { name: queryName, sql });
      patchTab(tab.id, { sql, title: queryName, savedSql: sql });
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
      {dialect === "mysql" && (
        <div
          className={`transaction-banner transaction-${workspace.transactions[tab.id] || "idle"}`}
          role="status"
        >
          <span>
            {!connected
              ? "SQL session disconnected"
              : workspace.transactions[tab.id] === "active"
                ? "Transaction active · changes are not committed"
                : workspace.transactions[tab.id] === "lost"
                  ? "Transaction connection lost · verify any unconfirmed writes"
                  : "No active transaction · statements use server autocommit rules"}
          </span>
          {workspace.transactions[tab.id] === "lost" ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void api("close_editor_session", {
                  connectionId: tab.connectionId,
                  tabId: tab.id,
                  confirmed: true,
                })
                  .then(() =>
                    update((s) => ({
                      transactions: { ...s.transactions, [tab.id]: "idle" },
                    })),
                  )
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              End lost session
            </Button>
          ) : workspace.transactions[tab.id] === "active" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !connected}
                onClick={() => void execute(false, "COMMIT")}
              >
                Commit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !connected}
                onClick={() => void execute(false, "ROLLBACK")}
              >
                Roll back
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !connected}
              onClick={() => void execute(false, "START TRANSACTION")}
            >
              Begin transaction
            </Button>
          )}
        </div>
      )}
      <div className="query-toolbar">
        <Select
          aria-label="Query connection"
          value={tab.connectionId || ""}
          disabled={busy || workspace.transactions[tab.id] === "active"}
          onValueChange={(value) => {
            setBusy(true);
            void (
              tab.connectionId && connected
                ? api("close_editor_session", {
                    connectionId: tab.connectionId,
                    tabId: tab.id,
                  })
                : Promise.resolve()
            )
              .then(() => {
                patchTab(tab.id, { connectionId: value });
                setExecution(undefined);
                setError("");
                update((s) => ({
                  transactions: { ...s.transactions, [tab.id]: "idle" },
                }));
              })
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
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
            : dialect === "mssql"
              ? "SQL Server"
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
                : currentSql(),
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
          onClick={() => void copyFeedback(currentSql())}
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
            disabled={!connected || !currentSql().trim()}
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
          onChange={(sql) => {
            draftSql.current = sql;
            if (persistTimer.current) clearTimeout(persistTimer.current);
            persistTimer.current = setTimeout(() => {
              if (
                sql !==
                (getWorkspace().tabs.find((t) => t.id === tab.id)?.sql || "")
              )
                patchTab(tab.id, { sql });
            }, 500);
          }}
          editorRef={editor}
          suggestions={suggestions}
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
          startResize(e, move);
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
                : currentStatement(currentSql(), selection?.head || 0);
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
          <>
            {execution.results[resultIndex].truncated && (
              <div className="result-limit-note" role="status">
                Partial read-only result: Kitsune stopped fetching at its safety
                limit and rolled back its read transaction. Narrow the query or
                add an explicit filter before running it again.
              </div>
            )}
            <DataGrid
              result={execution.results[resultIndex]}
              density={workspace.settings.density}
            />
          </>
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
