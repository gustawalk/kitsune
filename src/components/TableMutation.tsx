import { Checkbox } from "./ui/checkbox";
import { useState } from "react";
import { LoaderCircle, Plus, Trash2, Pencil, ArrowLeft } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Select, SelectItem } from "./ui/select";
import { Field, ErrorState } from "./shared";
import { api, errorMessage, invalidate } from "../lib/api";
import { notify } from "../lib/store";
import { editedValue, valueKindForColumn } from "../lib/editing";
import {
  identityColumns,
  display,
  qualified,
  rowKey,
  type DbValue,
  type Metadata,
  type ResultSet,
  type TableRef,
} from "../lib/types";
export type TableMutationKind = "insert" | "update" | "delete";
interface DraftField {
  mode: "default" | "value" | "null";
  text: string;
}
interface Review {
  token: string;
  sql: string;
  params: DbValue[];
  expectedRows: number;
}
export function TableMutation({
  kind,
  connectionId,
  connectionName,
  environment,
  table,
  metadata,
  result,
  indices,
  onClose,
  onSaved,
  onStage,
}: {
  kind: TableMutationKind;
  connectionId: string;
  connectionName: string;
  environment: string;
  table: TableRef;
  metadata: Metadata;
  result: ResultSet;
  indices: number[];
  onClose: () => void;
  onSaved: () => void;
  onStage?: (column: string, value: DbValue) => void;
}) {
  const [draft, setDraft] = useState<Record<string, DraftField>>({});
  const keys = identityColumns(metadata);
  const editable = metadata.columns.filter(
    (c) =>
      !keys.includes(c.name) && !c.pk && !/blob|bytea|\[\]/i.test(c.dataType),
  );
  const [column, setColumn] = useState(editable[0]?.name || "");
  const [text, setText] = useState("");
  const [nullValue, setNullValue] = useState(false);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title =
    kind === "insert"
      ? "New record"
      : kind === "delete"
        ? `Delete ${indices.length} selected rows`
        : `Edit ${indices.length} selected rows`;
  const field = metadata.columns.find((c) => c.name === column);
  const patch = (name: string, change: Partial<DraftField>) =>
    setDraft((d) => ({
      ...d,
      [name]: { ...(d[name] || { mode: "default", text: "" }), ...change },
    }));
  async function prepare() {
    setError("");
    setBusy(true);
    try {
      if (kind === "update" && onStage) {
        if (!field) throw new Error("Choose an editable field.");
        onStage(
          column,
          editedValue(valueKindForColumn(field.dataType), text, nullValue),
        );
        onClose();
        return;
      }
      const values: Record<string, DbValue> = {};
      if (kind === "insert")
        for (const c of metadata.columns) {
          const d = draft[c.name];
          if (d && d.mode !== "default")
            values[c.name] = editedValue(
              valueKindForColumn(c.dataType),
              d.text,
              d.mode === "null",
            );
        }
      if (kind === "update" && !field)
        throw new Error("Choose an editable field.");
      const rows =
        kind === "insert"
          ? []
          : indices.map((i) => ({
              key: rowKey(metadata, result.columns, result.rows[i]),
              ...(kind === "update"
                ? { before: result.rows[i][result.columns.indexOf(column)] }
                : {}),
            }));
      setReview(
        await api<Review>("preview_table_mutation", {
          connectionId,
          table,
          kind,
          rows,
          values,
          column: kind === "update" ? column : null,
          value:
            kind === "update"
              ? editedValue(
                  valueKindForColumn(field!.dataType),
                  text,
                  nullValue,
                )
              : null,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!review || busy) return;
    setError("");
    setBusy(true);
    try {
      const response = await api<ResultSet>("commit_table_mutation", {
        connectionId,
        token: review.token,
      });
      invalidate("browse");
      invalidate("record");
      notify(
        `${response.affected} ${kind === "insert" ? "record created" : kind === "delete" ? "rows deleted" : "rows updated"}`,
      );
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setReview(undefined);
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
      title={title}
      description={`${connectionName} · ${environment} · ${qualified(table)}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (review ? commit() : prepare());
        }}
      >
        {review ? (
          <>
            <p className="notice">
              Review the SQL before confirming. This operation targets{" "}
              {review.expectedRows}{" "}
              {kind === "insert" ? "new record" : "selected rows"}.{" "}
              {kind !== "insert" &&
                "All selected rows must match or the operation rolls back."}
            </p>
            {kind === "delete" && (
              <p className="notice">
                Deletion is permanent. Database triggers or cascading foreign
                keys can affect additional records. Kitsune does not estimate
                those effects.
              </p>
            )}
            <pre className="mutation-sql">{review.sql}</pre>
            <details className="mutation-values">
              <summary>Bound values ({review.params.length})</summary>
              {review.params.map((p, i) => (
                <div key={i}>
                  <code>{i + 1}</code>
                  <pre>{display(p).slice(0, 1000)}</pre>
                </div>
              ))}
            </details>
          </>
        ) : (
          <fieldset disabled={busy} className="connection-fields">
            {kind === "insert" ? (
              <>
                <p className="muted small">
                  Leave generated IDs and defaulted fields on Database default.
                  NULL and empty text are different. New records may fall
                  outside the current filter or page.
                </p>
                <div className="mutation-fields">
                  {metadata.columns.map((c) => {
                    const d = draft[c.name] || { mode: "default", text: "" };
                    return (
                      <div className="mutation-field" key={c.name}>
                        <div>
                          <strong>{c.name}</strong>
                          <small>
                            {c.dataType}
                            {c.pk ? " · key" : ""}
                            {c.nullable ? " · nullable" : ""}
                            {c.defaultValue
                              ? ` · default: ${c.defaultValue}`
                              : ""}
                          </small>
                        </div>
                        <Select
                          aria-label={`${c.name} input mode`}
                          value={d.mode}
                          onValueChange={(v) =>
                            patch(c.name, { mode: v as DraftField["mode"] })
                          }
                        >
                          <SelectItem value="default">
                            Database default
                          </SelectItem>
                          <SelectItem
                            value="value"
                            disabled={["binary", "array", "unknown"].includes(
                              valueKindForColumn(c.dataType),
                            )}
                          >
                            Set value
                          </SelectItem>
                          {c.nullable && (
                            <SelectItem value="null">NULL</SelectItem>
                          )}
                        </Select>
                        {d.mode === "value" && (
                          <textarea
                            aria-label={`${c.name} value`}
                            rows={2}
                            maxLength={1048576}
                            value={d.text}
                            onChange={(e) =>
                              patch(c.name, { text: e.target.value })
                            }
                            placeholder={
                              valueKindForColumn(c.dataType) === "boolean"
                                ? "true or false"
                                : "Value (empty text is allowed)"
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : kind === "update" ? (
              <>
                <p className="notice">
                  Set one field to the same value across {indices.length}{" "}
                  selected rows. These edits stay local until you use Apply
                  changes above the table.
                </p>
                <Field label="Field to change">
                  <Select
                    required
                    value={column}
                    onValueChange={(v) => {
                      setColumn(v);
                      setText("");
                      setNullValue(false);
                    }}
                  >
                    <SelectItem value="">Choose a field</SelectItem>
                    {editable.map((c) => (
                      <SelectItem value={c.name} key={c.name}>
                        {c.name} · {c.dataType}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
                <Field label="New value">
                  <textarea
                    autoFocus
                    disabled={nullValue}
                    rows={4}
                    maxLength={1048576}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </Field>
                {field?.nullable && (
                  <label className="check-row">
                    <Checkbox
                      checked={nullValue}
                      onCheckedChange={(checked) => setNullValue(checked)}
                    />
                    Set to NULL
                  </label>
                )}
              </>
            ) : (
              <p className="notice">
                You selected {indices.length} rows on this page. Deletion
                targets these record identities in their current state. Review
                the generated SQL before deleting.
              </p>
            )}
          </fieldset>
        )}
        {error && <ErrorState error={error} />}
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => (review ? setReview(undefined) : onClose())}
          >
            {review ? (
              <>
                <ArrowLeft size={14} />
                Back
              </>
            ) : (
              "Cancel"
            )}
          </Button>
          <Button
            disabled={busy}
            variant={kind === "delete" && review ? "destructive" : "default"}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : kind === "insert" ? (
              <Plus size={14} />
            ) : kind === "delete" ? (
              <Trash2 size={14} />
            ) : (
              <Pencil size={14} />
            )}{" "}
            {busy
              ? "Working…"
              : review
                ? kind === "delete"
                  ? "Confirm deletion"
                  : "Confirm changes"
                : kind === "update" && onStage
                  ? "Stage changes"
                  : "Review changes"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
