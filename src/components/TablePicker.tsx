import { useState } from "react";
import { Select, SelectItem } from "./ui/select";
import { rankSearch } from "../lib/search";
import type { TableRef } from "../lib/types";

const tableLabel = (table: TableRef) =>
  [table.schema, table.name].filter(Boolean).join(".");

export function TablePicker({
  tables,
  value,
  onChange,
  disabled = false,
  label,
}: {
  tables: TableRef[];
  value: TableRef | null;
  onChange: (value: TableRef | null) => void;
  disabled?: boolean;
  label: string;
}) {
  const [search, setSearch] = useState("");
  const matches = rankSearch(tables, search, (t) => [t.name, tableLabel(t)]);
  // Keep the selected label visible even while searching for another table.
  const options =
    value &&
    !matches.some(
      (t) =>
        t.schema === value.schema &&
        t.name === value.name &&
        t.kind === value.kind,
    )
      ? [value, ...matches]
      : matches;
  return (
    <div className="table-picker">
      <input
        type="search"
        aria-label={`Search ${label.toLowerCase()}`}
        placeholder="Search tables by name or schema…"
        value={search}
        disabled={disabled}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Select
        required
        aria-label={label}
        disabled={disabled}
        value={value ? JSON.stringify(value) : ""}
        onValueChange={(v) => onChange(v ? (JSON.parse(v) as TableRef) : null)}
      >
        <SelectItem value="">Choose a table</SelectItem>
        {options.map((t) => (
          <SelectItem key={JSON.stringify(t)} value={JSON.stringify(t)}>
            {tableLabel(t)}
          </SelectItem>
        ))}
      </Select>
      {search && (
        <small className="muted" role="status">
          {matches.length
            ? `${matches.length} matching tables`
            : "No matching tables"}
        </small>
      )}
    </div>
  );
}
