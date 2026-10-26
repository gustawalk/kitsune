import { THEME_IDS } from "./themes";
import { z } from "zod";
const value = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("null") }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({
    kind: z.enum([
      "integer",
      "decimal",
      "float",
      "text",
      "binary",
      "json",
      "date",
      "timestamp",
      "uuid",
      "array",
      "unknown",
    ]),
    value: z.string(),
  }),
]);
const table = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.string(),
});
const record = z.object({
  connectionId: z.string(),
  table,
  key: z.record(z.string(), value),
});
const filter = z.object({ column: z.string(), operator: z.string(), value });
const connection = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.enum(["sqlite", "postgres", "mysql", "mssql"]),
  environment: z.enum(["development", "staging", "production", "custom"]),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  database: z.string(),
  username: z.string(),
  sslMode: z.string(),
  tlsCaPath: z.string().default(""),
  tlsCertPath: z.string().default(""),
  tlsKeyPath: z.string().default(""),
  path: z.string(),
  readOnly: z.boolean(),
  create: z.boolean(),
});
const result = z
  .object({
    columns: z.array(z.string()),
    types: z.array(z.string()),
    rows: z.array(z.array(value)),
    affected: z.number(),
    durationMs: z.number(),
    truncated: z.boolean(),
  })
  .refine(
    (r) => r.rows.every((row) => row.length === r.columns.length),
    "Result rows do not match columns",
  );
const metadata = z.object({
  table,
  columns: z.array(
    z.object({
      name: z.string(),
      dataType: z.string(),
      nullable: z.boolean(),
      defaultValue: z.string().nullable(),
      pk: z.number(),
    }),
  ),
  foreignKeys: z.array(
    z.object({
      name: z.string(),
      from: table,
      to: table,
      columns: z.array(z.string()),
      targetColumns: z.array(z.string()),
    }),
  ),
  indexes: z.array(
    z.object({
      name: z.string(),
      unique: z.boolean(),
      partial: z.boolean(),
      columns: z.array(z.string()),
    }),
  ),
});
const filterGroup = z.object({
  mode: z.enum(["all", "any"]),
  filters: z.array(filter).max(100),
});
const watch = z.object({
  filterGroups: z.array(filterGroup).default([]),
  groupMode: z.enum(["all", "any"]).default("all"),
  groupName: z.string().default(""),
  durationSeconds: z.number().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  deadlineAt: z.string().nullable().default(null),
  id: z.string(),
  name: z.string(),
  connectionId: z.string(),
  kind: z.enum(["record", "table", "query"]),
  table: table.nullable(),
  key: z.record(z.string(), value),
  filters: z.array(filter),
  sql: z.string(),
  intervalSeconds: z.number(),
  capture: z.enum(["metadata", "full"]),
  productionCaptureAuthorized: z.boolean(),
  excludedColumns: z.array(z.string()),
  notifications: z.boolean(),
  status: z.string(),
  lastObserved: z.string().nullable(),
  lastError: z.string().nullable(),
  eventCount: z.number(),
});
const graph = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        record,
        x: z.number().finite(),
        y: z.number().finite(),
        depth: z.number(),
        label: z.string().optional(),
      }),
    )
    .max(200),
  edges: z
    .array(z.object({ from: z.string(), to: z.string(), label: z.string() }))
    .max(10000),
  selected: z.string(),
});
const investigation = z.object({
  id: z.string(),
  name: z.string(),
  root: record,
  graph,
});
const tab = z.object({
  id: z.string(),
  kind: z.enum([
    "query",
    "table",
    "structure",
    "schema",
    "investigation",
    "watches",
    "timeline",
    "settings",
    "history",
  ]),
  title: z.string(),
  connectionId: z.string().optional(),
  table: table.optional(),
  schemaTable: table.optional(),
  sql: z.string().optional(),
  savedSql: z.string().optional(),
  filters: z.array(filter).optional(),
  filterGroups: z.array(filterGroup).optional(),
  groupMode: z.enum(["all", "any"]).optional(),
  root: record.optional(),
  investigation: investigation.optional(),
  watchId: z.string().optional(),
});
const settings = z.object({
  theme: z.enum(THEME_IDS),
  density: z.enum(["compact", "comfortable"]),
  pageSize: z.number().int().min(10).max(1000),
  rowLimit: z.number().int().min(1).max(10000),
  queryTimeout: z.number().int().min(1).max(300),
  pollInterval: z.number().int().min(2).max(3600),
  retentionDays: z.number().int().min(1).max(3650),
  maxEvents: z.number().int().min(1).max(100000),
  storageMiB: z.number().int().min(1).max(2048),
  queryHistory: z.boolean(),
  restoreTabs: z.boolean(),
  editorFontSize: z.number().min(10).max(24),
  editorTabSize: z.number().min(1).max(8),
  editorWrap: z.boolean(),
  sensitiveColumns: z.string(),
});
const event = z.object({
  restoreSource: z
    .object({
      watchKind: z.string(),
      schemaFingerprint: z.string(),
      complete: z.boolean(),
    })
    .nullable()
    .optional(),
  id: z.string(),
  watchId: z.string(),
  connectionId: z.string(),
  observedAt: z.string(),
  eventType: z.string(),
  summary: z.string(),
  changes: z.array(
    z.object({
      column: z.string(),
      before: value.nullable(),
      after: value.nullable(),
    }),
  ),
  record: record.nullable(),
  beforeState: z.array(z.object({ column: z.string(), value })).nullable(),
  afterState: z.array(z.object({ column: z.string(), value })).nullable(),
  capture: z.string(),
});
const schemas: Record<string, z.ZodType> = {
  sql_completion: z.array(
    z.object({
      label: z.string(),
      parts: z.array(z.string()).min(1),
      kind: z.string(),
      detail: z.string(),
    }),
  ),
  watch_group_action: z.object({
    completed: z.number().int().nonnegative(),
    errors: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ),
  }),
  export_table: z.discriminatedUnion("cancelled", [
    z.object({ cancelled: z.literal(true) }),
    z.object({
      cancelled: z.literal(false),
      rows: z.number().int().nonnegative(),
      limited: z.boolean(),
      path: z.string(),
    }),
  ]),
  diagnose_query: z.object({
    engine: z.enum(["sqlite", "postgres", "mysql", "mssql"]),
    mode: z.enum(["estimate", "measure"]),
    plan: result,
    structuredPlan: z.unknown(),
    elapsedMs: z.number(),
    measurementMs: z.number().nullable(),
    rowsConsumed: z.number().nullable(),
    complete: z.boolean().nullable(),
    costUnit: z.string().nullable(),
  }),
  restore_eligibility: z.union([
    z.object({
      eligible: z.literal(false),
      code: z.string(),
      reason: z.string(),
    }),
    z.object({
      eligible: z.literal(true),
      action: z.enum(["update", "insert", "delete"]),
      record,
      sql: z.string(),
      params: z.array(value),
      current: z.array(z.object({ column: z.string(), value })),
      proposed: z.array(z.object({ column: z.string(), value })),
      observationTimestamp: z.string(),
    }),
  ]),
  preview_restore: z.object({
    eligible: z.literal(true),
    token: z.string(),
    action: z.enum(["update", "insert", "delete"]),
    record,
    sql: z.string(),
    params: z.array(value),
    current: z.array(z.object({ column: z.string(), value })),
    proposed: z.array(z.object({ column: z.string(), value })),
    observationTimestamp: z.string(),
  }),
  restore_receipt: z
    .object({
      eventId: z.string(),
      connectionId: z.string(),
      action: z.string(),
      restoredAt: z.string(),
    })
    .nullable(),
  commit_restore: z.object({
    success: z.literal(true),
    receipt: z.object({
      eventId: z.string(),
      connectionId: z.string(),
      action: z.string(),
      restoredAt: z.string(),
    }),
    warning: z.string().nullable(),
  }),
  preview_table_mutation: z.object({
    token: z.string(),
    sql: z.string(),
    params: z.array(value),
    expectedRows: z.number().int().min(1).max(500),
  }),
  commit_table_mutation: result,
  update_cell: z.object({ affected: z.literal(1) }),
  choose_sqlite_file: z.string().nullable(),
  choose_tls_file: z.string().nullable(),
  mysql_statement: z.object({ sql: z.string() }),
  editor_status: z.object({
    transactionState: z.enum(["idle", "active", "lost"]),
  }),
  completion: z.array(z.string()),
  record_sql: z.object({ sql: z.string(), params: z.array(value) }),
  bootstrap: z.object({
    connections: z.array(connection),
    active: z.array(z.string()),
    readOnly: z.record(z.boolean()),
    transactions: z.record(z.enum(["idle", "active", "lost"])).default({}),
    watches: z.array(watch),
    investigations: z.array(investigation),
    settings: settings.nullable(),
    workspace: z
      .object({
        tabs: z.array(tab).optional(),
        activeTab: z.string().optional(),
        activeConnection: z.string().optional(),
      })
      .nullable(),
    credentialStorage: z.string(),
  }),
  tables: z.array(table),
  schema_table: z.object({
    metadata,
    incoming: z.array(metadata.shape.foreignKeys.element),
    definition: z.string().nullable(),
  }),
  schema_batch: z.object({
    tables: z.array(metadata),
    errors: z.array(
      z.object({
        table,
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ),
  }),
  metadata,
  browse: result,
  record: z.object({
    metadata,
    result,
    relationships: z.array(
      z.object({
        foreignKey: metadata.shape.foreignKeys.element,
        direction: z.enum(["incoming", "outgoing"]),
      }),
    ),
  }),
  watches: z.array(watch),
  events: z.array(event),
  save_connection: connection,
  save_watch: watch,
  save_investigation: investigation,
  save_settings: settings,
  save_appearance: settings,
  execute: z.object({
    schemaChanged: z.boolean().optional(),
    transactionState: z.enum(["idle", "active", "lost"]).optional(),
    results: z.array(result),
    warning: z.string().nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    durationMs: z.number(),
  }),
};
export function validateResponse(method: string, response: unknown): unknown {
  const schema = schemas[method];
  if (!schema) return response;
  const result = schema.safeParse(response);
  if (!result.success)
    throw {
      code: "INVALID_RESPONSE",
      message:
        "Stored data or the backend response has an incompatible format. The original metadata was preserved.",
    };
  return result.data;
}
export {
  connection as connectionSchema,
  value as valueSchema,
  settings as settingsSchema,
};
