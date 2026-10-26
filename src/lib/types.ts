import type * as Contract from "./generated";
export type DbValue = Contract.Value;
export interface Connection extends Contract.ConnectionConfig {
  driver: "sqlite" | "postgres" | "mysql" | "mssql";
  environment: "development" | "staging" | "production" | "custom";
}
export type TableRef = Contract.TableRef;
export type Column = Contract.Column;
export type ForeignKey = Contract.ForeignKey;
export type Metadata = Contract.Metadata;
export type SchemaTable = Contract.SchemaTable;
export type SchemaBatch = Contract.SchemaBatch;
export type ResultSet = Contract.ResultSet;
export type Filter = Contract.Filter;
export type FilterGroup = Contract.FilterGroup;
export type RecordRef = Contract.RecordRef;
export interface Relationship {
  foreignKey: ForeignKey;
  direction: "incoming" | "outgoing";
}
export interface RecordData {
  metadata: Metadata;
  result: ResultSet;
  relationships: Relationship[];
}
export interface Watch extends Contract.Watch {
  kind: "record" | "table" | "query";
  capture: "metadata" | "full";
}
export type ChangeEvent = Contract.Event;
export interface GraphNode {
  id: string;
  record: RecordRef;
  x: number;
  y: number;
  depth: number;
  label?: string;
}
export interface GraphState {
  nodes: GraphNode[];
  edges: { from: string; to: string; label: string }[];
  selected: string;
}
export interface Investigation extends Omit<Contract.Investigation, "graph"> {
  graph: GraphState;
}
export interface Settings extends Omit<
  Contract.ApplicationSettings,
  "theme" | "density"
> {
  theme: import("./themes").ThemeId;
  density: "compact" | "comfortable";
}

export interface Tab {
  id: string;
  kind:
    | "query"
    | "table"
    | "structure"
    | "schema"
    | "investigation"
    | "watches"
    | "timeline"
    | "settings"
    | "history";
  title: string;
  connectionId?: string;
  table?: TableRef;
  schemaTable?: TableRef;
  sql?: string;
  savedSql?: string;
  boundParams?: DbValue[];
  filters?: Filter[];
  filterGroups?: FilterGroup[];
  groupMode?: string;
  root?: RecordRef;
  investigation?: Investigation;
  watchId?: string;
}
export interface Bootstrap {
  connections: Connection[];
  active: string[];
  readOnly: Record<string, boolean>;
  watches: Watch[];
  investigations: Investigation[];
  settings: Settings | null;
  workspace: {
    tabs?: Tab[];
    activeTab?: string;
    activeConnection?: string;
  } | null;
  credentialStorage: string;
}
export interface ApiError {
  code: string;
  message: string;
}
export interface Execution {
  warning?: string | null;
  results: ResultSet[];
  error: ApiError | null;
  durationMs: number;
}
export const defaults: Settings = {
  theme: "dark",
  density: "compact",
  pageSize: 100,
  rowLimit: 1000,
  queryTimeout: 30,
  pollInterval: 5,
  retentionDays: 30,
  maxEvents: 10000,
  storageMiB: 250,
  queryHistory: true,
  restoreTabs: true,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWrap: false,
  sensitiveColumns: "password,secret,token,private_key,ssn",
};
export const emptyConnection = (): Connection => ({
  id: "",
  name: "",
  driver: "postgres",
  environment: "development",
  host: "localhost",
  port: 5432,
  database: "",
  username: "",
  sslMode: "prefer",
  path: "",
  readOnly: false,
  create: false,
});
export function display(v: DbValue | undefined | null): string {
  if (!v) return "Not captured";
  if (v.kind === "null") return "NULL";
  if (v.kind === "binary")
    return `[binary · ${Math.floor((v.value.length * 3) / 4)} bytes]`;
  return String(v.value);
}
export function rowKey(
  metadata: Metadata,
  columns: string[],
  row: DbValue[],
): Record<string, DbValue> {
  const keys: Record<string, DbValue> = {};
  for (const column of identityColumns(metadata)) {
    if (columns.filter((c) => c === column).length !== 1) return {};
    const i = columns.indexOf(column);
    if (i < 0 || row[i].kind === "null") return {};
    keys[column] = row[i];
  }
  return keys;
}
export function identity(r: RecordRef): string {
  return JSON.stringify([
    r.connectionId,
    r.table.schema,
    r.table.name,
    Object.entries(r.key).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function qualified(t: TableRef): string {
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [t.schema, t.name].filter(Boolean).map(quote).join(".");
}
export function readableKey(r: RecordRef): string {
  return Object.entries(r.key)
    .map(([k, v]) => `${k}: ${display(v)}`)
    .join(" · ");
}

export function identityColumns(metadata: Metadata): string[] {
  const primary = metadata.columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk);
  if (primary.length) return primary.map((c) => c.name);
  return (
    metadata.indexes.find(
      (i) =>
        i.unique &&
        !i.partial &&
        i.columns.length > 0 &&
        i.columns.every((name) =>
          metadata.columns.some((c) => c.name === name && !c.nullable),
        ),
    )?.columns || []
  );
}

export function watchMatchesRecord(
  watch: Pick<Watch, "kind" | "connectionId" | "table" | "key">,
  record: RecordRef,
): boolean {
  return (
    watch.kind === "record" &&
    !!watch.table &&
    identity({
      connectionId: watch.connectionId,
      table: watch.table,
      key: watch.key,
    }) === identity(record)
  );
}

export type SqlCompletion = Contract.SqlCompletion;
