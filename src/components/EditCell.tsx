import { Checkbox } from "./ui/checkbox";
import { useState } from "react";
import { LoaderCircle, Save } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Field, ErrorState } from "./shared";
import { api, errorMessage, invalidate } from "../lib/api";
import { notify } from "../lib/store";
import {
  editedValue,
  valueKindForColumn,
  recordChanges,
  type FieldDraft,
} from "../lib/editing";
import {
  display,
  qualified,
  readableKey,
  type DbValue,
  type RecordRef,
} from "../lib/types";
export interface EditableField {
  column: string;
  before: DbValue;
  nullable: boolean;
  dataType: string;
}
export function EditCell({
  record,
  column,
  fields,
  connection,
  environment,
  onClose,
  onSaved,
}: {
  record: RecordRef;
  column: string;
  fields: EditableField[];
  connection: string;
  environment: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.column,
        {
          text: f.before.kind === "null" ? "" : display(f.before),
          kind:
            f.before.kind === "null"
              ? valueKindForColumn(f.dataType)
              : f.before.kind,
          isNull: f.before.kind === "null",
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = recordChanges(fields, drafts);
  const patch = (name: string, update: Partial<FieldDraft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...d[name], ...update } }));
  async function save() {
    if (busy || !changed.length) return;
    setError("");
    setBusy(true);
    try {
      const changes = changed.map((f) => ({
        column: f.column,
        before: f.before,
        value: editedValue(
          drafts[f.column].kind,
          drafts[f.column].text,
          drafts[f.column].isNull,
        ),
      }));
      await api("update_cells", { record, changes, confirmed: true });
      invalidate("browse");
      invalidate("record");
      notify(
        `${changes.length} ${changes.length === 1 ? "value" : "values"} saved`,
      );
      onSaved();
      onClose();
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
      title="Edit record"
      description={`${connection} · ${environment} · ${qualified(record.table)}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="notice mono">Record: {readableKey(record)}</p>
        <p className="muted small">
          Edit multiple fields, then apply changes together. If a changed field
          no longer matches its original value, all changes roll back.
        </p>
        <fieldset
          disabled={busy}
          className="connection-fields record-edit-fields"
        >
          {fields.map((f) => {
            const d = drafts[f.column];
            return (
              <div className="record-edit-field" key={f.column}>
                <Field label={f.column} hint={f.dataType}>
                  <textarea
                    aria-label={`${f.column} value`}
                    autoFocus={f.column === column}
                    rows={2}
                    className="mono"
                    disabled={d.isNull}
                    maxLength={1048576}
                    value={d.text}
                    onChange={(e) => patch(f.column, { text: e.target.value })}
                  />
                </Field>
                {f.nullable && (
                  <label className="check-row">
                    <Checkbox
                      checked={d.isNull}
                      onCheckedChange={(checked) =>
                        patch(f.column, { isNull: checked })
                      }
                    />
                    Set {f.column} to NULL
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
        {error && <ErrorState error={error} />}
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || !changed.length}>
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Save size={14} />
            )}
            Apply changes{changed.length ? ` (${changed.length})` : ""}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
