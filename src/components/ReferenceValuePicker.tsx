import { useEffect, useMemo, useState } from "react";
import { api, useRemote } from "../lib/api";
import { useLayoutPreference } from "../lib/layout-preferences";
import { relationshipKey, tableKey } from "../lib/schema";
import {
  loadReferenceLabels,
  referencePreferencesSchema,
  type ReferenceLabels,
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
  const [resolved, setResolved] = useState<{
    source: ResultSet;
    preferences: ReferencePreferences;
    metadata: Metadata;
    connectionId: string;
    labels: ReferenceLabels;
  }>();
  useEffect(() => {
    let alive = true;
    if (enabled && source && metadata && Object.keys(preferences).length)
      void loadReferenceLabels(
        source,
        metadata,
        preferences,
        connectionId,
        api,
        () => alive,
      ).then((labels) => {
        if (alive)
          setResolved({ source, preferences, metadata, connectionId, labels });
      });
    return () => {
      alive = false;
    };
  }, [enabled, source, metadata, preferences, connectionId]);
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
      resolved?.source === source &&
      resolved?.preferences === preferences &&
      resolved?.metadata === metadata &&
      resolved?.connectionId === connectionId
        ? resolved.labels
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
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Display ${column}`}
      description={
        relationship
          ? `${relationship.to.schema ? `${relationship.to.schema}.` : ""}${relationship.to.name}`
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
              onValueChange={(value) =>
                setRelationship(
                  choices.find((fk) => relationshipKey(fk) === value),
                )
              }
            >
              {choices.map((fk) => (
                <SelectItem
                  key={relationshipKey(fk)}
                  value={relationshipKey(fk)}
                >
                  {fk.to.schema}.{fk.to.name} · {fk.name}
                </SelectItem>
              ))}
            </Select>
          </label>
        )}
        <label>
          Show
          <Select
            aria-label="Display field"
            value={
              relationship &&
              preference?.relationship === relationshipKey(relationship)
                ? preference.column
                : ""
            }
            onValueChange={choose}
          >
            <SelectItem value="">Original value</SelectItem>
            {(target.data &&
            relationship &&
            tableKey(target.data.table) === tableKey(relationship.to)
              ? target.data.columns
              : []
            ).map((field) => (
              <SelectItem key={field.name} value={field.name}>
                {field.name}
              </SelectItem>
            ))}
          </Select>
        </label>
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
