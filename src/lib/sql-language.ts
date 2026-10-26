import {
  MSSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
} from "@codemirror/lang-sql";
import type { SqlDialect } from "./sql-portable";
export function editorDialect(dialect: SqlDialect) {
  switch (dialect) {
    case "mssql":
      return MSSQL;
    case "mysql":
      return MySQL;
    case "postgres":
      return PostgreSQL;
    case "sqlite":
      return SQLite;
    default:
      return StandardSQL;
  }
}
