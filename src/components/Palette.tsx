import { rankSearch } from "../lib/search";
import { useState } from "react";
import {
  Command,
  Database,
  Eye,
  FileCode2,
  History,
  Network,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { Dialog } from "./ui/dialog";
import { invalidate, useRemote } from "../lib/api";
import { newQuery, openTab, update, useWorkspace } from "../lib/store";
import type { Bootstrap, TableRef } from "../lib/types";
export function Palette({ onConnection }: { onConnection: () => void }) {
  const workspace = useWorkspace();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId: workspace.activeConnection },
    workspace.activeConnections.includes(workspace.activeConnection),
  );
  const saved = useRemote<{ id: string; name: string; sql: string }[]>(
    "saved_queries",
    {},
  );
  const bootstrap = useRemote<Bootstrap>("bootstrap", {});
  const commands: Array<{
    name: string;
    detail: string;
    icon: LucideIcon;
    action: () => void;
    searchNames?: string[];
  }> = [
    {
      name: "New SQL query",
      detail: "Command",
      icon: FileCode2,
      action: () => newQuery(),
    },
    {
      name: "Add connection",
      detail: "Command",
      icon: Plus,
      action: onConnection,
    },
    ...(workspace.activeConnection
      ? [
          {
            name: "Open schema viewer",
            detail: "Workspace",
            icon: Network,
            action: () =>
              openTab({
                kind: "schema",
                title: "Schema viewer",
                connectionId: workspace.activeConnection,
              }),
          },
        ]
      : []),
    {
      name: "Refresh schema",
      detail: "Command",
      icon: Database,
      action: () => {
        invalidate("tables:");
        invalidate("metadata:");
        invalidate("schema_table:");
        window.dispatchEvent(new Event("kitsune:refresh-schema"));
      },
    },
    {
      name: "Live Watch",
      detail: "Workspace",
      icon: Eye,
      action: () => openTab({ kind: "watches", title: "Live Watch" }),
    },
    {
      name: "Time Machine",
      detail: "Workspace",
      icon: History,
      action: () => openTab({ kind: "timeline", title: "Time Machine" }),
    },
    {
      name: "Query history and saved queries",
      detail: "Workspace",
      icon: History,
      action: () => openTab({ kind: "history", title: "Queries" }),
    },
    {
      name: "Toggle sidebar",
      detail: "Command",
      icon: PanelLeft,
      action: () => update({ sidebar: !workspace.sidebar }),
    },
    {
      name: "Open settings",
      detail: "Command",
      icon: Settings2,
      action: () => openTab({ kind: "settings", title: "Settings" }),
    },
    ...workspace.connections.map((c) => ({
      name: c.name,
      detail: `${c.driver} · ${c.environment}`,
      icon: Database,
      action: () => update({ activeConnection: c.id }),
    })),
    ...(tables.data || []).map((t) => ({
      name: [t.schema, t.name].filter(Boolean).join("."),
      detail: "Table",
      searchNames: [t.name, [t.schema, t.name].filter(Boolean).join(".")],
      icon: Table2,
      action: () =>
        openTab({
          kind: "table",
          title: t.name,
          table: t,
          connectionId: workspace.activeConnection,
        }),
    })),
    ...workspace.tabs.map((t) => ({
      name: t.title,
      detail: "Open tab",
      icon: Command,
      action: () => update({ activeTab: t.id }),
    })),
    ...(saved.data || []).map((q) => ({
      name: q.name,
      detail: "Saved query",
      icon: FileCode2,
      action: () => newQuery(q.sql),
    })),
    ...(bootstrap.data?.investigations || []).map((i) => ({
      name: i.name,
      detail: "Saved investigation",
      icon: Network,
      action: () =>
        openTab({
          kind: "investigation",
          title: i.name,
          investigation: i,
          root: i.root,
          connectionId: i.root.connectionId,
        }),
    })),
    ...workspace.watches.map((w) => ({
      name: w.name,
      detail: "Watch",
      icon: Eye,
      action: () => openTab({ kind: "timeline", title: w.name, watchId: w.id }),
    })),
  ];
  if (workspace.inspector) {
    const record = workspace.inspector;
    commands.unshift({
      name: "Start investigation of selected record",
      detail: "Command",
      icon: Network,
      action: () =>
        openTab({
          kind: "investigation",
          title: `Investigate ${record.table.name}`,
          root: record,
          connectionId: record.connectionId,
        }),
    });
    commands.unshift({
      name: "Watch selected record",
      detail: "Command",
      icon: Eye,
      action: () =>
        window.dispatchEvent(
          new CustomEvent("kitsune:watch", { detail: record }),
        ),
    });
  }
  const filtered = rankSearch(
    commands,
    search,
    (c) => c.searchNames || [c.name],
    (c) => [`${c.name} ${c.detail}`],
  ).slice(0, 100);
  function run(index: number) {
    const c = filtered[index];
    if (c) {
      update({ palette: false });
      c.action();
    }
  }
  return (
    <Dialog
      open
      onClose={() => update({ palette: false })}
      title="Command palette"
    >
      <div className="palette-search">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Search commands, tables, connections…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(filtered.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(selected);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-results" role="listbox" aria-label="Commands">
        {filtered.map((c, i) => (
          <button
            key={`${c.detail}-${c.name}-${i}`}
            role="option"
            aria-selected={selected === i}
            className={selected === i ? "selected" : ""}
            onMouseEnter={() => setSelected(i)}
            onClick={() => run(i)}
          >
            <c.icon size={16} />
            <span>{c.name}</span>
            <small>{c.detail}</small>
          </button>
        ))}
        {!filtered.length && (
          <p className="muted pad">No matching commands or items.</p>
        )}
      </div>
      <div className="palette-footer">
        <span>↑ ↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
      </div>
    </Dialog>
  );
}
