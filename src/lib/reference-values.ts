import { z } from "zod";
import { relationshipKey } from "./schema";
import {
  display,
  type DbValue,
  type ForeignKey,
  type Metadata,
  type ResultSet,
} from "./types";

export const referencePreferencesSchema = z.record(
  z.object({
    relationship: z.string().min(1),
    column: z.string().min(1),
  }),
);
export type ReferencePreferences = z.infer<typeof referencePreferencesSchema>;
export type ReferenceLabels = Map<string, Array<string | undefined>>;
type Read = <T>(method: string, payload: unknown) => Promise<T>;

function tuple(row: DbValue[], columns: string[], names: string[]) {
  const values = names.map((name) => row[columns.indexOf(name)]);
  return values.every((v) => v && v.kind !== "null") ? values : null;
}
function tupleKey(values: DbValue[]) {
  return JSON.stringify(values);
}

// Display-only lookups. Source results and typed keys remain untouched.
export async function loadReferenceLabels(
  source: ResultSet,
  metadata: Metadata,
  preferences: ReferencePreferences,
  connectionId: string,
  read: Read,
  active = () => true,
  onProgress?: (column: string, labels: Array<string | undefined>) => void,
): Promise<ReferenceLabels> {
  const labels: ReferenceLabels = new Map();
  const keys = new Map<ForeignKey, Array<[string, string]>>();
  for (const [column, preference] of Object.entries(preferences)) {
    const fk = metadata.foreignKeys.find(
      (key) =>
        key.columns.includes(column) &&
        relationshipKey(key) === preference.relationship,
    );
    if (
      !fk ||
      !source.columns.includes(column) ||
      !fk.columns.length ||
      fk.columns.length !== fk.targetColumns.length
    )
      continue;
    keys.set(fk, [...(keys.get(fk) || []), [column, preference.column]]);
  }
  for (const [fk, selections] of keys) {
    if (!active()) break;
    const sourceKeys = source.rows.map((row) =>
      tuple(row, source.columns, fk.columns),
    );
    const unique = new Map<string, DbValue[]>();
    for (const values of sourceKeys)
      if (values) unique.set(tupleKey(values), values);
    if (!unique.size) continue;
    try {
      const target = await read<Metadata>("metadata", {
        connectionId,
        table: fk.to,
      });
      if (!active()) break;
      const fields = selections.filter(([, name]) =>
        target.columns.some((c) => c.name === name),
      );
      if (!fields.length) continue;
      const found = new Map<string, Map<string, string>>();
      const values = [...unique.values()];
      const batchSize = Math.min(16, Math.floor(100 / fk.columns.length));
      if (!batchSize) continue;
      for (let i = 0; i < values.length && active(); i += batchSize) {
        const batch = values.slice(i, i + batchSize);
        const result = await read<ResultSet>("browse", {
          connectionId,
          table: fk.to,
          filters: [],
          filterGroups: batch.map((key) => ({
            mode: "all",
            filters: fk.targetColumns.map((column, index) => ({
              column,
              operator: "eq",
              value: key[index],
            })),
          })),
          groupMode: "any",
          sort: "",
          descending: false,
          offset: 0,
          keyset: false,
          cursor: null,
          limit: batch.length,
        });
        if (!active()) break;
        for (const row of result.rows) {
          const key = tuple(row, result.columns, fk.targetColumns);
          if (!key) continue;
          const record = new Map<string, string>();
          for (const [, field] of fields) {
            const value = row[result.columns.indexOf(field)];
            if (value && value.kind !== "null" && display(value).trim())
              record.set(field, display(value));
          }
          found.set(tupleKey(key), record);
        }
        if (active() && onProgress)
          for (const [column, field] of fields)
            onProgress(
              column,
              sourceKeys.map((key) =>
                key ? found.get(tupleKey(key))?.get(field) : undefined,
              ),
            );
      }
      if (active())
        for (const [column, field] of fields)
          labels.set(
            column,
            sourceKeys.map((key) =>
              key ? found.get(tupleKey(key))?.get(field) : undefined,
            ),
          );
    } catch {
      // A label must never prevent browsing when target metadata or rows are unavailable.
    }
  }
  return labels;
}

// One cache per table page. A selection change only invalidates its own column.
export class ReferenceLabelCache {
  private entries = new Map<
    string,
    {
      signature: string;
      labels?: Array<string | undefined>;
    }
  >();
  private disposed = false;

  constructor(
    private source: ResultSet,
    private metadata: Metadata,
    private connectionId: string,
    private read: Read,
    private onChange: () => void,
  ) {}

  update(preferences: ReferencePreferences) {
    if (this.disposed) return;
    for (const [column, entry] of this.entries) {
      if (entry.signature !== JSON.stringify(preferences[column]))
        this.entries.delete(column);
    }
    for (const [column, preference] of Object.entries(preferences)) {
      if (this.entries.has(column)) continue;
      const entry = {
        signature: JSON.stringify(preference),
        labels: undefined as Array<string | undefined> | undefined,
      };
      this.entries.set(column, entry);
      const active = () => !this.disposed && this.entries.get(column) === entry;
      void loadReferenceLabels(
        this.source,
        this.metadata,
        { [column]: preference },
        this.connectionId,
        this.read,
        active,
        (_, labels) => {
          if (!active()) return;
          entry.labels = labels;
          this.onChange();
        },
      ).then((labels) => {
        if (!active() || entry.labels !== undefined) return;
        entry.labels = labels.get(column);
        this.onChange();
      });
    }
  }

  labels(preferences: ReferencePreferences): ReferenceLabels {
    const labels: ReferenceLabels = new Map();
    if (this.disposed) return labels;
    for (const [column, preference] of Object.entries(preferences)) {
      const entry = this.entries.get(column);
      if (entry?.signature === JSON.stringify(preference) && entry.labels)
        labels.set(column, entry.labels);
    }
    return labels;
  }

  dispose() {
    this.disposed = true;
    this.entries.clear();
  }
}
