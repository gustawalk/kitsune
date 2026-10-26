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
  MoreHorizontal,
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
  readableKey,
  type ChangeEvent,
  type Metadata,
  type RecordRef,
  type Tab,
  type TableRef,
  type Watch,
} from "../lib/types";
import { stateComparison, equalValue } from "../lib/timeline";
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
  const table = identityTable;
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
      description={`${connection?.name || "No connection"} · polling observations, not a transactional audit log`}
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
              <strong>
                {kind === "record"
                  ? "Follow one record"
                  : kind === "table"
                    ? "Follow a filtered group of records"
                    : "Follow the results of a query"}
              </strong>
              <p>
                Choose what to observe. Kitsune checks for changes without
                writing to your database.
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
            <Field label="Watch name">
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Watch type">
              <Select
                value={kind}
                disabled={!!target.key || !!existing}
                onValueChange={(value) => setKind(value as Watch["kind"])}
              >
                <SelectItem value="query">Query result</SelectItem>
                <SelectItem value="table">Filtered table</SelectItem>
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
            <Field
              label="Use table primary key for row identity (optional)"
              hint="Include every primary key column in the result. Duplicate keys are rejected; without a key Kitsune compares result membership."
            >
              <Select
                value={identityTable ? JSON.stringify(identityTable) : ""}
                onValueChange={(value) =>
                  setIdentityTable(
                    value ? (JSON.parse(value) as TableRef) : null,
                  )
                }
              >
                <SelectItem value="">
                  No identity table · compare result membership
                </SelectItem>
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
          {kind === "query" && (
            <Field
              label="Read-only SQL"
              hint="At most 1,000 rows and 5 MiB per observation. Avoid LIMIT windows if you need stable membership."
            >
              <textarea
                rows={5}
                placeholder="SELECT * FROM orders WHERE status = 'pending'"
                className="mono"
                required
                value={sql}
                onChange={(e) => setSql(e.target.value)}
              />
            </Field>
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
            <Field label="Polling interval (seconds)">
              <input
                type="number"
                min={2}
                max={3600}
                required
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </Field>
            <Field label="Historical capture">
              <Select
                value={capture}
                onValueChange={(value) =>
                  setCapture(value as "full" | "metadata")
                }
              >
                <SelectItem value="metadata">Change metadata only</SelectItem>
                <SelectItem value="full">Before and after values</SelectItem>
              </Select>
            </Field>
          </div>
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
          <details className="watch-advanced">
            <summary>Privacy and notifications</summary>
            <Field
              label="Excluded columns"
              hint="Exact column names, separated by commas. Excluded fields are neither compared nor saved."
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
              again with a fresh baseline.
            </p>
          )}
          <p className="muted small">
            The first check establishes a baseline. Pausing and resuming starts
            a new baseline; changes during the gap are not captured. Changes
            between polls may be missed. Times indicate when Kitsune observed
            the result. Oversized observations stop comparison.
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
            Save paused
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
          <RefreshCw size={14} />
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
  return <MoreHorizontal size={14} />;
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
  const [kind, setKind] = useState("all");
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
          (kind === "data"
            ? e.changes.length > 0 ||
              /Appeared|Disappeared|Entered|Left/.test(e.eventType)
            : !e.changes.length &&
              !/Appeared|Disappeared|Entered|Left/.test(e.eventType))) &&
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
        Changes Kitsune observed, with the context to understand them.
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
          title="No changes captured yet"
          detail="Start a watch to build a history of observed changes. Polling can miss changes between observations."
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
                <RestoreEvent key={selected.id} event={selected} />
                <Tag>
                  {selected.capture === "metadata"
                    ? "Metadata only"
                    : "Values captured"}
                </Tag>
              </div>
              <p className="muted">
                Observed {new Date(selected.observedAt).toLocaleString()}
              </p>
              <p className="small">{selected.summary}</p>
              {selected.capture === "metadata" && (
                <p className="notice">
                  Before and after values were not stored for this observation.
                </p>
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
              {differences.length > 0 && (
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
                      <Tooltip content={"Copy before value"}>
                        <button
                          className="diff-before"
                          onClick={() => void copyFeedback(display(c.before))}
                        >
                          {display(c.before).slice(0, 500)}
                        </button>
                      </Tooltip>
                      <Tooltip content={"Copy after value"}>
                        <button
                          className="diff-after"
                          onClick={() => void copyFeedback(display(c.after))}
                        >
                          {display(c.after).slice(0, 500)}
                        </button>
                      </Tooltip>
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
