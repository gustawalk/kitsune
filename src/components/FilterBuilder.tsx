import { useEffect, useState } from "react";
import { z } from "zod";
import { Plus, Save, Trash2, X } from "lucide-react";
import { Select, SelectItem } from "./ui/select";
import { Button } from "./ui/button";
import { ErrorState } from "./shared";
import {
  display,
  type Filter,
  type FilterGroup,
  type Metadata,
} from "../lib/types";
import { editedValue, valueKindForColumn } from "../lib/editing";
import { useLayoutPreference } from "../lib/layout-preferences";
import { valueSchema } from "../lib/validation";
const groupSchema = z.object({
  mode: z.enum(["all", "any"]),
  filters: z
    .array(
      z.object({
        column: z.string(),
        operator: z.string(),
        value: valueSchema,
      }),
    )
    .max(100),
});
const presetsSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(80),
      groups: z.array(groupSchema).max(16),
      mode: z.enum(["all", "any"]),
    }),
  )
  .max(50);
export function FilterBuilder({
  metadata,
  driver,
  groups,
  mode,
  onApply,
  preferenceKey,
}: {
  metadata: Metadata;
  driver: string;
  groups: FilterGroup[];
  mode: string;
  onApply: (groups: FilterGroup[], mode: string) => void;
  preferenceKey: string;
}) {
  const emptyCondition = (): Filter => ({
    column: "",
    operator: "eq",
    value: { kind: "text", value: "" },
  });
  const [draft, setDraft] = useState<FilterGroup[]>(
    groups.length ? groups : [{ mode: "all", filters: [emptyCondition()] }],
  );
  const [join, setJoin] = useState(mode);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [presets, setPresets] = useLayoutPreference(
    preferenceKey,
    presetsSchema,
    [],
  );
  useEffect(() => {
    setDraft(
      groups.length ? groups : [{ mode: "all", filters: [emptyCondition()] }],
    );
    setJoin(mode);
  }, [groups, mode]);
  function patch(g: number, index: number, change: Partial<Filter>) {
    setDraft((old) =>
      old.map((group, i) =>
        i === g
          ? {
              ...group,
              filters: group.filters.map((filter, j) =>
                j === index ? { ...filter, ...change } : filter,
              ),
            }
          : group,
      ),
    );
  }
  function operatorsFor(columnName: string) {
    const column = metadata.columns.find((item) => item.name === columnName);
    const kind = column ? valueKindForColumn(column.dataType) : "text";
    const operators: [string, string][] = [
      ["eq", "="],
      ["ne", "≠"],
    ];
    if (["integer", "decimal", "float", "text"].includes(kind)) {
      operators.push(["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"]);
    }
    if (kind === "text") {
      operators.push(
        ["contains", "contains"],
        ["startsWith", "starts with"],
        ["endsWith", "ends with"],
        ["like", "LIKE pattern"],
        ["notLike", "NOT LIKE pattern"],
      );
      if (driver === "postgres") {
        operators.push(
          ["ilike", "case-insensitive LIKE"],
          ["notIlike", "case-insensitive NOT LIKE"],
        );
      }
    }
    operators.push(["null", "is NULL"], ["notNull", "is not NULL"]);
    return operators;
  }
  function checked() {
    return draft
      .map((g) => ({
        ...g,
        filters: g.filters.filter((f) =>
          f.operator === "null" || f.operator === "notNull"
            ? !!f.column
            : !!f.column && display(f.value) !== "",
        ),
      }))
      .filter((g) => g.filters.length)
      .map((g) => ({
        ...g,
        mode: g.mode as "all" | "any",
        filters: g.filters.map((f) => {
          const column = metadata.columns.find((c) => c.name === f.column);
          if (!column) throw new Error(`Column ${f.column} is unavailable.`);
          return {
            ...f,
            value:
              f.operator === "null" || f.operator === "notNull"
                ? { kind: "null" as const }
                : editedValue(
                    [
                      "contains",
                      "startsWith",
                      "endsWith",
                      "like",
                      "notLike",
                      "ilike",
                      "notIlike",
                    ].includes(f.operator)
                      ? "text"
                      : valueKindForColumn(column.dataType),
                    display(f.value),
                    false,
                  ),
          };
        }),
      }));
  }
  function apply() {
    try {
      const next = checked();
      setError("");
      onApply(next, join);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="filter-builder">
      <div className="filter-builder-toolbar">
        <strong>Match groups</strong>
        <Select
          aria-label="Join filter groups"
          value={join}
          onValueChange={setJoin}
        >
          <SelectItem value="all">All (AND)</SelectItem>
          <SelectItem value="any">Any (OR)</SelectItem>
        </Select>
        <Button
          size="sm"
          variant="secondary"
          disabled={draft.length >= 16}
          onClick={() =>
            setDraft([...draft, { mode: "all", filters: [emptyCondition()] }])
          }
        >
          <Plus size={12} />
          Add group
        </Button>
        <Button size="sm" onClick={apply}>
          Apply filters
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft([]);
            onApply([], "all");
          }}
        >
          Clear
        </Button>
      </div>
      {draft.map((group, g) => (
        <section className="filter-group" key={g}>
          <div className="filter-builder-toolbar">
            <span>Group {g + 1}</span>
            <Select
              aria-label={`Join conditions in group ${g + 1}`}
              value={group.mode}
              onValueChange={(value) =>
                setDraft((old) =>
                  old.map((v, i) => (i === g ? { ...v, mode: value } : v)),
                )
              }
            >
              <SelectItem value="all">All conditions</SelectItem>
              <SelectItem value="any">Any condition</SelectItem>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft((old) => old.filter((_, i) => i !== g))}
            >
              <Trash2 size={12} />
              Remove group
            </Button>
          </div>
          {group.filters.map((f, i) => (
            <div className="filter-condition" key={i}>
              <Select
                aria-label="Filter column"
                value={f.column}
                onValueChange={(column) =>
                  patch(g, i, {
                    column,
                    operator: "eq",
                    value: { kind: "text", value: "" },
                  })
                }
              >
                {metadata.columns.map((c) => (
                  <SelectItem value={c.name} key={c.name}>
                    {c.name} · {c.dataType}
                  </SelectItem>
                ))}
              </Select>
              <Select
                aria-label="Filter operator"
                value={f.operator}
                onValueChange={(operator) => patch(g, i, { operator })}
              >
                {operatorsFor(f.column).map(([value, label]) => (
                  <SelectItem value={value} key={value}>
                    {label}
                  </SelectItem>
                ))}
              </Select>
              <input
                aria-label="Filter value"
                disabled={f.operator === "null" || f.operator === "notNull"}
                value={f.value.kind === "null" ? "" : display(f.value)}
                onChange={(e) =>
                  patch(g, i, {
                    value: { kind: "text", value: e.target.value },
                  })
                }
              />
              <Button
                size="icon"
                variant="ghost"
                title="Remove condition"
                onClick={() =>
                  setDraft((old) =>
                    old.map((v, j) =>
                      j === g
                        ? { ...v, filters: v.filters.filter((_, n) => n !== i) }
                        : v,
                    ),
                  )
                }
              >
                <X size={12} />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={
              !metadata.columns.length ||
              draft.reduce((n, g) => n + g.filters.length, 0) >= 100
            }
            onClick={() =>
              setDraft((old) =>
                old.map((v, i) =>
                  i === g
                    ? {
                        ...v,
                        filters: [
                          ...v.filters,
                          {
                            column: metadata.columns[0].name,
                            operator: "eq",
                            value: { kind: "text", value: "" },
                          },
                        ],
                      }
                    : v,
                ),
              )
            }
          >
            <Plus size={12} />
            Add condition
          </Button>
        </section>
      ))}
      {error && <ErrorState error={error} />}
      <div className="filter-builder-toolbar">
        <input
          aria-label="Saved filter name"
          placeholder="Name this filter…"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!name.trim()}
          onClick={() => {
            try {
              const groups = checked();
              setPresets((old) =>
                [
                  ...old.filter((p) => p.name !== name.trim()),
                  { name: name.trim(), groups, mode: join as "all" | "any" },
                ].slice(-50),
              );
              setName("");
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <Save size={12} />
          Save filter locally
        </Button>
        <Select
          aria-label="Load saved filter"
          value=""
          placeholder="Load saved filter"
          onValueChange={(value) => {
            const p = presets.find((p) => p.name === value);
            if (p) {
              setDraft(p.groups);
              setJoin(p.mode);
              onApply(p.groups, p.mode);
            }
          }}
        >
          <SelectItem value="">Load saved filter</SelectItem>
          {presets.map((p) => (
            <SelectItem value={p.name} key={p.name}>
              {p.name}
            </SelectItem>
          ))}
        </Select>
        {presets.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setPresets([])}>
            Clear saved filters
          </Button>
        )}
      </div>
      <p className="muted small">
        Saved filters can contain sensitive values. They stay in Kitsune’s local
        metadata.
      </p>
    </div>
  );
}
