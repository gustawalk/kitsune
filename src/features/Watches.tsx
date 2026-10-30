import { watchQueryExample } from "../lib/watch-setup";
import { WorkflowHelp } from "../components/shared";
import { RestoreEvent } from "../components/RestoreEvent";
import { Tooltip } from "../components/ui/tooltip";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { useState } from "react";
import {
  ArrowRight,
  Clock3,
  Eye,
  History,
  Table2,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { Dialog } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import {
  Empty,
  ErrorState,
  Field,
  Loading,
  Tag,
  copyFeedback,
} from "../components/shared";
import { api, errorMessage, useRemote } from "../lib/api";
import { notify, openTab, update, useWorkspace } from "../lib/store";
import {
  display,
  identityColumns,
  readableKey,
  type ChangeEvent,
  type Metadata,
  type RecordRef,
  type Tab,
  type TableRef,
  type Watch,
} from "../lib/types";
import {
  stateComparison,
  equalValue,
  isDataEvent,
  eventExplanation,
  missingStateLabel,
} from "../lib/timeline";
import { inspectInTable } from "./Detective";
export type WatchTarget = Partial<RecordRef> & {
  kind?: "record" | "table" | "query";
  sql?: string;
  filters?: Watch["filters"];
  filterGroups?: Watch["filterGroups"];
  groupMode?: string;
  existing?: Watch;
};
export function WatchDialog({
  target,
  onClose,
}: {
  target: WatchTarget;
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  const existing = target.existing;
  const [connectionId, setConnectionId] = useState(
    existing?.connectionId || target.connectionId || workspace.activeConnection,
  );
  const connection = workspace.connections.find((c) => c.id === connectionId);
  const production = connection?.environment === "production";
  const [kind, setKind] = useState<Watch["kind"]>(
    existing?.kind ||
      target.kind ||
      (target.key ? "record" : target.table ? "table" : "query"),
  );
  const [groupName, setGroupName] = useState(existing?.groupName || "");
  const [duration, setDuration] = useState(
    existing?.durationSeconds ? String(existing.durationSeconds) : "",
  );
  const [name, setName] = useState(
    existing?.name || `${target.table?.name || "Query"} watch`,
  );
  const [interval, setInterval] = useState(
    existing?.intervalSeconds || workspace.settings.pollInterval,
  );
  const [capture, setCapture] = useState<"metadata" | "full">(
    existing?.capture || (production ? "metadata" : "full"),
  );
  const [consent, setConsent] = useState(
    existing?.productionCaptureAuthorized || false,
  );
  const [excluded, setExcluded] = useState(
    existing?.excludedColumns.join(", ") || workspace.settings.sensitiveColumns,
  );
  const [notifications, setNotifications] = useState(
    existing?.notifications ?? true,
  );
  const [sql, setSql] = useState(existing?.sql || target.sql || "");
  const [savedId, setSavedId] = useState(existing?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filterCol, setFilterCol] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [identityTable, setIdentityTable] = useState<TableRef | null>(
    existing?.table || target.table || null,
  );
  const [tracking, setTracking] = useState<"rows" | "membership">(
    existing?.kind === "query" && !existing.table ? "membership" : "rows",
  );
  const table =
    kind === "query" && tracking === "membership" ? null : identityTable;
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId },
    workspace.activeConnections.includes(connectionId),
  );
  const metadata = useRemote<Metadata>(
    "metadata",
    { connectionId, table },
    !!table && workspace.activeConnections.includes(connectionId),
  );
  async function save(start: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!name.trim()) throw new Error("Give your watch a name.");
      if (kind === "query" && tracking === "rows" && !table)
        throw new Error(
          "Choose the table your query returns records from, or choose Rows added to or removed from the results.",
        );
      if (
        kind === "query" &&
        tracking === "rows" &&
        table &&
        (!metadata.data || !identityColumns(metadata.data).length)
      )
        throw new Error(
          "A unique record ID is needed to compare old and new values. Wait for the table details to load, or choose a table with a unique ID.",
        );
      if (kind === "query" && !sql.trim())
        throw new Error(
          "Enter the SELECT query to watch, or use the example query.",
        );
      if (!Number.isInteger(interval) || interval < 2 || interval > 3600)
        throw new Error("Choose an interval between 2 and 3,600 seconds.");
      const watch: Watch = {
        filterGroups: existing?.filterGroups || target.filterGroups || [],
        groupMode: existing?.groupMode || target.groupMode || "all",
        groupName,
        durationSeconds: duration ? Number(duration) : null,
        startedAt: existing?.startedAt || null,
        deadlineAt: existing?.deadlineAt || null,
        id: savedId,
        name,
        connectionId,
        kind,
        table: table || null,
        key: existing?.key || target.key || {},
        filters: existing?.filters.length
          ? existing.filters
          : target.filters?.length
            ? target.filters
            : filterCol
              ? [
                  {
                    column: filterCol,
                    operator: "eq",
                    value: { kind: "text", value: filterValue },
                  },
                ]
              : [],
        sql,
        intervalSeconds: interval,
        capture,
        productionCaptureAuthorized:
          existing?.productionCaptureAuthorized || false,
        excludedColumns: excluded
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        notifications,
        status: "paused",
        lastObserved: existing?.lastObserved || null,
        lastError: null,
        eventCount: existing?.eventCount || 0,
      };
      const saved = await api<Watch>("save_watch", {
        ...watch,
        allowProductionCapture: consent,
      });
      setSavedId(saved.id);
      update({ watches: await api<Watch[]>("watches") });
      if (start) await api("watch_action", { id: saved.id, action: "start" });
      update({ watches: await api<Watch[]>("watches") });
      notify(
        start
          ? "Watch started. First observation establishes a baseline."
          : "Watch saved in paused state.",
      );
      onClose();
      openTab({ kind: "watches", title: "Live Watch" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
      title={existing ? "Configure watch" : "Watch for changes"}
      description={connection?.name || "Choose a database connection"}
      className="watch-setup-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <fieldset disabled={busy} className="connection-fields">
          <div className="watch-setup-summary">
            <Eye size={20} />
            <div>
              <strong>See changes made while this watch is running</strong>
              <p>
                Start watching, wait for the first check, then change your data.
                Open Time Machine to see what changed.
              </p>
            </div>
          </div>
          {!existing && !target.connectionId && (
            <Field label="Connection">
              <Select
                value={connectionId}
                onValueChange={(value) => {
                  setConnectionId(value);
                  setIdentityTable(null);
                  setFilterCol("");
                }}
              >
                <SelectItem value="">Choose a connection</SelectItem>
                {workspace.connections
                  .filter((c) => workspace.activeConnections.includes(c.id))
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {c.environment}
                    </SelectItem>
                  ))}
              </Select>
            </Field>
          )}
          <div className="form-grid">
            <Field label="Name this watch">
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="What do you want to watch?">
              <Select
                value={kind}
                disabled={!!target.key || !!existing}
                onValueChange={(value) => setKind(value as Watch["kind"])}
              >
                <SelectItem value="query">Records returned by SQL</SelectItem>
                <SelectItem value="table">
                  Records matching a table filter
                </SelectItem>
                {(target.key || existing?.kind === "record") && (
                  <SelectItem value="record">Record</SelectItem>
                )}
              </Select>
            </Field>
          </div>
          {kind === "record" && (
            <div className="notice mono">
              {table?.name} /{" "}
              {readableKey({
                connectionId,
                table: table!,
                key: existing?.key || target.key || {},
              })}
            </div>
          )}
          {kind === "table" && (
            <Field label="Table to monitor">
              <Select
                required
                disabled={!!existing || !!target.table}
                value={table ? JSON.stringify(table) : ""}
                onValueChange={(v) => {
                  setIdentityTable(v ? (JSON.parse(v) as TableRef) : null);
                  setFilterCol("");
                }}
              >
                <SelectItem value="">Choose a table</SelectItem>
                {tables.data
                  ?.filter((t) => t.kind === "table")
                  .map((t) => (
                    <SelectItem
                      key={JSON.stringify(t)}
                      value={JSON.stringify(t)}
                    >
                      {[t.schema, t.name].filter(Boolean).join(".")}
                    </SelectItem>
                  ))}
              </Select>
            </Field>
          )}
          {tables.error && <ErrorState error={tables.error} />}
          {metadata.error && <ErrorState error={metadata.error} />}
          {kind === "query" && (
            <fieldset className="watch-choice-group">
              <legend>What would you like to see in Time Machine?</legend>
              <div className="watch-choice-options">
                <label
                  className={`watch-choice ${tracking === "rows" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="watch-tracking"
                    value="rows"
                    checked={tracking === "rows"}
                    onChange={() => setTracking("rows")}
                  />
                  <span>
                    <strong>Old and new values for each record</strong>
                    <small>
                      For example: “Draft” → “Published”. Choose a table below
                      so Kitsune can match the same record between checks.
                    </small>
                  </span>
                </label>
                <label
                  className={`watch-choice ${tracking === "membership" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="watch-tracking"
                    value="membership"
                    checked={tracking === "membership"}
                    onChange={() => setTracking("membership")}
                  />
                  <span>
                    <strong>Rows added to or removed from the results</strong>
                    <small>
                      Use for totals, grouped queries, or results without a
                      unique record ID. An edited row can appear as a removal
                      and an addition.
                    </small>
                  </span>
                </label>
              </div>
            </fieldset>
          )}
          {kind === "query" && tracking === "rows" && (
            <Field
              label="Which table contains these records?"
              hint="Choose the table your SQL returns records from."
            >
              <Select
                required
                aria-label="Which table contains these records?"
                value={identityTable ? JSON.stringify(identityTable) : ""}
                onValueChange={(value) =>
                  setIdentityTable(
                    value ? (JSON.parse(value) as TableRef) : null,
                  )
                }
              >
                <SelectItem value="">Choose the table to track</SelectItem>
                {tables.data?.map((t) => (
                  <SelectItem
                    key={`${t.schema}:${t.name}`}
                    value={JSON.stringify(t)}
                  >
                    {[t.schema, t.name].filter(Boolean).join(".")}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          )}
          {kind === "query" &&
            table &&
            metadata.data &&
            (identityColumns(metadata.data).length ? (
              <div className="watch-key-explanation">
                <strong>How Kitsune recognizes the same record</strong>
                <p>
                  <code>{identityColumns(metadata.data).join(" + ")}</code>{" "}
                  identifies each record in <strong>{table.name}</strong>. Your
                  SQL must return{" "}
                  {identityColumns(metadata.data).length === 1
                    ? "this column"
                    : "these columns"}{" "}
                  with{" "}
                  {identityColumns(metadata.data).length === 1
                    ? "its original name"
                    : "their original names"}
                  , once per record. <code>SELECT *</code> already includes{" "}
                  {identityColumns(metadata.data).length === 1 ? "it" : "them"}.
                </p>
                <p>
                  To restore changes later, select this table’s columns
                  directly, using its full schema and table name. Joins, renamed
                  columns, and calculations can be viewed but cannot be
                  restored. Use the example query below as a starting point.
                </p>
              </div>
            ) : (
              <ErrorState error="This table has no unique record ID. Choose another table, or choose Rows added to or removed from the results above." />
            ))}
          {kind === "query" && (
            <Field
              label="SQL that selects the records to watch"
              hint="Use SELECT to choose your records. Add a WHERE filter if the query returns more than 1,000 rows. This watch never changes your database."
            >
              <textarea
                rows={3}
                placeholder={
                  table
                    ? watchQueryExample(table, connection?.driver || "postgres")
                    : tracking === "rows"
                      ? "Choose a table above for an example, or enter your SELECT query."
                      : "Enter your SELECT query, such as a total or a grouped result."
                }
                className="mono"
                required
                value={sql}
                onChange={(e) => setSql(e.target.value)}
              />
            </Field>
          )}
          {kind === "query" && table && (
            <div className="watch-query-example">
              <div>
                <strong>Need a starting query?</strong>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setSql(
                      watchQueryExample(
                        table,
                        connection?.driver || "postgres",
                      ),
                    )
                  }
                >
                  {sql.trim() ? "Replace SQL with example" : "Use this query"}
                </Button>
              </div>
            </div>
          )}
          {kind === "table" &&
            !!(
              target.filters?.length ||
              existing?.filters.length ||
              target.filterGroups?.some((g) => g.filters.length) ||
              existing?.filterGroups.some((g) => g.filters.length)
            ) && (
              <p className="notice">
                Scope:{" "}
                {(existing?.filters.length
                  ? existing.filters
                  : target.filters || []
                )
                  .map((f) => `${f.column} ${f.operator} ${display(f.value)}`)
                  .join(" AND ")}
                . Up to 1,000 matching records are compared.
              </p>
            )}
          {kind === "table" &&
            !(
              target.filters?.length ||
              existing?.filters.length ||
              target.filterGroups?.some((g) => g.filters.length) ||
              existing?.filterGroups.some((g) => g.filters.length)
            ) && (
              <div className="form-grid">
                <Field label="Scope column">
                  <Select
                    required
                    value={filterCol}
                    onValueChange={(value) => setFilterCol(value)}
                  >
                    <SelectItem value="">Choose column</SelectItem>
                    {metadata.data?.columns.map((c) => (
                      <SelectItem key={c.name}>{c.name}</SelectItem>
                    ))}
                  </Select>
                </Field>
                <Field label="Equals">
                  <input
                    required
                    value={filterValue}
                    onChange={(e) => setFilterValue(e.target.value)}
                  />
                </Field>
              </div>
            )}
          <div className="form-grid">
            <Field label="Check for changes every (seconds)">
              <input
                type="number"
                min={2}
                max={3600}
                required
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Save record values on this device?"
              hint={
                capture === "full"
                  ? "Values stay in local history. Columns you choose to ignore are not saved."
                  : "History will show field names only. Old and new values cannot be compared."
              }
            >
              <Select
                value={capture}
                onValueChange={(value) =>
                  setCapture(value as "full" | "metadata")
                }
              >
                <SelectItem value="metadata">
                  No · save field names only
                </SelectItem>
                <SelectItem value="full">
                  Yes · save values for comparison
                </SelectItem>
              </Select>
            </Field>
          </div>
          <details className="watch-advanced">
            <summary>
              Optional settings: groups, notifications, and privacy
            </summary>
            <div className="form-grid">
              <Field label="Watch group (optional)">
                <input
                  value={groupName}
                  maxLength={80}
                  placeholder="Checkout investigation"
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </Field>
              <Field label="Stop automatically">
                <Select value={duration} onValueChange={setDuration}>
                  <SelectItem value="">Until stopped</SelectItem>
                  <SelectItem value="60">After 1 minute</SelectItem>
                  <SelectItem value="600">After 10 minutes</SelectItem>
                  <SelectItem value="3600">After 1 hour</SelectItem>
                </Select>
              </Field>
            </div>
            <Field
              label="Columns to ignore"
              hint="Enter column names separated by commas. Changes to these columns are not detected or saved."
            >
              <input
                value={excluded}
                onChange={(e) => setExcluded(e.target.value)}
              />
            </Field>
            <label className="check-row">
              <Checkbox
                checked={notifications}
                onCheckedChange={(checked) => setNotifications(checked)}
              />
              Notify in app when changes are observed
            </label>
          </details>
          {production && capture === "full" && (
            <label className="check-row notice">
              <Checkbox
                required
                checked={consent}
                onCheckedChange={(checked) => setConsent(checked)}
              />
              I authorize storing captured production values locally.
            </label>
          )}
          {existing && (
            <p className="notice">
              Saving settings pauses this watch. Choose Start watching to begin
              again. The first check reads the starting values; only later
              changes are saved.
            </p>
          )}
          <p className="muted small">
            Keep Kitsune open while watching. Changes between checks can be
            missed. Each check can read up to 1,000 rows and 5 MiB.
          </p>
        </fieldset>
        {error && <ErrorState error={error} />}
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void save(false)}
          >
            Save without starting
          </Button>
          <Button
            disabled={
              busy || !workspace.activeConnections.includes(connectionId)
            }
          >
            <Play size={13} />
            {busy ? "Saving…" : "Start watching"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
export function WatchWorkspace() {
  const workspace = useWorkspace();
  const watches = useRemote<Watch[]>(
    "watches",
    {},
    workspace.tabs.find((t) => t.id === workspace.activeTab)?.kind ===
      "watches",
    2500,
  );
  const [groupFilter, setGroupFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<Watch>();
  const [deleting, setDeleting] = useState<Watch>();
  const watch =
    watches.data?.find(
      (w) => w.id === selected && (!groupFilter || w.groupName === groupFilter),
    ) || watches.data?.find((w) => !groupFilter || w.groupName === groupFilter);
  const selectedId = watch?.id || "";
  const events = useRemote<ChangeEvent[]>(
    "events",
    { watchId: selectedId || null, limit: 40 },
    !!selectedId &&
      workspace.tabs.find((t) => t.id === workspace.activeTab)?.kind ===
        "watches",
    2500,
  );
  async function groupAction(action: "resume" | "pause") {
    setBusy("group");
    try {
      const r = await api<{
        completed: number;
        errors: { name: string; error: { message: string } }[];
      }>("watch_group_action", { group: groupFilter, action });
      notify(
        `${r.completed} watches ${action === "resume" ? "resumed" : "paused"}${r.errors.length ? `; ${r.errors.map((e) => `${e.name}: ${e.error.message}`).join("; ")}` : ""}`,
        !!r.errors.length,
      );
      update({ watches: await api<Watch[]>("watches") });
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy("");
      void watches.refresh();
    }
  }
  async function action(w: Watch, action: string) {
    setBusy(w.id);
    try {
      await api("watch_action", { id: w.id, action });
      await watches.refresh();
      update({ watches: await api<Watch[]>("watches") });
      notify(
        `Watch ${action === "delete" ? "deleted" : action === "pause" ? "paused" : action === "stop" ? "stopped" : "started"}`,
      );
      setDeleting(undefined);
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="workspace-page">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">Investigation mode / Observe</div>
          <h1>
            <Eye size={20} />
            Live Watch
            <Tag>
              {watches.data?.filter((w) => w.status === "running").length || 0}{" "}
              watching
            </Tag>
          </h1>
        </div>
        <div className="spacer" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void watches.refresh()}
          aria-label="Refresh watches"
        >
          <RefreshCw size={14} /> Refresh
        </Button>
        <Button
          size="sm"
          disabled={!workspace.activeConnection}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("kitsune:watch", {
                detail: {
                  connectionId: workspace.activeConnection,
                  kind: "query",
                },
              }),
            )
          }
        >
          <Plus size={14} />
          New watch
        </Button>
      </div>
      <div className="page-description">
        Observe what changes. Gaps, pauses and recovery are recorded in Time
        Machine.
        <span>
          <ShieldCheck size={13} />
          Read-only polling
        </span>
      </div>
      <WorkflowHelp title="capture changes for Time Machine">
        <p>
          Start a watch and wait for its first observation to establish a
          baseline. Then change data from your application or SQL tab. The next
          poll records the difference.
        </p>
        <p>
          Set Save record values on this device? to Yes to keep values. For
          query watches, choose a row identity table and include its unique key
          columns. Without row identity, changes appear as rows entering and
          leaving the result.
        </p>
        <p>
          Pausing, reconnecting, or changing settings starts a fresh baseline
          when resumed. Changes between polls or while the app is closed are not
          recorded.
        </p>
      </WorkflowHelp>
      {watches.error && (
        <ErrorState
          error={watches.error}
          retry={() => void watches.refresh()}
        />
      )}{" "}
      {watches.loading && !watches.data ? (
        <Loading />
      ) : !watches.data?.length ? (
        <Empty
          icon={<Eye size={28} />}
          title="Keep an eye on your data"
          detail="Monitor a record, table, or query to detect changes. Start from a record or create a query watch."
        />
      ) : (
        <div className="watch-layout">
          <div className="watch-list">
            <div className="watch-group-controls">
              <Select
                aria-label="Watch group"
                value={groupFilter}
                onValueChange={setGroupFilter}
              >
                <SelectItem value="">All groups</SelectItem>
                {[
                  ...new Set(
                    watches.data.map((w) => w.groupName).filter(Boolean),
                  ),
                ].map((group) => (
                  <SelectItem value={group} key={group}>
                    {group}
                  </SelectItem>
                ))}
              </Select>
              {groupFilter && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => void groupAction("resume")}
                  >
                    Resume group
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => void groupAction("pause")}
                  >
                    Pause group
                  </Button>
                </>
              )}
            </div>
            {watches.data
              .filter((w) => !groupFilter || w.groupName === groupFilter)
              .map((w) => (
                <button
                  key={w.id}
                  className={`watch-card ${selectedId === w.id ? "selected" : ""}`}
                  onClick={() => setSelected(w.id)}
                >
                  <div>
                    <span
                      className={`connection-dot ${w.status === "running" ? "online" : w.status === "error" ? "failed" : ""}`}
                    />
                    <strong>{w.name}</strong>
                    <Tag tone={w.status === "error" ? "danger" : ""}>
                      {w.status}
                    </Tag>
                  </div>
                  <p>
                    {
                      workspace.connections.find((c) => c.id === w.connectionId)
                        ?.name
                    }{" "}
                    / {w.table?.name || "SQL query"}
                  </p>
                  <div className="watch-card-meta">
                    <span>
                      <Clock3 size={12} />
                      {w.intervalSeconds}s interval
                    </span>
                    {w.groupName && <span>{w.groupName}</span>}
                    {w.deadlineAt && w.status === "running" && (
                      <span>
                        Stops {new Date(w.deadlineAt).toLocaleTimeString()}
                      </span>
                    )}
                    <span>{w.eventCount} events</span>
                    <span>
                      {w.capture === "metadata"
                        ? "Metadata only"
                        : "Full capture"}
                    </span>
                  </div>
                  {w.lastError && (
                    <small className="danger-text">{w.lastError}</small>
                  )}
                </button>
              ))}
          </div>
          <div className="watch-detail">
            {watch ? (
              <>
                <div className="detail-heading">
                  <h2>{watch.name}</h2>
                  <div className="spacer" />
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Configure watch"
                    onClick={() => setEditing(watch)}
                  >
                    <Settings2 size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Delete watch"
                    onClick={() => setDeleting(watch)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                {!workspace.activeConnections.includes(watch.connectionId) && (
                  <p className="notice">
                    Reconnect this database from the sidebar to start watching.
                  </p>
                )}
                {!watch.lastObserved && (
                  <p className="notice">
                    No baseline captured yet. Start the watch and wait for the
                    first successful check.
                  </p>
                )}
                {watch.status === "paused" && (
                  <p className="muted small">
                    Paused. Changes during this gap are not recorded.
                  </p>
                )}
                {events.error && (
                  <ErrorState
                    error={events.error}
                    retry={() => void events.refresh()}
                  />
                )}
                <div className="watch-controls">
                  <Button
                    size="sm"
                    disabled={
                      busy === watch.id ||
                      !workspace.activeConnections.includes(watch.connectionId)
                    }
                    onClick={() =>
                      void action(
                        watch,
                        watch.status === "running" ? "pause" : "resume",
                      )
                    }
                  >
                    {watch.status === "running" ? (
                      <Pause size={13} />
                    ) : (
                      <Play size={13} />
                    )}{" "}
                    {watch.status === "running"
                      ? "Pause"
                      : watch.status === "paused"
                        ? "Resume"
                        : watch.status === "error"
                          ? "Retry now"
                          : "Start watching"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === watch.id || watch.status === "stopped"}
                    onClick={() => void action(watch, "stop")}
                  >
                    <Square size={12} />
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      openTab({
                        kind: "timeline",
                        title: `${watch.name} history`,
                        watchId: watch.id,
                      })
                    }
                  >
                    <History size={14} />
                    Time Machine
                  </Button>
                </div>
                <div className="watch-facts">
                  <div>
                    <span>Last observation</span>
                    <strong>
                      {watch.lastObserved
                        ? new Date(watch.lastObserved).toLocaleString()
                        : "Waiting for first observation"}
                    </strong>
                  </div>
                  <div>
                    <span>Capture</span>
                    <strong>
                      {watch.capture === "full"
                        ? "Before / after values"
                        : "Change metadata only"}
                    </strong>
                  </div>
                  <div>
                    <span>Excluded columns</span>
                    <strong>
                      {watch.excludedColumns.join(", ") || "None configured"}
                    </strong>
                  </div>
                </div>
                {watch.lastError && <ErrorState error={watch.lastError} />}{" "}
                {watch.kind === "query" && (
                  <pre className="sql-preview">{watch.sql}</pre>
                )}
                {watch.table && Object.keys(watch.key).length > 0 && (
                  <div className="watch-controls">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        inspectInTable({
                          connectionId: watch.connectionId,
                          table: watch.table!,
                          key: watch.key,
                        })
                      }
                    >
                      <TableIcon />
                      Open record
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        openTab({
                          kind: "investigation",
                          title: `Investigate ${watch.table!.name}`,
                          connectionId: watch.connectionId,
                          root: {
                            connectionId: watch.connectionId,
                            table: watch.table!,
                            key: watch.key,
                          },
                        })
                      }
                    >
                      <Network size={14} />
                      Investigate
                    </Button>
                  </div>
                )}
                <div className="section-label">Recent observations</div>
                {events.data?.length ? (
                  events.data.slice(0, 12).map((e) => (
                    <div className="recent-event-actions" key={e.id}>
                      <button
                        className="recent-event"
                        key={e.id}
                        onClick={() =>
                          openTab({
                            kind: "timeline",
                            title: `${watch.name} history`,
                            watchId: watch.id,
                          })
                        }
                      >
                        <span className="event-dot" />
                        <div>
                          <strong>{humanEvent(e.eventType)}</strong>
                          <small>
                            {new Date(e.observedAt).toLocaleString()}
                          </small>
                        </div>
                        <ArrowRight size={14} />
                      </button>
                      <RestoreEvent event={e} />
                    </div>
                  ))
                ) : (
                  <p className="muted pad">
                    No changes have been captured yet.
                  </p>
                )}
              </>
            ) : (
              <Empty
                icon={<Eye size={25} />}
                title="Select a watch"
                detail="Inspect its status, controls, and recent changes."
              />
            )}
          </div>
        </div>
      )}
      {editing && (
        <WatchDialog
          target={{ existing: editing }}
          onClose={() => {
            setEditing(undefined);
            void watches.refresh();
          }}
        />
      )}{" "}
      {deleting && (
        <Dialog
          open
          onClose={() => setDeleting(undefined)}
          title="Delete watch?"
          description={`This removes “${deleting.name}” and all its captured history.`}
        >
          <footer>
            <Button variant="secondary" onClick={() => setDeleting(undefined)}>
              Keep watch
            </Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() => void action(deleting, "delete")}
            >
              <Trash2 size={14} />
              Delete watch
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
function TableIcon() {
  return <Table2 size={14} />;
}
export function humanEvent(kind: string) {
  return (
    (
      {
        recordAppeared: "Record appeared",
        recordChanged: "Record changed",
        recordDisappeared: "Record disappeared",
        resultEntered: "Row entered result",
        resultLeft: "Row left result",
        watchStarted: "Watch started",
        baselineCaptured: "Baseline ready",
        watchStopped: "Watch stopped",
        observationFailed: "Observation failed",
        observationRecovered: "Observation recovered",
      } as Record<string, string>
    )[kind] || kind
  );
}
export function TimelineWorkspace({ tab }: { tab: Tab }) {
  const active = useWorkspace().activeTab === tab.id;
  const [watchId, setWatchId] = useState(tab.watchId || "");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("data");
  const [selectedId, setSelectedId] = useState("");
  const [clearing, setClearing] = useState(false);
  const [limit, setLimit] = useState(300);
  const [fullState, setFullState] = useState(false);
  const [compareId, setCompareId] = useState("");
  const [offsets, setOffsets] = useState([0]);
  const events = useRemote<ChangeEvent[]>(
    "events",
    {
      watchId: watchId || null,
      limit,
      offset: offsets[offsets.length - 1] || 0,
    },
    active,
    3000,
  );
  const watches = useRemote<Watch[]>("watches", {});
  const filtered =
    events.data?.filter(
      (e) =>
        (kind === "all" ||
          (kind === "data" ? isDataEvent(e) : !isDataEvent(e))) &&
        `${e.summary} ${e.eventType} ${e.changes.map((c) => c.column).join(" ")} ${watches.data?.find((w) => w.id === e.watchId)?.name}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) || [];
  const selected = filtered.find((e) => e.id === selectedId) || filtered[0];
  const sameRecord = (a: ChangeEvent, b: ChangeEvent) =>
    a.watchId === b.watchId &&
    !!a.record &&
    !!b.record &&
    JSON.stringify(a.record) === JSON.stringify(b.record);
  const comparisonOptions = selected
    ? (events.data || []).filter(
        (e) => e.id !== selected.id && e.afterState && sameRecord(e, selected),
      )
    : [];
  const compare = comparisonOptions.find((e) => e.id === compareId);
  const differences = selected
    ? fullState
      ? stateComparison(selected, compare)
      : selected.changes
    : [];
  const relatedWatch = watches.data?.find((w) => w.id === selected?.watchId);
  const currentRecord =
    selected?.record ||
    (relatedWatch?.kind === "record" && relatedWatch.table
      ? {
          connectionId: relatedWatch.connectionId,
          table: relatedWatch.table,
          key: relatedWatch.key,
        }
      : null);
  return (
    <div className="workspace-page">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">Investigation mode / Review</div>
          <h1>
            <History size={20} />
            Time Machine
          </h1>
        </div>
        <div className="spacer" />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openTab({ kind: "watches", title: "Live Watch" })}
        >
          <Eye size={14} /> Manage watches
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
          <Trash2 size={13} />
          Clear history
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={() => void events.refresh()}
          aria-label="Refresh timeline"
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      <div className="page-description">
        Start a Live Watch, wait for its baseline, then change data to compare
        observations.
        <span>
          <Clock3 size={13} />
          Observation timestamps
        </span>
      </div>
      <div className="timeline-filters">
        <input
          placeholder="Search event metadata…"
          aria-label="Search timeline"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="Filter by watch"
          value={watchId}
          onValueChange={(value) => {
            setWatchId(value);
            setOffsets([0]);
          }}
        >
          <SelectItem value="">All watches</SelectItem>
          {watches.data?.map((w) => (
            <SelectItem value={w.id} key={w.id}>
              {w.name}
            </SelectItem>
          ))}
        </Select>
        <Select
          aria-label="Event type"
          value={kind}
          onValueChange={(value) => setKind(value)}
        >
          <SelectItem value="all">All events</SelectItem>
          <SelectItem value="data">Data changes</SelectItem>
          <SelectItem value="lifecycle">Watch lifecycle</SelectItem>
        </Select>
      </div>
      {events.error && <ErrorState error={events.error} />}
      <div className="pagination">
        <span className="muted">
          Page {offsets.length} · newest observations first · bounded payloads
        </span>
        <div className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          disabled={offsets.length === 1 || events.loading}
          onClick={() => setOffsets((o) => o.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!events.data?.length || events.loading}
          onClick={() =>
            setOffsets((o) => [
              ...o,
              o[o.length - 1] + (events.data?.length || 0),
            ])
          }
        >
          Older
        </Button>
      </div>{" "}
      {events.loading && !events.data ? (
        <Loading />
      ) : !filtered.length ? (
        <Empty
          icon={<History size={28} />}
          title={
            events.data?.length ? "No matching data changes" : "No history yet"
          }
          detail={
            events.data?.length
              ? "Try All events to see watch status messages, clear your search, or browse older pages. To capture values, edit the watch and enable Save record values on this device?."
              : "Open Manage watches, start a watch, and wait for its first observation before changing data. Polling can miss changes between observations."
          }
        />
      ) : (
        <div className="timeline-layout">
          <div className="timeline-list">
            {filtered.map((e) => (
              <button
                className={`timeline-event ${selected?.id === e.id ? "selected" : ""}`}
                key={e.id}
                onClick={() => setSelectedId(e.id)}
              >
                <span
                  className={`event-dot ${e.eventType === "observationFailed" ? "failed" : ""}`}
                />
                <div>
                  <div>
                    <strong>{humanEvent(e.eventType)}</strong>
                    <time>{new Date(e.observedAt).toLocaleTimeString()}</time>
                  </div>
                  <p>
                    {watches.data?.find((w) => w.id === e.watchId)?.name ||
                      "Removed watch"}
                  </p>
                  <small>
                    {new Date(e.observedAt).toLocaleDateString()} ·{" "}
                    {e.changes.map((c) => c.column).join(", ") || e.summary}
                  </small>
                </div>
              </button>
            ))}
            {limit < 1000 && events.data && events.data.length >= limit && (
              <Button variant="ghost" size="sm" onClick={() => setLimit(1000)}>
                Load up to 1,000 events
              </Button>
            )}
          </div>
          {selected && (
            <div className="event-detail">
              <div className="detail-heading">
                <h2>{humanEvent(selected.eventType)}</h2>
                {isDataEvent(selected) && (
                  <RestoreEvent key={selected.id} event={selected} explain />
                )}
                <Tag>
                  {!isDataEvent(selected)
                    ? "Watch status"
                    : selected.capture === "metadata"
                      ? "Field names only"
                      : "Values captured"}
                </Tag>
              </div>
              <p className="muted">
                Observed {new Date(selected.observedAt).toLocaleString()}
              </p>
              <p className="small">{selected.summary}</p>
              <p className="context-note">{eventExplanation(selected)}</p>
              {relatedWatch && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("kitsune:watch", {
                        detail: { existing: relatedWatch },
                      }),
                    )
                  }
                >
                  <Settings2 size={14} /> Edit watch settings
                </Button>
              )}
              {isDataEvent(selected) &&
                selected.capture === "metadata" &&
                selected.changes.length > 0 && (
                  <div className="observed-fields">
                    <span className="muted">Changed fields</span>
                    {selected.changes.map((change) => (
                      <Tag key={change.column}>{change.column}</Tag>
                    ))}
                  </div>
                )}
              {selected.capture === "full" &&
                (selected.beforeState || selected.afterState) && (
                  <div className="state-comparison-controls">
                    <label className="check-row">
                      <Checkbox
                        checked={fullState}
                        onCheckedChange={(checked) => setFullState(checked)}
                      />
                      Compare all captured fields
                    </label>
                    {fullState && comparisonOptions.length > 0 && (
                      <Select
                        aria-label="Compare observed states"
                        value={compare?.id || ""}
                        onValueChange={(value) => setCompareId(value)}
                      >
                        <SelectItem value="">
                          Before this event → after this event
                        </SelectItem>
                        {comparisonOptions.map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            Observed {new Date(e.observedAt).toLocaleString()} →
                            selected state
                          </SelectItem>
                        ))}
                      </Select>
                    )}
                  </div>
                )}
              {isDataEvent(selected) &&
                selected.capture === "full" &&
                differences.length > 0 && (
                  <div className="diff-table">
                    <div className="diff-heading">
                      <span>Field</span>
                      <span>Before</span>
                      <span>After</span>
                    </div>
                    {differences.map((c, i) => (
                      <div
                        className={`diff-row ${equalValue(c.before, c.after) ? "diff-unchanged" : ""}`}
                        key={i}
                      >
                        <strong>{c.column}</strong>
                        {(["before", "after"] as const).map((side) =>
                          c[side] ? (
                            <Tooltip key={side} content={`Copy ${side} value`}>
                              <button
                                className={`diff-${side}`}
                                aria-label={`Copy ${c.column} ${side} value`}
                                onClick={() =>
                                  void copyFeedback(display(c[side]))
                                }
                              >
                                {c[side]?.kind === "text" &&
                                c[side]?.value === ""
                                  ? "(empty text)"
                                  : display(c[side]).slice(0, 500)}
                              </button>
                            </Tooltip>
                          ) : (
                            <span key={side} className="diff-missing">
                              {compare
                                ? "Not captured"
                                : missingStateLabel(selected, side)}
                            </span>
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                )}
              {currentRecord && (
                <div className="watch-controls">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => inspectInTable(currentRecord!)}
                  >
                    <ArrowRight size={13} />
                    Open current record
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      openTab({
                        kind: "investigation",
                        title: `Investigate ${currentRecord!.table.name}`,
                        connectionId: selected.connectionId,
                        root: currentRecord!,
                      })
                    }
                  >
                    <Network size={14} />
                    Investigate
                  </Button>
                </div>
              )}
              <p className="muted small">
                This is an observed state, not a transaction log. Intermediate
                changes may be missing.
              </p>
            </div>
          )}
        </div>
      )}
      {clearing && (
        <Dialog
          open
          onClose={() => setClearing(false)}
          title="Clear captured history?"
          description={`Permanently remove ${watchId ? "this watch’s" : "all"} captured events. Watch definitions remain.`}
        >
          <footer>
            <Button variant="secondary" onClick={() => setClearing(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void api("clear_events", { watchId: watchId || null })
                  .then(() => {
                    setClearing(false);
                    void events.refresh();
                    notify("Captured history cleared");
                  })
                  .catch((e) => notify(errorMessage(e), true));
              }}
            >
              Clear history
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
