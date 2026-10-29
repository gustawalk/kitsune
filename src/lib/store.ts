import { useSyncExternalStore } from "react";
import type { Connection, RecordRef, Settings, Tab, Watch } from "./types";
import { defaults } from "./types";
interface Workspace {
  transactions: Record<string, "idle" | "active" | "lost">;
  connections: Connection[];
  activeConnections: string[];
  readOnly: Record<string, boolean>;
  activeConnection: string;
  tabs: Tab[];
  activeTab: string;
  inspector: RecordRef | null;
  settings: Settings;
  watches: Watch[];
  toast: { message: string; error: boolean } | null;
  sidebar: boolean;
  palette: boolean;
}
let state: Workspace = {
  transactions: {},
  connections: [],
  activeConnections: [],
  readOnly: {},
  activeConnection: "",
  tabs: [],
  activeTab: "",
  inspector: null,
  settings: defaults,
  watches: [],
  toast: null,
  sidebar: true,
  palette: false,
};
const listeners = new Set<() => void>();
export function update(
  value: Partial<Workspace> | ((s: Workspace) => Partial<Workspace>),
) {
  const next = typeof value === "function" ? value(state) : value;
  if (
    Object.keys(next).every((key) => {
      const field = key as keyof Workspace;
      return field === "inspector"
        ? JSON.stringify(next.inspector) === JSON.stringify(state.inspector)
        : next[field] === state[field];
    })
  )
    return;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
export function useWorkspace() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
export function getWorkspace() {
  return state;
}
let toastTimer: ReturnType<typeof setTimeout>;
export function notify(message: string, error = false) {
  clearTimeout(toastTimer);
  update({ toast: { message, error } });
  toastTimer = setTimeout(() => update({ toast: null }), 6500);
}
export function openTab(tab: Omit<Tab, "id"> & { id?: string }) {
  const existing = tab.id
    ? state.tabs.find((t) => t.id === tab.id)
    : state.tabs.find(
        (t) =>
          t.kind === tab.kind &&
          tab.kind !== "query" &&
          t.connectionId === tab.connectionId &&
          (tab.kind === "schema" ||
            JSON.stringify(t.table) === JSON.stringify(tab.table)) &&
          JSON.stringify(t.root) === JSON.stringify(tab.root) &&
          t.watchId === tab.watchId,
      );
  if (existing) {
    if (tab.kind === "schema" && tab.schemaTable)
      patchTab(existing.id, { schemaTable: tab.schemaTable });
    if (tab.kind === "table" && tab.filters)
      patchTab(existing.id, {
        filters: tab.filters,
        filterGroups: tab.filterGroups || [],
        groupMode: tab.groupMode || "all",
        offset: tab.offset || 0,
        sort: tab.sort || "",
        descending: tab.descending || false,
      });
    update({
      activeTab: existing.id,
      ...(tab.kind === "schema" ? { inspector: null } : {}),
    });
    return;
  }
  const next = { ...tab, id: tab.id || crypto.randomUUID() };
  update({
    tabs: [...state.tabs, next],
    activeTab: next.id,
    ...(tab.kind === "schema" ? { inspector: null } : {}),
  });
}
export function patchTab(id: string, patch: Partial<Tab>) {
  update({
    tabs: state.tabs.map((t) => {
      if (t.id !== id) return t;
      const changedQuery =
        (patch.sql !== undefined && patch.sql !== t.sql) ||
        (patch.connectionId !== undefined &&
          patch.connectionId !== t.connectionId);
      return {
        ...t,
        ...(changedQuery ? { boundParams: undefined } : {}),
        ...patch,
      };
    }),
  });
}
export function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  const transactions = { ...state.transactions };
  delete transactions[id];
  update({
    tabs,
    transactions,
    activeTab:
      state.activeTab === id
        ? tabs[Math.min(index, tabs.length - 1)]?.id || ""
        : state.activeTab,
  });
}
export function newQuery(sql = "") {
  openTab({
    kind: "query",
    title: "Untitled query",
    connectionId: state.activeConnection,
    sql,
    savedSql: "",
  });
}
