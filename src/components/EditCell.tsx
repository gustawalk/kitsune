import { Checkbox } from "./ui/checkbox";
import { useState } from "react";
import { Check } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Field, ErrorState } from "./shared";
import { errorMessage } from "../lib/api";
import {
  editedValue,
  valueKindForColumn,
  recordChanges,
  type FieldDraft,
  type CellChange,
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
  onStage,
}: {
  record: RecordRef;
  column: string;
  fields: EditableField[];
  connection: string;
  environment: string;
  onClose: () => void;
  onStage: (changes: CellChange[]) => void;
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
  const [error, setError] = useState("");
  const changed = recordChanges(fields, drafts);
  const patch = (name: string, update: Partial<FieldDraft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...d[name], ...update } }));
  function save() {
    if (!changed.length) return;
    setError("");
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
      onStage(changes);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <Dialog
      open
      wide
      onClose={onClose}
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
          Changes stay local. Edit other records, then use Apply changes above
          the table to save them all together.
        </p>
        <fieldset className="connection-fields record-edit-fields">
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
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!changed.length}>
            <Check size={14} />
            Stage changes{changed.length ? ` (${changed.length})` : ""}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
