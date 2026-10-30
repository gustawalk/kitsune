import { useEffect, useRef, useState } from "react";
import { Undo2, Save, Square } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ErrorState, Loading, Tag } from "./shared";
import { api, errorMessage, invalidate, useRemote } from "../lib/api";
import { notify, useWorkspace } from "../lib/store";
import { display, type ChangeEvent, type DbValue } from "../lib/types";
interface Field {
  column: string;
  value: DbValue;
}
interface Preview {
  eligible: true;
  token: string;
  action: string;
  sql: string;
  params: DbValue[];
  current: Field[];
  proposed: Field[];
  observationTimestamp: string;
}
export function restoreBlockedReason(event: ChangeEvent): string | undefined {
  if (
    ![
      "recordChanged",
      "recordAppeared",
      "recordDisappeared",
      "resultEntered",
      "resultLeft",
    ].includes(event.eventType)
  )
    return "Watcher lifecycle events have no data state to restore.";
  if (event.capture !== "full")
    return "Values were not captured for this event.";
  if (!event.restoreSource)
    return "This event has no verified source table. Use a record/table watch, or a SELECT of direct columns from its schema-qualified table, then capture a new change.";
  if (!event.record) return "No reliable record identity was captured.";
  if (
    !["recordChanged", "recordAppeared", "recordDisappeared"].includes(
      event.eventType,
    )
  )
    return "Result membership is not proof of a database insert or delete.";
  if (
    event.eventType !== "recordChanged" &&
    (event.restoreSource.watchKind !== "record" ||
      !event.restoreSource.complete)
  )
    return "Record appearance/disappearance requires a complete Record Watch capture.";
}
export function RestoreEvent({
  event,
  explain = false,
}: {
  event: ChangeEvent;
  explain?: boolean;
}) {
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const receipt = useRemote<unknown>(
    "restore_receipt",
    { eventId: event.id },
    !!event.restoreSource,
  );
  const reason =
    restoreBlockedReason(event) ||
    (!workspace.activeConnections.includes(event.connectionId)
      ? "Reconnect this database to restore captured values."
      : workspace.readOnly[event.connectionId] !== false
        ? "Enable session write access explicitly before restoring data."
        : undefined);
  if (done || receipt.data) return <Tag>Restore applied</Tag>;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={!!reason}
        title={reason || "Review and restore captured values"}
        onClick={() => setOpen(true)}
      >
        <Undo2 size={13} />
        Restore…
      </Button>
      {explain && reason && (
        <span className="restore-blocked-reason">{reason}</span>
      )}
      {open && (
        <RestoreDialog
          event={event}
          onClose={() => setOpen(false)}
          onRestored={() => {
            setDone(true);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
function RestoreDialog({
  event,
  onClose,
  onRestored,
}: {
  event: ChangeEvent;
  onClose: () => void;
  onRestored: () => void;
}) {
  const workspace = useWorkspace();
  const connection = workspace.connections.find(
    (c) => c.id === event.connectionId,
  );
  const [preview, setPreview] = useState<Preview>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const operation = useRef("");
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    void api<Preview>("preview_restore", { eventId: event.id })
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [event.id, attempt]);
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setCommitting(true);
    setError("");
    operation.current = crypto.randomUUID();
    try {
      const result = await api<{ success: true; warning: string | null }>(
        "commit_restore",
        {
          connectionId: event.connectionId,
          token: preview.token,
          operationId: operation.current,
        },
      );
      invalidate("record");
      invalidate("browse");
      invalidate("restore_receipt");
      notify(
        result.warning ||
          "Captured state restored. The watch will observe the current data on its next poll.",
        !!result.warning,
      );
      onRestored();
    } catch (e) {
      setError(errorMessage(e));
      setPreview(undefined);
    } finally {
      setBusy(false);
      setCommitting(false);
      operation.current = "";
    }
  }
  function cancel() {
    setCancelled(true);
    void api("cancel_query", { operationId: operation.current }).catch((e) =>
      setError(errorMessage(e)),
    );
  }
  const columns = [
    ...new Set([
      ...(preview?.current || []).map((f) => f.column),
      ...(preview?.proposed || []).map((f) => f.column),
    ]),
  ];
  return (
    <Dialog
      open
      wide
      title="Restore captured state"
      description={`${connection?.name || "Database"} · ${connection?.environment || ""} · observed ${new Date(event.observedAt).toLocaleString()}`}
      onClose={() => (committing ? cancel() : onClose())}
    >
      <p className="notice">
        This restores captured row values, not the original transaction or
        changes missed between polls. Excluded fields remain untouched. Database
        checks run again at confirmation.
      </p>
      {busy && (
        <Loading
          label={
            cancelled
              ? "Cancellation requested; waiting for the database…"
              : committing
                ? "Restoring captured values…"
                : "Checking restore eligibility…"
          }
        />
      )}
      {error && (
        <ErrorState
          error={error}
          retry={busy ? undefined : () => setAttempt((a) => a + 1)}
        />
      )}
      {preview && (
        <>
          <Tag>
            {preview.action === "delete"
              ? "Delete appeared record"
              : preview.action === "insert"
                ? "Recreate disappeared record"
                : "Restore previous field values"}
          </Tag>
          <div className="diff-table">
            <div className="diff-heading">
              <span>Field</span>
              <span>Current</span>
              <span>Proposed</span>
            </div>
            {columns.map((column) => (
              <div className="diff-row" key={column}>
                <strong>{column}</strong>
                <code>
                  {display(
                    preview.current.find((f) => f.column === column)?.value,
                  ).slice(0, 1000)}
                </code>
                <code>
                  {display(
                    preview.proposed.find((f) => f.column === column)?.value,
                  ).slice(0, 1000)}
                </code>
              </div>
            ))}
          </div>
          <pre className="mutation-sql">{preview.sql}</pre>
          <details>
            <summary>Bound values</summary>
            <pre className="mutation-sql">
              {JSON.stringify(preview.params, null, 2)}
            </pre>
          </details>
        </>
      )}
      <footer>
        <Button
          variant="secondary"
          disabled={cancelled}
          onClick={() => (committing ? cancel() : onClose())}
        >
          {committing ? (
            <>
              <Square size={12} />
              Request cancellation
            </>
          ) : (
            "Cancel"
          )}
        </Button>
        <Button
          disabled={busy || !preview}
          variant={preview?.action === "delete" ? "destructive" : "default"}
          onClick={() => void commit()}
        >
          <Save size={14} />
          Confirm restore
        </Button>
      </footer>
    </Dialog>
  );
}
