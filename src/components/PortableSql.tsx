import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, FileCode2 } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Select, SelectItem } from "./ui/select";
import { Field } from "./shared";
import {
  quoteSqlName,
  SqlParseError,
  parsePortableSql,
  emitPortableSql,
  type SqlDialect,
} from "../lib/sql-portable";
import type { TableRef } from "../lib/types";
export function PortableSql({
  source,
  dialect,
  tables,
  onApply,
  onClose,
}: {
  source: string;
  dialect: SqlDialect;
  tables: TableRef[];
  onApply: (sql: string, parameterOrder: number[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(
    source.trim() || "SELECT *\nFROM your_table\nLIMIT 100;",
  );
  const [target, setTarget] = useState(dialect);
  const deferred = useDeferredValue(draft);
  const result = useMemo(() => {
    try {
      const parameterOrder: number[] = [];
      return {
        sql: emitPortableSql(
          parsePortableSql(deferred),
          target,
          parameterOrder,
        ),
        parameterOrder,
        error: "",
      };
    } catch (e) {
      const offset = e instanceof SqlParseError ? e.from : 0;
      const before = deferred.slice(0, offset),
        line = before.split("\n").length,
        column = offset - (before.lastIndexOf("\n") + 1) + 1;
      return {
        sql: "",
        error:
          (e instanceof SqlParseError
            ? `Line ${line}, column ${column}: `
            : "") + (e instanceof Error ? e.message : String(e)),
      };
    }
  }, [deferred, target]);
  return (
    <Dialog
      open
      wide
      title="Portable SQL"
      description="Write one SELECT, inspect the generated dialect, then open it as a new query. Nothing runs automatically."
      onClose={onClose}
    >
      <div className="portable-sql-controls">
        <Field label="Start from a table">
          <Select
            aria-label="Start portable query from table"
            value=""
            onValueChange={(key) => {
              const t = tables.find(
                (t) => JSON.stringify([t.schema, t.name]) === key,
              );
              if (t)
                setDraft(
                  `SELECT *\nFROM ${[t.schema, t.name]
                    .filter(Boolean)
                    .map((n) => quoteSqlName(n, target))
                    .join(".")}\nLIMIT 100;`,
                );
            }}
          >
            <SelectItem value="">Choose a table template</SelectItem>
            {tables.map((t) => (
              <SelectItem
                key={JSON.stringify([t.schema, t.name])}
                value={JSON.stringify([t.schema, t.name])}
              >
                {t.schema ? `${t.schema}.` : ""}
                {t.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
        <Field label="Target SQL dialect">
          <Select
            aria-label="Target SQL dialect"
            value={target}
            onValueChange={(v) => setTarget(v as SqlDialect)}
          >
            {[
              ["sqlite", "SQLite"],
              ["postgres", "PostgreSQL"],
              ["mysql", "MySQL / MariaDB"],
              ["duckdb", "DuckDB · SQL preview only"],
              ["mssql", "SQL Server"],
            ].map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
        </Field>
      </div>
      <div className="portable-sql-panes">
        <Field label="Portable SELECT">
          <textarea
            aria-label="Portable SQL source"
            className="portable-sql-input"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <Field label="Generated SQL">
          <pre className="portable-sql-output" tabIndex={0}>
            {result.sql || "Complete the query to preview target SQL."}
          </pre>
        </Field>
      </div>
      {result.error && (
        <p className="portable-sql-error" role="status">
          {result.error}
        </p>
      )}
      <p className="muted small">
        Supports projections, aliases, joins, predicates, common aggregates,
        grouping, ordering and paging. Native SQL remains available for CTEs,
        subqueries, writes and engine-specific functions. Collation, NULL
        ordering, types and arithmetic may behave differently across engines;
        review results on the target database.
      </p>
      <footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <div className="spacer" />
        <Button
          disabled={!result.sql || deferred !== draft || target !== dialect}
          title={
            target !== dialect
              ? "Choose the connected engine’s dialect to open an executable query."
              : undefined
          }
          onClick={() => onApply(result.sql, result.parameterOrder || [])}
        >
          <FileCode2 size={14} />
          Open as SQL tab
          <ArrowRight size={14} />
        </Button>
      </footer>
      {target !== dialect && (
        <p className="muted small">
          Previewing another dialect. Change back to your connection’s dialect
          to open the query.
        </p>
      )}
    </Dialog>
  );
}
