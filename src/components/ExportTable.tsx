import { useRef, useState } from "react";
import { Download, Square } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Select, SelectItem } from "./ui/select";
import { Field, ErrorState } from "./shared";
import { api, errorMessage } from "../lib/api";
import { notify } from "../lib/store";
import type { BrowseRequest } from "../lib/generated";
import type { Metadata } from "../lib/types";
export function ExportTable({
  request,
  metadata,
  visibleColumns,
  sensitiveColumns,
  onClose,
}: {
  request: BrowseRequest;
  metadata: Metadata;
  visibleColumns: string[];
  sensitiveColumns: string;
  onClose: () => void;
}) {
  const sensitive = (name: string) =>
    /password|secret|token|private_key|ssn/i.test(name) ||
    sensitiveColumns
      .split(",")
      .some((c) => c.trim().toLowerCase() === name.toLowerCase());
  const [columns, setColumns] = useState(
    metadata.columns
      .filter((c) => visibleColumns.includes(c.name) && !sensitive(c.name))
      .map((c) => c.name),
  );
  const [format, setFormat] = useState("csv");
  const [scope, setScope] = useState("page");
  const [limit, setLimit] = useState(1000);
  const [safe, setSafe] = useState(true);
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef("");
  async function exportData() {
    setBusy(true);
    setError("");
    operation.current = crypto.randomUUID();
    try {
      const page = request;
      const result = await api<{
        cancelled: boolean;
        rows?: number;
        limited?: boolean;
        path?: string;
      }>("export_table", {
        request: { ...page, offset: scope === "page" ? page.offset : 0 },
        columns,
        format,
        maxRows: scope === "page" ? page.limit : limit,
        spreadsheetSafe: safe,
        allowSensitive: allow,
        operationId: operation.current,
      });
      if (!result.cancelled)
        notify(
          `Exported ${result.rows} rows${result.limited ? " · configured bound reached" : ""} to ${result.path}`,
        );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      operation.current = "";
    }
  }
  function cancel() {
    if (operation.current)
      void api("cancel_query", { operationId: operation.current }).catch((e) =>
        setError(errorMessage(e)),
      );
  }
  return (
    <Dialog
      open
      wide
      title="Export table data"
      description="Choose columns and a bounded scope. The native Save dialog chooses the destination."
      onClose={() => (busy ? cancel() : onClose())}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void exportData();
        }}
      >
        <fieldset disabled={busy} className="connection-fields">
          <div className="form-grid">
            <Field label="Format">
              <Select value={format} onValueChange={setFormat}>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="json">Typed JSON (lossless)</SelectItem>
              </Select>
            </Field>
            <Field label="Scope">
              <Select value={scope} onValueChange={setScope}>
                <SelectItem value="page">Current page</SelectItem>
                <SelectItem value="filtered">
                  Filtered result, bounded
                </SelectItem>
              </Select>
            </Field>
          </div>
          {scope === "filtered" && (
            <Field label="Maximum rows">
              <input
                type="number"
                min={1}
                max={10000}
                required
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </Field>
          )}
          <p className="muted small">
            Exports use current database values in a read-only snapshot. No
            automatic COUNT or unlimited scan. Existing files are never
            replaced.
          </p>
          <div className="export-columns">
            {metadata.columns.map((c) => (
              <label className="check-row" key={c.name}>
                <Checkbox
                  checked={columns.includes(c.name)}
                  disabled={sensitive(c.name) && !allow}
                  onCheckedChange={(checked) =>
                    setColumns((old) =>
                      checked
                        ? [...old, c.name]
                        : old.filter((n) => n !== c.name),
                    )
                  }
                />
                {c.name}
                {sensitive(c.name) ? " · sensitive/excluded" : ""}
              </label>
            ))}
          </div>
          <label className="check-row">
            <Checkbox
              checked={allow}
              onCheckedChange={(value) => {
                setAllow(value);
                if (!value)
                  setColumns((old) => old.filter((n) => !sensitive(n)));
              }}
            />
            Authorize exporting sensitive/excluded columns
          </label>
          {format === "csv" && (
            <label className="check-row">
              <Checkbox checked={safe} onCheckedChange={setSafe} />
              Spreadsheet-safe text (prefix formula-like text with an
              apostrophe)
            </label>
          )}
          <p className="muted small">
            CSV uses unquoted \N for NULL and quotes non-null values. Choose
            typed JSON to preserve database types and large integers.
          </p>
        </fieldset>
        {error && <ErrorState error={error} />}
        <footer>
          <Button
            type="button"
            variant="secondary"
            onClick={() => (busy ? cancel() : onClose())}
          >
            {busy ? (
              <>
                <Square size={12} />
                Request cancellation
              </>
            ) : (
              "Cancel"
            )}
          </Button>
          <Button disabled={busy || !columns.length}>
            <Download size={13} />
            {busy
              ? "Choosing destination / exporting…"
              : "Choose destination and export"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
