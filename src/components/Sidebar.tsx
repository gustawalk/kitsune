import { Tooltip } from "./ui/tooltip";
import { modKey } from "../lib/utils";
import { useState, useDeferredValue } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Database,
  FileCode2,
  Folder,
  History,
  MoreHorizontal,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Table2,
  Unplug,
  Eye,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "./ui/button";
import { api, errorMessage, useRemote } from "../lib/api";
import { newQuery, notify, openTab, update, useWorkspace } from "../lib/store";
import {
  qualified,
  type Connection,
  type Metadata,
  type TableRef,
} from "../lib/types";
import { copyFeedback, ErrorState, Loading } from "./shared";
import { refreshConnections } from "../features/Connections";
export function Sidebar({
  onConnection,
}: {
  onConnection: (c?: Connection) => void;
}) {
  const workspace = useWorkspace();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [favorite, setFavorite] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("kitsune:favorites") || "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("kitsune:recent") || "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  const [mode, setMode] = useState("all");
  const [tableExpanded, setTableExpanded] = useState<string[]>([]);
  const active = workspace.connections.find(
    (c) => c.id === workspace.activeConnection,
  );
  const connected = workspace.activeConnections.includes(
    workspace.activeConnection,
  );
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId: workspace.activeConnection },
    !!active && connected,
  );
  const schemas = [...new Set(tables.data?.map((t) => t.schema) || [])];
  const [collapsedSchemas, setCollapsedSchemas] = useState<string[]>([]);
  function toggleFavorite(key: string) {
    const next = favorite.includes(key)
      ? favorite.filter((k) => k !== key)
      : [...favorite, key];
    setFavorite(next);
    localStorage.setItem("kitsune:favorites", JSON.stringify(next));
  }
  function openTable(t: TableRef) {
    const key = `${workspace.activeConnection}:${t.schema}:${t.name}`;
    const next = [key, ...recent.filter((k) => k !== key)].slice(0, 20);
    setRecent(next);
    localStorage.setItem("kitsune:recent", JSON.stringify(next));
    openTab({
      kind: "table",
      title: t.name,
      table: t,
      connectionId: workspace.activeConnection,
    });
  }
  async function connect(c: Connection) {
    if (c.driver !== "sqlite") {
      onConnection(c);
      return;
    }
    try {
      const r = await api<{
        id: string;
        readOnly: boolean;
      }>("connect", c);
      await refreshConnections();
      update((s) => ({
        activeConnection: r.id,
        readOnly: { ...s.readOnly, [r.id]: r.readOnly },
      }));
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => update({ activeTab: "" })}>
        <img src="/icon.svg" width={25} height={25} alt="Kitsune" />
        <strong>Kitsune</strong>
        <span>狐</span>
      </div>
      <div className="sidebar-section-heading">
        <span>Connections</span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onConnection()}
          aria-label="Add connection"
        >
          <Plus size={15} />
        </Button>
      </div>
      <div className="connections-list">
        {workspace.connections.map((c) => (
          <div
            key={c.id}
            className={`connection-item ${workspace.activeConnection === c.id ? "active" : ""}`}
          >
            <button
              className="connection-select"
              onClick={() => {
                update({ activeConnection: c.id });
                if (!expanded.includes(c.id)) setExpanded((a) => [...a, c.id]);
              }}
              onDoubleClick={() => {
                if (!workspace.activeConnections.includes(c.id))
                  void connect(c);
              }}
            >
              <span
                className={`connection-dot ${workspace.activeConnections.includes(c.id) ? "online" : ""} ${c.environment === "production" ? "production" : ""}`}
              />
              <Database
                size={15}
                style={c.color ? { color: c.color } : undefined}
              />
              <span>{c.name}</span>
              <span className={`environment environment-${c.environment}`}>
                {c.environment === "development"
                  ? "DEV"
                  : c.environment === "production"
                    ? "PROD"
                    : c.environment === "staging"
                      ? "STG"
                      : "CUSTOM"}
              </span>
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                className="connection-more"
                aria-label={`Actions for ${c.name}`}
              >
                <MoreHorizontal size={14} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown"
                  sideOffset={5}
                  align="start"
                >
                  <DropdownMenu.Item onSelect={() => void connect(c)}>
                    <Plug size={14} />
                    {workspace.activeConnections.includes(c.id)
                      ? "Reconnect"
                      : "Connect"}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={!workspace.activeConnections.includes(c.id)}
                    onSelect={() => {
                      void api("disconnect", { id: c.id })
                        .then(refreshConnections)
                        .catch((e) => notify(errorMessage(e), true));
                    }}
                  >
                    <Unplug size={14} />
                    Disconnect
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={!workspace.activeConnections.includes(c.id)}
                    onSelect={() =>
                      openTab({
                        kind: "schema",
                        title: "Schema viewer",
                        connectionId: c.id,
                      })
                    }
                  >
                    <Network size={14} />
                    Schema viewer
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => onConnection(c)}>
                    <Settings2 size={14} />
                    Edit connection
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() =>
                      onConnection({ ...c, id: "", name: `${c.name} copy` })
                    }
                  >
                    <Copy size={14} />
                    Duplicate
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() =>
                      window.dispatchEvent(
                        new CustomEvent("kitsune:delete-connection", {
                          detail: c,
                        }),
                      )
                    }
                    className="danger-text"
                  >
                    Delete saved connection
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ))}
        {!workspace.connections.length && (
          <button className="sidebar-add" onClick={() => onConnection()}>
            <Plus size={14} />
            Add your first connection
          </button>
        )}
      </div>
      <div className="sidebar-divider" />
      <div className="sidebar-section-heading">
        <span>Database explorer</span>
        <Button
          size="icon"
          variant="ghost"
          disabled={!connected}
          title="Open schema viewer"
          aria-label="Open schema viewer"
          onClick={() =>
            openTab({
              kind: "schema",
              title: "Schema viewer",
              connectionId: workspace.activeConnection,
            })
          }
        >
          <Network size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={!connected}
          onClick={() => void tables.refresh()}
          aria-label="Refresh schema"
        >
          <RefreshCw size={13} className={tables.loading ? "spin" : ""} />
        </Button>
      </div>
      <div className="sidebar-search">
        <Search size={13} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a table…"
          aria-label="Find a table"
        />
        <kbd>{modKey} P</kbd>
      </div>
      <div className="explorer-modes">
        <button
          className={mode === "all" ? "active" : ""}
          onClick={() => setMode("all")}
        >
          All
        </button>
        <button
          className={mode === "favorites" ? "active" : ""}
          onClick={() => setMode("favorites")}
        >
          <Star size={11} />
          Favorites
        </button>
        <button
          className={mode === "recent" ? "active" : ""}
          onClick={() => setMode("recent")}
        >
          Recent
        </button>
      </div>
      <button
        className="schema-open-link"
        disabled={!connected}
        onClick={() =>
          openTab({
            kind: "schema",
            title: "Schema viewer",
            connectionId: workspace.activeConnection,
          })
        }
      >
        <Network size={14} />
        Schema viewer
        <ChevronRight size={12} />
      </button>
      <div className="explorer-tree">
        {!active ? (
          <p className="sidebar-hint">
            Connect a database to explore its structure.
          </p>
        ) : !connected ? (
          <div className="sidebar-disconnected">
            <p>{active.name} is disconnected.</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void connect(active)}
            >
              <Plug size={13} />
              Connect
            </Button>
          </div>
        ) : (
          <>
            {tables.error && (
              <ErrorState
                error={tables.error}
                retry={() => void tables.refresh()}
              />
            )}{" "}
            {tables.loading && !tables.data && (
              <Loading label="Reading schema…" />
            )}
            {schemas.map((schema) => (
              <div key={schema}>
                {schema && (
                  <button
                    className="schema-heading"
                    onClick={() =>
                      setCollapsedSchemas((a) =>
                        a.includes(schema)
                          ? a.filter((s) => s !== schema)
                          : [...a, schema],
                      )
                    }
                  >
                    {collapsedSchemas.includes(schema) ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <Folder size={13} />
                    {schema}
                  </button>
                )}
                {!collapsedSchemas.includes(schema) &&
                  tables.data
                    ?.filter((t) => {
                      const key = `${workspace.activeConnection}:${t.schema}:${t.name}`;
                      return (
                        t.schema === schema &&
                        t.name
                          .toLowerCase()
                          .includes(deferredSearch.toLowerCase()) &&
                        (mode === "all" ||
                          (mode === "favorites" && favorite.includes(key)) ||
                          (mode === "recent" && recent.includes(key)))
                      );
                    })
                    .slice(0, 200)
                    .map((t) => {
                      const key = `${workspace.activeConnection}:${t.schema}:${t.name}`;
                      const open = tableExpanded.includes(key);
                      const activeTab = workspace.tabs.find(
                        (v) => v.id === workspace.activeTab,
                      );
                      return (
                        <div key={key}>
                          <div
                            className={`tree-item ${activeTab?.table?.name === t.name && activeTab.connectionId === workspace.activeConnection ? "active" : ""}`}
                          >
                            <button
                              className="tree-expand"
                              aria-label={`Expand ${t.name}`}
                              onClick={() =>
                                setTableExpanded((a) =>
                                  a.includes(key)
                                    ? a.filter((k) => k !== key)
                                    : [...a, key],
                                )
                              }
                            >
                              {open ? (
                                <ChevronDown size={12} />
                              ) : (
                                <ChevronRight size={12} />
                              )}
                            </button>
                            <button
                              className="tree-name"
                              onClick={() => openTable(t)}
                              onDoubleClick={() =>
                                setTableExpanded((a) => [...a, key])
                              }
                            >
                              {t.kind === "view" ? (
                                <Eye size={14} />
                              ) : (
                                <Table2 size={14} />
                              )}
                              <span>{t.name}</span>
                            </button>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                className="tree-menu"
                                aria-label={`Actions for ${t.name}`}
                              >
                                <MoreHorizontal size={13} />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  className="dropdown"
                                  sideOffset={5}
                                >
                                  <DropdownMenu.Item
                                    onSelect={() => openTable(t)}
                                  >
                                    <Table2 size={13} />
                                    Open table data
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    onSelect={() =>
                                      openTab({
                                        kind: "structure",
                                        title: `${t.name} structure`,
                                        table: t,
                                        connectionId:
                                          workspace.activeConnection,
                                      })
                                    }
                                  >
                                    <Columns3 size={13} />
                                    Table structure
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    onSelect={() =>
                                      newQuery(`SELECT * FROM ${qualified(t)};`)
                                    }
                                  >
                                    <FileCode2 size={13} />
                                    Query table
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    onSelect={() =>
                                      void copyFeedback(qualified(t))
                                    }
                                  >
                                    <Copy size={13} />
                                    Copy qualified name
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    onSelect={() => toggleFavorite(key)}
                                  >
                                    <Star size={13} />
                                    {favorite.includes(key)
                                      ? "Remove favorite"
                                      : "Add favorite"}
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    onSelect={() =>
                                      window.dispatchEvent(
                                        new CustomEvent("kitsune:watch", {
                                          detail: {
                                            connectionId:
                                              workspace.activeConnection,
                                            table: t,
                                            kind: "table",
                                          },
                                        }),
                                      )
                                    }
                                  >
                                    <Eye size={13} />
                                    Watch table
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          </div>
                          {open && (
                            <TableColumns
                              connectionId={workspace.activeConnection}
                              table={t}
                            />
                          )}
                        </div>
                      );
                    })}
              </div>
            ))}
            {tables.data && tables.data.length > 200 && (
              <p className="sidebar-hint">
                Up to 200 tables per schema are shown. Search to narrow the
                list.
              </p>
            )}
            {tables.data && !tables.data.length && (
              <p className="sidebar-hint">
                No user tables or views were found.
              </p>
            )}
          </>
        )}
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-section-heading">
          <span>Investigation mode</span>
        </div>
        <button
          onClick={() =>
            openTab({ kind: "investigations", title: "Investigations" })
          }
        >
          <Network size={16} />
          Investigations
        </button>
        <button
          className={
            workspace.tabs.find((t) => t.id === workspace.activeTab)?.kind ===
            "watches"
              ? "active"
              : ""
          }
          onClick={() => openTab({ kind: "watches", title: "Live Watch" })}
        >
          <Eye size={16} />
          Live Watch
          <span className="count">
            {workspace.watches.filter((w) => w.status === "running").length ||
              ""}
          </span>
        </button>
        <button
          className={
            workspace.tabs.find((t) => t.id === workspace.activeTab)?.kind ===
            "timeline"
              ? "active"
              : ""
          }
          onClick={() => openTab({ kind: "timeline", title: "Time Machine" })}
        >
          <History size={16} />
          Time Machine
        </button>
        <div className="sidebar-divider" />
        <button
          onClick={() => openTab({ kind: "settings", title: "Settings" })}
        >
          <Settings2 size={16} />
          Settings<kbd>{modKey} ,</kbd>
        </button>
      </div>
    </aside>
  );
}
function TableColumns({
  connectionId,
  table,
}: {
  connectionId: string;
  table: TableRef;
}) {
  const data = useRemote<Metadata>("metadata", { connectionId, table });
  return (
    <div className="tree-columns">
      {data.loading && !data.data && <span>Loading…</span>}
      {data.data?.columns.map((c) => (
        <Tooltip content={`Copy ${c.name}`}>
          <button key={c.name} onClick={() => void copyFeedback(c.name)}>
            <span className={c.pk ? "accent" : ""}>{c.pk ? "⚿" : "·"}</span>
            {c.name}
            <small>{c.dataType}</small>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
