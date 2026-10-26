import { Checkbox } from "./ui/checkbox";
import { useState } from "react";
import { LoaderCircle, Save } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Field, ErrorState } from "./shared";
import { Select, SelectItem } from "./ui/select";
import { api, errorMessage, invalidate } from "../lib/api";
import { notify } from "../lib/store";
import { editedValue } from "../lib/editing";
import {
  display,
  qualified,
  readableKey,
  type DbValue,
  type RecordRef,
} from "../lib/types";
export function EditCell({
  record,
  column,
  before,
  connection,
  environment,
  nullable,
  onClose,
  onSaved,
}: {
  record: RecordRef;
  column: string;
  before: DbValue;
  connection: string;
  environment: string;
  nullable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(
    before.kind === "null" ? "" : display(before),
  );
  const [kind, setKind] = useState<DbValue["kind"]>(
    before.kind === "null" ? "text" : before.kind,
  );
  const [isNull, setNull] = useState(before.kind === "null");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unchanged = isNull
    ? before.kind === "null"
    : before.kind !== "null" &&
      text === display(before) &&
      kind === before.kind;
  async function save() {
    if (busy || unchanged) return;
    setError("");
    setBusy(true);
    try {
      const value = editedValue(kind, text, isNull);
      await api("update_cell", {
        record,
        column,
        before,
        value,
        confirmed: true,
      });
      invalidate("browse");
      invalidate("record");
      notify("Value saved");
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
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Edit ${column}`}
      description={`${connection} · ${environment} · ${qualified(record.table)}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="notice mono">Record: {readableKey(record)}</p>
        <Field label="Current value">
          <pre className="edit-cell-before">
            {display(before).slice(0, 2000)}
          </pre>
        </Field>
        <fieldset disabled={busy} className="connection-fields">
          {before.kind === "null" && (
            <Field label="Value type">
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as DbValue["kind"])}
              >
                {["text", "integer", "decimal", "boolean", "json"].map((v) => (
                  <SelectItem key={v}>{v}</SelectItem>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="New value"
            hint="Only this cell will be updated. Saving checks that its current value still matches the one shown above."
          >
            <textarea
              autoFocus
              rows={5}
              className="mono"
              disabled={isNull}
              maxLength={1048576}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          {nullable && (
            <label className="check-row">
              <Checkbox
                checked={isNull}
                onCheckedChange={(checked) => setNull(checked)}
              />
              Set to NULL (different from empty text)
            </label>
          )}
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
          <Button disabled={busy || unchanged}>
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Save size={14} />
            )}
            Save value
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
