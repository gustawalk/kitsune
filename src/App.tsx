import { Updates, VersionStatus } from "./components/Updates";
import { ContextMenu } from "radix-ui";
import { startResize } from "./lib/resize";
import { useLayoutPreference } from "./lib/layout-preferences";
import { z } from "zod";
import { normalizeTheme, resolvedTheme } from "./lib/themes";
import {
  tabContext,
  tabCloseIds,
  reorderedTabs,
  type TabCloseScope,
} from "./lib/tabs";
import { modKey } from "./lib/utils";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  ChevronLeft,
  Check,
  ChevronRight,
  Database,
  Eye,
  FileCode2,
  History,
  LockKeyhole,
  Network,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { Palette } from "./components/Palette";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ErrorState, Loading, Tag } from "./components/shared";
import { ConnectionDialog, refreshConnections } from "./features/Connections";
import { Inspector, DetectiveWorkspace } from "./features/Detective";
import type { WatchTarget } from "./features/Watches";
import { api, errorMessage, useRemote } from "./lib/api";
import {
  closeTab,
  getWorkspace,
  newQuery,
  notify,
  openTab,
  update,
  useWorkspace,
} from "./lib/store";
import {
  defaults,
  type Bootstrap,
  type Connection,
  type Investigation,
  type Tab,
  type Watch,
} from "./lib/types";
import "./App.css";
const WatchDialog = lazy(() =>
  import("./features/Watches").then((m) => ({ default: m.WatchDialog })),
);
const WatchWorkspace = lazy(() =>
  import("./features/Watches").then((m) => ({ default: m.WatchWorkspace })),
);
const TimelineWorkspace = lazy(() =>
  import("./features/Watches").then((m) => ({ default: m.TimelineWorkspace })),
);
const QueryWorkspace = lazy(() =>
  import("./features/Query").then((m) => ({ default: m.QueryWorkspace })),
);
const TableWorkspace = lazy(() =>
  import("./features/Table").then((m) => ({ default: m.TableWorkspace })),
);
const SchemaWorkspace = lazy(() =>
  import("./features/Schema").then((m) => ({ default: m.SchemaWorkspace })),
);
const SettingsWorkspace = lazy(() =>
  import("./features/Settings").then((m) => ({ default: m.SettingsWorkspace })),
);
const HistoryWorkspace = lazy(() =>
  import("./features/Settings").then((m) => ({ default: m.HistoryWorkspace })),
);
const InvestigationsWorkspace = lazy(() =>
  import("./features/Investigations").then((m) => ({
    default: m.InvestigationsWorkspace,
  })),
);
const tabIcons = {
  query: FileCode2,
  table: Table2,
  structure: Table2,
  schema: Database,
  investigation: Network,
  investigations: Network,
  watches: Eye,
  timeline: History,
  settings: Settings2,
  history: History,
};
function App() {
  const workspace = useWorkspace();
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ start: false, end: false });
  const updateTabOverflow = () => {
    const element = tabsScrollRef.current;
    if (!element) return;
    setTabOverflow({
      start: element.scrollLeft > 0,
      end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    });
  };
  useEffect(() => {
    const active = tabsScrollRef.current?.querySelector<HTMLElement>(
      ".workspace-tab.active",
    );
    const viewport = tabsScrollRef.current;
    if (!active || !viewport) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < viewport.scrollLeft) {
      viewport.scrollTo({ left, behavior: "smooth" });
    } else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollTo({
        left: right - viewport.clientWidth,
        behavior: "smooth",
      });
    }
  }, [workspace.activeTab]);
  useEffect(() => {
    const element = tabsScrollRef.current;
    if (!element) return;
    updateTabOverflow();
    const observer = new ResizeObserver(updateTabOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspace.tabs.length]);
  const scrollTabs = (direction: -1 | 1) => {
    const element = tabsScrollRef.current;
    if (!element) return;
    const tabs = [...element.querySelectorAll<HTMLElement>(".workspace-tab")];
    if (!tabs.length) return;
    const edge =
      direction > 0
        ? element.scrollLeft + element.clientWidth + 1
        : element.scrollLeft - 1;
    const target =
      direction > 0
        ? tabs.find((tab) => tab.offsetLeft + tab.offsetWidth > edge)
        : [...tabs].reverse().find((tab) => tab.offsetLeft < edge);
    if (target) {
      element.scrollTo({
        left: direction > 0 ? target.offsetLeft : target.offsetLeft,
        behavior: "smooth",
      });
    }
  };
  const bootstrap = useRemote<Bootstrap>("bootstrap", {});
  const initialized = useRef(false);
  const [connectionDialog, setConnectionDialog] = useState<{
    initial?: Connection;
  } | null>(null);
  const [watchTarget, setWatchTarget] = useState<WatchTarget>();
  const [closing, setClosing] = useState<Tab>();
  const closingQueue = useRef<string[]>([]);
  const [closingBusy, setClosingBusy] = useState(false);
  const draggingTab = useRef<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);
  const [deleting, setDeleting] = useState<Connection>();
  const [writeConfirmation, setWriteConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  // Keep only a small recent set of heavy panels mounted for fast tab switching.
  const [mountedTabs, setMountedTabs] = useState<string[]>(() =>
    workspace.activeTab ? [workspace.activeTab] : [],
  );
  useEffect(() => {
    if (!workspace.activeTab) return;
    setMountedTabs((current) =>
      [
        ...current.filter((id) => id !== workspace.activeTab),
        workspace.activeTab,
      ].slice(-5),
    );
  }, [workspace.activeTab]);
  const [sidebarWidth, setSidebarWidth] = useLayoutPreference(
    "panels:sidebar",
    z.number().min(200).max(420),
    254,
  );
  const [inspectorWidth, setInspectorWidth] = useLayoutPreference(
    "panels:inspector",
    z.number().min(260).max(600),
    320,
  );
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTab);
  const activeSessionConnection = workspace.connections.find(
    (c) => c.id === (activeTab?.connectionId || workspace.activeConnection),
  );
  const sessionId = activeSessionConnection?.id || "";
  const connected = workspace.activeConnections.includes(sessionId);
  const readonly =
    workspace.readOnly[sessionId] ??
    (activeSessionConnection?.readOnly ||
      activeSessionConnection?.environment === "production");
  useEffect(() => {
    if (!bootstrap.data || initialized.current) return;
    initialized.current = true;
    const data = bootstrap.data;
    const settings = {
      ...defaults,
      ...data.settings,
      theme: normalizeTheme(data.settings?.theme || defaults.theme),
    };
    const restoredTabs = settings.restoreTabs
      ? (data.workspace?.tabs || []).filter(
          (t) => typeof t.id === "string" && t.kind in tabIcons,
        )
      : [];
    update({
      connections: data.connections,
      activeConnections: data.active,
      readOnly: data.readOnly,
      transactions: data.transactions,
      settings,
      watches: data.watches,
      tabs: restoredTabs,
      activeTab: restoredTabs.some((t) => t.id === data.workspace?.activeTab)
        ? data.workspace?.activeTab || ""
        : "",
      activeConnection:
        data.workspace?.activeConnection || data.connections[0]?.id || "",
    });
  }, [bootstrap.data]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(
        workspace.settings.theme,
        media.matches,
      );
      document.documentElement.dataset.density = workspace.settings.density;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [workspace.settings.theme, workspace.settings.density]);
  useEffect(() => {
    if (!initialized.current || !isTauri()) return;
    const timeout = setTimeout(() => {
      void api(
        "save_workspace",
        workspace.settings.restoreTabs
          ? {
              tabs: workspace.tabs.map(
                ({ boundParams: _params, ...tab }) => tab,
              ),
              activeTab: workspace.activeTab,
              activeConnection: workspace.activeConnection,
            }
          : { tabs: [], activeConnection: workspace.activeConnection },
      ).catch((e) => notify(errorMessage(e), true));
    }, 700);
    return () => clearTimeout(timeout);
  }, [
    workspace.tabs,
    workspace.activeTab,
    workspace.activeConnection,
    workspace.settings.restoreTabs,
  ]);
  useEffect(() => {
    const watch = (e: Event) =>
      setWatchTarget((e as CustomEvent<WatchTarget>).detail);
    const del = (e: Event) =>
      setDeleting((e as CustomEvent<Connection>).detail);
    const connect = (e: Event) =>
      setConnectionDialog({
        initial: (e as CustomEvent<Connection | undefined>).detail,
      });
    window.addEventListener("kitsune:open-connection", connect);
    window.addEventListener("kitsune:watch", watch);
    window.addEventListener("kitsune:delete-connection", del);
    return () => {
      window.removeEventListener("kitsune:open-connection", connect);
      window.removeEventListener("kitsune:watch", watch);
      window.removeEventListener("kitsune:delete-connection", del);
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    void listen<{
      notify: boolean;
    }>("watch-event", (e) => {
      void api<Watch[]>("watches").then((watches) => update({ watches }));
      if (e.payload.notify)
        notify(
          "A watched result changed. Open Time Machine to inspect the observation.",
        );
    }).then((fn) => (disposed ? fn() : cleanup.push(fn)));
    const timer = setInterval(() => {
      if (getWorkspace().activeConnections.length)
        void api<Watch[]>("watches")
          .then((watches) => update({ watches }))
          .catch(() => undefined);
    }, 4000);
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      clearInterval(timer);
    };
  }, []);
  function advanceCloseQueue() {
    while (closingQueue.current.length) {
      const state = getWorkspace();
      const id = closingQueue.current.shift();
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) continue;
      if (
        tab.kind === "query" &&
        ((tab.sql && tab.sql !== tab.savedSql) ||
          state.transactions[tab.id] === "active")
      ) {
        setClosing(tab);
        return;
      }
      if (tab.kind === "query" && tab.connectionId)
        void api("close_editor_session", {
          connectionId: tab.connectionId,
          tabId: tab.id,
          confirmed: true,
        }).catch(() => undefined);
      closeTab(tab.id);
    }
    setClosing(undefined);
  }
  function requestCloseTabs(id: string, scope: TabCloseScope) {
    closingQueue.current = tabCloseIds(getWorkspace().tabs, id, scope);
    advanceCloseQueue();
  }
  function requestClose(tab: Tab) {
    requestCloseTabs(tab.id, "tab");
  }
  function cancelClosing() {
    if (closingBusy) return;
    closingQueue.current = [];
    setClosing(undefined);
  }
  function moveTab(id: string, direction: -1 | 1) {
    const tabs = getWorkspace().tabs;
    const index = tabs.findIndex((t) => t.id === id);
    const neighbor = tabs[index + direction];
    if (neighbor)
      update({
        tabs: reorderedTabs(
          tabs,
          id,
          neighbor.id,
          direction < 0 ? "before" : "after",
        ),
      });
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k" || key === "p" || (key === "f" && event.shiftKey)) {
        event.preventDefault();
        update({ palette: !getWorkspace().palette });
      } else if (key === "t") {
        event.preventDefault();
        newQuery();
      } else if (key === "w") {
        event.preventDefault();
        const s = getWorkspace();
        const tab = s.tabs.find((t) => t.id === s.activeTab);
        if (tab) requestClose(tab);
      } else if (key === ",") {
        event.preventDefault();
        openTab({ kind: "settings", title: "Settings" });
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  function resize(event: React.PointerEvent, kind: "sidebar" | "inspector") {
    const x = event.clientX;
    const initial = kind === "sidebar" ? sidebarWidth : inspectorWidth;
    const move = (e: PointerEvent) => {
      if (kind === "sidebar")
        setSidebarWidth(Math.min(420, Math.max(200, initial + e.clientX - x)));
      else
        setInspectorWidth(
          Math.min(650, Math.max(270, initial - e.clientX + x)),
        );
    };
    startResize(event, move);
  }
  async function changeWriteAccess(enabled: boolean) {
    setBusy(true);
    try {
      const result = await api<{
        readOnly: boolean;
      }>("set_write_access", {
        id: sessionId,
        enabled,
        confirmed: enabled,
      });
      update((s) => ({
        readOnly: { ...s.readOnly, [sessionId]: result.readOnly },
      }));
      setWriteConfirmation(false);
      notify(
        enabled
          ? "Write access enabled for this session."
          : "Connection is now read-only.",
      );
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-shell">
      {workspace.sidebar && (
        <div className="sidebar-container" style={{ width: sidebarWidth }}>
          <Sidebar
            onConnection={(initial) => setConnectionDialog({ initial })}
          />
          <div
            className="vertical-resize"
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            onPointerDown={(e) => resize(e, "sidebar")}
          />
        </div>
      )}
      <div className="app-main">
        <header className="topbar">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle sidebar"
            onClick={() => update({ sidebar: !workspace.sidebar })}
          >
            <PanelLeft size={16} />
          </Button>
          <div className="breadcrumb">
            <span>{activeSessionConnection?.name || "Workspace"}</span>
            <ChevronRight size={12} />
            <strong>{activeTab?.title || "Overview"}</strong>
          </div>
          {activeSessionConnection?.environment === "production" && (
            <Tag tone="danger">PRODUCTION</Tag>
          )}
          <div className="spacer" />
          {connected && (
            <button
              className={`safety-mode ${readonly ? "" : "writable"}`}
              disabled={busy}
              onClick={() =>
                readonly
                  ? setWriteConfirmation(true)
                  : void changeWriteAccess(false)
              }
            >
              <LockKeyhole size={12} />
              {readonly ? "Read-only" : "Writes enabled"}
            </button>
          )}
          <button
            className="global-search"
            onClick={() => update({ palette: true })}
          >
            <Search size={13} />
            <span>Search anything</span>
            <kbd>{modKey} K</kbd>
          </button>
        </header>
        <div
          className="tabs-bar"
          role="tablist"
          aria-label="Open workspaces"
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).getAttribute("role") !== "tab")
              return;
            const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const tabs = workspace.tabs;
            if (!tabs.length) return;
            const index = tabs.findIndex((t) => t.id === workspace.activeTab);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            update({ activeTab: tabs[next].id });
            const controls =
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            controls[next]?.focus();
            controls[next]?.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            });
          }}
        >
          <div
            className={`tabs-scroll-wrap ${tabOverflow.start ? "has-start-overflow" : ""} ${tabOverflow.end ? "has-end-overflow" : ""}`}
          >
            {tabOverflow.start && (
              <button
                className="tabs-scroll-button tabs-scroll-previous"
                aria-label="Scroll tabs left"
                onClick={() => scrollTabs(-1)}
              >
                <ChevronLeft size={15} />
              </button>
            )}
            <div
              className="tabs-scroll"
              ref={tabsScrollRef}
              onScroll={updateTabOverflow}
            >
              {workspace.tabs.map((tab, tabIndex) => {
                const Icon = tabIcons[tab.kind];
                const connection = workspace.connections.find(
                  (c) => c.id === tab.connectionId,
                );
                const context = tabContext(tab, connection?.name);
                return (
                  <ContextMenu.Root key={tab.id}>
                    <ContextMenu.Trigger asChild>
                      <div
                        draggable
                        data-app-context-menu
                        data-drop-side={
                          tabDropTarget?.id === tab.id
                            ? tabDropTarget.side
                            : undefined
                        }
                        onDragStart={(event) => {
                          if (
                            (event.target as HTMLElement).closest(".tab-close")
                          ) {
                            event.preventDefault();
                            return;
                          }
                          draggingTab.current = tab.id;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", tab.id);
                        }}
                        onDragOver={(event) => {
                          if (
                            !draggingTab.current ||
                            draggingTab.current === tab.id
                          )
                            return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          const bounds =
                            event.currentTarget.getBoundingClientRect();
                          setTabDropTarget({
                            id: tab.id,
                            side:
                              event.clientX < bounds.left + bounds.width / 2
                                ? "before"
                                : "after",
                          });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const source = draggingTab.current;
                          const bounds =
                            event.currentTarget.getBoundingClientRect();
                          if (source)
                            update({
                              tabs: reorderedTabs(
                                getWorkspace().tabs,
                                source,
                                tab.id,
                                event.clientX < bounds.left + bounds.width / 2
                                  ? "before"
                                  : "after",
                              ),
                            });
                          draggingTab.current = null;
                          setTabDropTarget(null);
                        }}
                        onDragEnd={() => {
                          draggingTab.current = null;
                          setTabDropTarget(null);
                        }}
                        className={`workspace-tab ${tab.id === workspace.activeTab ? "active" : ""}`}
                        key={tab.id}
                        data-kind={tab.kind}
                        data-connection-color={connection?.color || undefined}
                        style={
                          connection?.color
                            ? ({
                                "--tab-tone": connection.color,
                              } as CSSProperties)
                            : undefined
                        }
                      >
                        <button
                          role="tab"
                          title={`${tab.title} · ${context}`}
                          tabIndex={tab.id === workspace.activeTab ? 0 : -1}
                          aria-selected={tab.id === workspace.activeTab}
                          onClick={() => update({ activeTab: tab.id })}
                        >
                          <Icon size={14} />
                          <span className="tab-label">
                            <strong>
                              {tab.title}
                              {workspace.transactions[tab.id] === "active"
                                ? " · TX"
                                : workspace.transactions[tab.id] === "lost"
                                  ? " · TX lost"
                                  : ""}
                            </strong>
                            <small>{context}</small>
                          </span>
                          {tab.kind === "query" &&
                            tab.sql &&
                            tab.sql !== tab.savedSql && (
                              <span className="unsaved-dot" />
                            )}
                        </button>
                        <button
                          className="tab-close"
                          aria-label={`Close ${tab.title}`}
                          onClick={() => requestClose(tab)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content
                        className="app-context-menu"
                        collisionPadding={8}
                      >
                        <ContextMenu.Item
                          disabled={tabIndex === 0}
                          onSelect={() => moveTab(tab.id, -1)}
                        >
                          Move tab left
                        </ContextMenu.Item>
                        <ContextMenu.Item
                          disabled={tabIndex === workspace.tabs.length - 1}
                          onSelect={() => moveTab(tab.id, 1)}
                        >
                          Move tab right
                        </ContextMenu.Item>
                        <ContextMenu.Separator />
                        {(
                          [
                            ["tab", "Close tab"],
                            ["others", "Close other tabs"],
                            ["left", "Close tabs to the left"],
                            ["right", "Close tabs to the right"],
                            ["all", "Close all tabs"],
                          ] as const
                        ).map(([scope, label]) => (
                          <ContextMenu.Item
                            key={scope}
                            disabled={
                              !tabCloseIds(workspace.tabs, tab.id, scope).length
                            }
                            onSelect={() => requestCloseTabs(tab.id, scope)}
                          >
                            {label}
                          </ContextMenu.Item>
                        ))}
                      </ContextMenu.Content>
                    </ContextMenu.Portal>
                  </ContextMenu.Root>
                );
              })}
            </div>
            {tabOverflow.end && (
              <button
                className="tabs-scroll-button tabs-scroll-next"
                aria-label="Scroll tabs right"
                onClick={() => scrollTabs(1)}
              >
                <ChevronRight size={15} />
              </button>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => newQuery()}
            title="New SQL tab (Ctrl/Cmd+T)"
          >
            <Plus size={16} />
          </Button>
        </div>
        <div className="main-content">
          <main className="workspace-content">
            {bootstrap.error && (
              <div className="bootstrap-error">
                <ErrorState
                  error={bootstrap.error}
                  retry={() => void bootstrap.refresh()}
                />
              </div>
            )}
            {!workspace.activeTab && (
              <Welcome onConnection={() => setConnectionDialog({})} />
            )}
            <Suspense fallback={<Loading label="Opening workspace…" />}>
              {workspace.tabs.map((tab) => (
                <div
                  className="tab-content"
                  key={tab.id}
                  hidden={tab.id !== workspace.activeTab}
                >
                  {!mountedTabs.includes(tab.id) ? null : tab.kind ===
                    "query" ? (
                    <QueryWorkspace tab={tab} />
                  ) : tab.kind === "table" || tab.kind === "structure" ? (
                    <TableWorkspace tab={tab} />
                  ) : tab.kind === "schema" ? (
                    <SchemaWorkspace key={tab.connectionId} tab={tab} />
                  ) : tab.kind === "investigation" ? (
                    <DetectiveWorkspace tab={tab} />
                  ) : tab.kind === "watches" ? (
                    <WatchWorkspace />
                  ) : tab.kind === "timeline" ? (
                    <TimelineWorkspace tab={tab} />
                  ) : tab.kind === "settings" ? (
                    <SettingsWorkspace />
                  ) : tab.kind === "investigations" ? (
                    <InvestigationsWorkspace />
                  ) : (
                    <HistoryWorkspace />
                  )}
                </div>
              ))}
            </Suspense>
          </main>
          {workspace.inspector && (
            <div
              className="inspector-container"
              style={{ width: inspectorWidth }}
            >
              <div
                className="vertical-resize left"
                role="separator"
                aria-label="Resize inspector"
                aria-orientation="vertical"
                onPointerDown={(e) => resize(e, "inspector")}
              />
              <Inspector
                record={workspace.inspector}
                onClose={() => update({ inspector: null })}
              />
            </div>
          )}
        </div>
        <footer className="statusbar">
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          <span>
            {connected ? activeSessionConnection?.name : "No active connection"}
          </span>
          {connected && (
            <span className="status-driver">
              {activeSessionConnection?.driver === "postgres"
                ? "PostgreSQL"
                : activeSessionConnection?.driver === "mysql"
                  ? "MySQL / MariaDB"
                  : activeSessionConnection?.driver === "mssql"
                    ? "SQL Server"
                    : "SQLite"}
            </span>
          )}
          <div className="spacer" />
          <button
            onClick={() => openTab({ kind: "watches", title: "Live Watch" })}
          >
            <Eye size={12} />
            {
              workspace.watches.filter((w) => w.status === "running").length
            }{" "}
            watches running
          </button>
          <span className="status-local">
            <ShieldCheck size={12} />
            Local first
          </span>
          <VersionStatus />
        </footer>
      </div>
      <Updates />
      {workspace.toast && (
        <div
          className={`toast ${workspace.toast.error ? "toast-error" : ""}`}
          role={workspace.toast.error ? "alert" : "status"}
        >
          {workspace.toast.error ? (
            <AlertCircle size={17} />
          ) : (
            <Check size={17} />
          )}
          <span>{workspace.toast.message}</span>
          <button
            onClick={() => update({ toast: null })}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {workspace.palette && (
        <Palette onConnection={() => setConnectionDialog({})} />
      )}{" "}
      {connectionDialog && (
        <ConnectionDialog
          initial={connectionDialog.initial}
          onClose={() => setConnectionDialog(null)}
        />
      )}{" "}
      {watchTarget && (
        <Suspense
          fallback={
            <Dialog
              open
              title="Watch settings"
              onClose={() => setWatchTarget(undefined)}
            >
              <Loading label="Opening watch settings…" />
            </Dialog>
          }
        >
          <WatchDialog
            target={watchTarget}
            onClose={() => setWatchTarget(undefined)}
          />
        </Suspense>
      )}{" "}
      {closing && (
        <Dialog
          open
          onClose={cancelClosing}
          title={
            workspace.transactions[closing.id] === "active"
              ? "Close an active transaction?"
              : "Close unsaved query?"
          }
          description={`${closing.title}: closing ends this SQL session and discards uncommitted work. Save query text first with Ctrl/Cmd+S if needed.${closingQueue.current.length ? ` ${closingQueue.current.length} more tab(s) remain to be checked. Keep editing cancels the remaining close operation.` : ""}`}
        >
          <footer>
            <Button
              variant="secondary"
              disabled={closingBusy}
              onClick={cancelClosing}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              disabled={closingBusy}
              onClick={() => {
                setClosingBusy(true);
                void (
                  closing.connectionId
                    ? api("close_editor_session", {
                        connectionId: closing.connectionId,
                        tabId: closing.id,
                        confirmed: true,
                      })
                    : Promise.resolve()
                )
                  .then(() => {
                    closeTab(closing.id);
                    advanceCloseQueue();
                  })
                  .catch((e) => notify(errorMessage(e), true))
                  .finally(() => setClosingBusy(false));
              }}
            >
              Close query
            </Button>
          </footer>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          open
          onClose={() => setDeleting(undefined)}
          title="Delete saved connection?"
          description={`Disconnect and remove “${deleting.name}”. Its source database is not deleted.`}
        >
          <footer>
            <Button variant="secondary" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api("delete_connection", { id: deleting.id })
                  .then(async () => {
                    await refreshConnections();
                    setDeleting(undefined);
                    notify("Saved connection deleted");
                  })
                  .catch((e) => notify(errorMessage(e), true))
                  .finally(() => setBusy(false));
              }}
            >
              <Trash2 size={14} />
              Delete connection
            </Button>
          </footer>
        </Dialog>
      )}
      {writeConfirmation && (
        <Dialog
          open
          onClose={() => setWriteConfirmation(false)}
          title="Enable session write access?"
          description={`${activeSessionConnection?.name} · ${activeSessionConnection?.environment}`}
        >
          <p className="notice">
            SQL will be allowed to modify data and schema on this connection.
            Production read-only protection resets when reconnecting. Watches
            remain read-only.
          </p>
          <footer>
            <Button
              variant="secondary"
              onClick={() => setWriteConfirmation(false)}
            >
              Keep read-only
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void changeWriteAccess(true)}
            >
              Enable writes for this session
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
function Welcome({ onConnection }: { onConnection: () => void }) {
  const workspace = useWorkspace();
  const bootstrap = useRemote<Bootstrap>("bootstrap", {}, isTauri());
  const [deleting, setDeleting] = useState<Investigation>();
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-brand">
          <img src="/icon.svg" width={48} height={48} alt="" />
          <span>
            KITSUNE <span>狐</span>
          </span>
        </div>
        <h1>Understand your data.</h1>
        <p className="welcome-description">
          Follow the relationships. Observe the changes.
          <br />
          Find the story behind every record.
        </p>
        <div className="welcome-actions">
          <Button onClick={onConnection}>
            <Plus size={15} />
            {workspace.connections.length
              ? "Add connection"
              : "Connect your first database"}
          </Button>
          <Button variant="secondary" onClick={() => newQuery()}>
            <FileCode2 size={15} />
            New query<kbd>{modKey} T</kbd>
          </Button>
        </div>
        <div className="workflow-intro">
          <div>
            <span className="workflow-number">01</span>
            <Network size={20} />
            <h3>Explore</h3>
            <p>
              Open a table and click a cell.
              <br />
              Explore related records in the inspector.
            </p>
          </div>
          <ArrowRight size={15} />
          <div>
            <span className="workflow-number">02</span>
            <Eye size={20} />
            <h3>Observe</h3>
            <p>
              Start a watch and wait for its baseline.
              <br />
              Then make a change to your data.
            </p>
          </div>
          <ArrowRight size={15} />
          <div>
            <span className="workflow-number">03</span>
            <History size={20} />
            <h3>Investigate</h3>
            <p>
              Open Time Machine.
              <br />
              Compare captured before and after values.
            </p>
          </div>
        </div>
        <div className="welcome-divider" />
        {!!bootstrap.data?.investigations.length ? (
          <div className="saved-investigations">
            <div className="section-label">Saved investigations</div>
            {bootstrap.data.investigations.map((i) => (
              <div key={i.id}>
                <button
                  onClick={() =>
                    openTab({
                      kind: "investigation",
                      title: i.name,
                      root: i.root,
                      connectionId: i.root.connectionId,
                      investigation: i,
                    })
                  }
                >
                  <Network size={15} />
                  <span>{i.name}</span>
                  <small>{i.root.table.name}</small>
                  <ChevronRight size={14} />
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Delete investigation"
                  onClick={() => setDeleting(i)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="welcome-tip">
            <Database size={16} />
            <p>
              {workspace.connections.length
                ? "Open a table and select a record to start an investigation."
                : "Connect a server or open a SQLite file to start exploring."}
            </p>
          </div>
        )}
        <div className="welcome-shortcuts">
          <span>
            <kbd>{modKey} K</kbd>Command palette
          </span>
          <span>
            <kbd>{modKey} P</kbd>Find a table
          </span>
          <button
            onClick={() => openTab({ kind: "settings", title: "Settings" })}
          >
            <Settings2 size={13} />
            Preferences
          </button>
        </div>
      </div>
      <div className="welcome-footer">
        <ShieldCheck size={12} />
        Your connections, queries, and investigations stay local.
      </div>
      {deleting && (
        <Dialog
          open
          onClose={() => setDeleting(undefined)}
          title="Delete investigation?"
          description={deleting.name}
        >
          <footer>
            <Button
              variant="destructive"
              onClick={() => {
                void api("delete_investigation", { id: deleting.id })
                  .then(() => {
                    setDeleting(undefined);
                    void bootstrap.refresh();
                  })
                  .catch((e) => notify(errorMessage(e), true));
              }}
            >
              Delete investigation
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
export default App;
