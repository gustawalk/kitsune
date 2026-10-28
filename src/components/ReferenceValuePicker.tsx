import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useRemote } from "../lib/api";
import { useLayoutPreference } from "../lib/layout-preferences";
import { relationshipKey, tableKey } from "../lib/schema";
import {
  ReferenceLabelCache,
  referencePreferencesSchema,
  type ReferencePreferences,
} from "../lib/reference-values";
import type { ForeignKey, Metadata, ResultSet } from "../lib/types";
import { Dialog } from "./ui/dialog";
import { Select, SelectItem } from "./ui/select";
import { ErrorState, Loading } from "./shared";

export function useReferenceDisplay(
  preferenceKey: string,
  connectionId: string,
  source: ResultSet | undefined,
  metadata: Metadata | undefined,
  enabled: boolean,
) {
  const [preferences, setPreferences] =
    useLayoutPreference<ReferencePreferences>(
      preferenceKey,
      referencePreferencesSchema,
      {},
    );
  const [, render] = useState(0);
  const current = useRef<
    | {
        source: ResultSet;
        metadata: Metadata;
        connectionId: string;
        cache: ReferenceLabelCache;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!enabled || !source || !metadata) {
      current.current?.cache.dispose();
      current.current = undefined;
      return;
    }
    if (
      current.current?.source !== source ||
      current.current?.metadata !== metadata ||
      current.current?.connectionId !== connectionId
    ) {
      current.current?.cache.dispose();
      current.current = {
        source,
        metadata,
        connectionId,
        cache: new ReferenceLabelCache(
          source,
          metadata,
          connectionId,
          api,
          () => render((n) => n + 1),
        ),
      };
    }
    current.current.cache.update(preferences);
  }, [enabled, source, metadata, preferences, connectionId]);
  useEffect(
    () => () => {
      current.current?.cache.dispose();
      current.current = undefined;
    },
    [],
  );
  const foreignKeys = useMemo(
    () =>
      new Map(
        Object.entries(preferences).flatMap(([column, preference]) => {
          const key = metadata?.foreignKeys.find(
            (fk) =>
              fk.columns.includes(column) &&
              relationshipKey(fk) === preference.relationship,
          );
          return key ? [[column, key] as const] : [];
        }),
      ),
    [preferences, metadata],
  );
  return {
    foreignKeys,
    preferences,
    setPreferences,
    labels:
      enabled &&
      current.current?.source === source &&
      current.current?.metadata === metadata &&
      current.current?.connectionId === connectionId
        ? current.current.cache.labels(preferences)
        : undefined,
  };
}

export function ReferenceValuePicker({
  column,
  foreignKeys,
  connectionId,
  preferences,
  onChange,
  onClose,
}: {
  column: string;
  foreignKeys: ForeignKey[];
  connectionId: string;
  preferences: ReferencePreferences;
  onChange: (preferences: ReferencePreferences) => void;
  onClose: () => void;
}) {
  const choices = foreignKeys.filter((fk) => fk.columns.includes(column));
  const preference = Object.entries(preferences).find(
    ([name]) => name === column,
  )?.[1];
  const [relationship, setRelationship] = useState<ForeignKey | undefined>(
    () =>
      choices.find((fk) => relationshipKey(fk) === preference?.relationship) ||
      choices[0],
  );
  const [search, setSearch] = useState("");
  const target = useRemote<Metadata>(
    "metadata",
    { connectionId, table: relationship?.to },
    !!relationship,
  );
  function choose(value: string) {
    const next = Object.fromEntries(
      Object.entries(preferences).filter(([name]) => name !== column),
    );
    onChange(
      value && relationship
        ? {
            ...next,
            [column]: {
              relationship: relationshipKey(relationship),
              column: value,
            },
          }
        : next,
    );
    onClose();
  }
  const fields =
    target.data &&
    relationship &&
    tableKey(target.data.table) === tableKey(relationship.to)
      ? target.data.columns
      : [];
  const selected =
    relationship && preference?.relationship === relationshipKey(relationship)
      ? preference.column
      : "";
  return (
    <Dialog
      open
      onClose={onClose}
      className="reference-display-dialog"
      title="Display value"
      description={
        relationship
          ? `${column} → ${relationship.to.schema ? `${relationship.to.schema}.` : ""}${relationship.to.name}`
          : "Referenced record"
      }
    >
      <div className="reference-value-picker">
        {choices.length > 1 && (
          <label>
            Relationship
            <Select
              aria-label="Referenced table"
              value={relationship ? relationshipKey(relationship) : ""}
              onValueChange={(value) => {
                setRelationship(
                  choices.find((fk) => relationshipKey(fk) === value),
                );
                setSearch("");
              }}
            >
              {choices.map((fk) => (
                <SelectItem
                  key={relationshipKey(fk)}
                  value={relationshipKey(fk)}
                >
                  {fk.to.schema ? `${fk.to.schema}.` : ""}
                  {fk.to.name} · {fk.name}
                </SelectItem>
              ))}
            </Select>
          </label>
        )}
        {fields.length > 6 && (
          <div className="reference-field-search">
            <Search size={14} />
            <input
              aria-label="Find a display field"
              placeholder="Find a field…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}
        <div
          className="reference-field-options"
          role="group"
          aria-label="Display field"
        >
          <button
            type="button"
            className={`reference-field-option reference-original ${!selected ? "selected" : ""}`}
            aria-pressed={!selected}
            onClick={() => choose("")}
          >
            <span>Original value</span>
            <code>{column}</code>
            {!selected && <Check size={14} />}
          </button>
          <div className="reference-field-list">
            {fields
              .filter((field) =>
                field.name.toLowerCase().includes(search.trim().toLowerCase()),
              )
              .map((field) => (
                <button
                  key={field.name}
                  type="button"
                  className={`reference-field-option ${selected === field.name ? "selected" : ""}`}
                  aria-pressed={selected === field.name}
                  onClick={() => choose(field.name)}
                >
                  <span>{field.name}</span>
                  <small>{field.dataType}</small>
                  {selected === field.name && <Check size={14} />}
                </button>
              ))}
            {!!fields.length &&
              !fields.some((field) =>
                field.name.toLowerCase().includes(search.trim().toLowerCase()),
              ) && <p className="reference-no-fields">No matching fields</p>}
          </div>
        </div>
        {target.loading && !target.data && <Loading label="Loading fields…" />}
        {target.error && (
          <ErrorState
            error={target.error}
            retry={() => void target.refresh()}
          />
        )}
      </div>
    </Dialog>
  );
}
