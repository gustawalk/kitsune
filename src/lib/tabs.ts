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
