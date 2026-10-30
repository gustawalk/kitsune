import type { TableRef } from "./types";

/** A runnable starting point; no LIMIT that could disguise result membership. */
export function watchQueryExample(table: TableRef, driver: string) {
  const quote = (name: string) =>
    driver === "mysql"
      ? `\`${name.replace(/`/g, "``")}\``
      : driver === "mssql"
        ? `[${name.replace(/]/g, "]]")}]`
        : `"${name.replace(/"/g, '""')}"`;
  return `SELECT *\nFROM ${[table.schema, table.name].filter(Boolean).map(quote).join(".")};`;
}
