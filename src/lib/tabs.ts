import type { Tab } from "./types";
export const tabKindLabels: Record<Tab["kind"], string> = {
  query: "SQL",
  table: "Data",
  structure: "Structure",
  schema: "Schema",
  investigation: "Detective",
  investigations: "Investigations",
  watches: "Live Watch",
  timeline: "Timeline",
  settings: "Settings",
  history: "Queries",
};
export function tabContext(tab: Tab, connection?: string): string {
  return [tabKindLabels[tab.kind], connection, tab.table?.schema]
    .filter(Boolean)
    .join(" · ");
}

export type TabCloseScope = "tab" | "others" | "left" | "right" | "all";
export function tabCloseIds(
  tabs: Tab[],
  id: string,
  scope: TabCloseScope,
): string[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return [];
  return tabs
    .filter(
      (tab, i) =>
        scope === "all" ||
        (scope === "tab"
          ? tab.id === id
          : scope === "others"
            ? tab.id !== id
            : scope === "left"
              ? i < index
              : i > index),
    )
    .map((tab) => tab.id);
}
export function reorderedTabs(
  tabs: Tab[],
  source: string,
  target: string,
  side: "before" | "after",
): Tab[] {
  if (
    source === target ||
    !tabs.some((t) => t.id === source) ||
    !tabs.some((t) => t.id === target)
  )
    return tabs;
  const moving = tabs.find((t) => t.id === source)!;
  const next = tabs.filter((t) => t.id !== source);
  next.splice(
    next.findIndex((t) => t.id === target) + (side === "after" ? 1 : 0),
    0,
    moving,
  );
  return next;
}
