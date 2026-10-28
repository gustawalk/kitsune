import { startResize } from "../lib/resize";
import { useLayoutPreference } from "../lib/layout-preferences";
import { z } from "zod";
import { Tooltip } from "../components/ui/tooltip";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Database,
  FileCode2,
  KeyRound,
  Network,
  PanelRight,
  RefreshCw,
  Search,
  Square,
  Table2,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Select, SelectItem } from "../components/ui/select";
import {
  Empty,
  ErrorState,
  Loading,
  Tag,
  copyFeedback,
} from "../components/shared";
import { SchemaDiagram } from "../components/SchemaDiagram";
import { api, errorMessage, useRemote, invalidate } from "../lib/api";
import { openTab, patchTab, useWorkspace } from "../lib/store";
import {
  qualified,
  type ForeignKey,
  type Metadata,
  type SchemaBatch,
  type SchemaTable,
  type Tab,
  type TableRef,
} from "../lib/types";
import {
  buildSchemaGraph,
  filterSchemaTables,
  relatedTables,
  SCHEMA_DIAGRAM_LIMIT,
  tableKey,
} from "../lib/schema";
type SchemaView = "catalog" | "diagram";
interface DiagramState {
  metadata: Metadata[];
  links: ForeignKey[];
  errors: {
    table: TableRef;
    error: {
      code: string;
      message: string;
    };
  }[];
  loaded: number;
  total: number;
  status: "idle" | "loading" | "ready" | "cancelled" | "error";
  message: string;
  caption: string;
}
const emptyDiagram: DiagramState = {
  metadata: [],
  links: [],
  errors: [],
  loaded: 0,
  total: 0,
  status: "idle",
  message: "",
  caption: "",
};
export function SchemaWorkspace({ tab }: { tab: Tab }) {
  const workspace = useWorkspace();
  const active = workspace.activeTab === tab.id;
  const connected = workspace.activeConnections.includes(
    tab.connectionId || "",
  );
  const connection = workspace.connections.find(
    (c) => c.id === tab.connectionId,
  );
  const tables = useRemote<TableRef[]>(
    "tables",
    { connectionId: tab.connectionId },
    connected && active,
  );
  const [view, setView] = useState<SchemaView>("catalog"),
    [mode, setMode] = useState<"all" | "focused">("all"),
    [namespace, setNamespace] = useState<string | null>(null),
    [kind, setKind] = useState("all"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const [detailsVisible, setDetailsVisible] = useLayoutPreference(
    `schema:details-visible:${tab.connectionId}`,
    z.boolean(),
    true,
  );
  const [detailsWidth, setDetailsWidth] = useLayoutPreference(
    `schema:details-width:${tab.connectionId}`,
    z.number().min(270).max(600),
    315,
  );
  function resizeDetails(event: React.PointerEvent) {
    const x = event.clientX,
      initial = detailsWidth;
    const move = (e: PointerEvent) =>
      setDetailsWidth(Math.min(600, Math.max(270, initial + x - e.clientX)));
    startResize(event, move);
  }
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(
    () =>
      filterSchemaTables(tables.data || [], deferredSearch, namespace, kind),
    [tables.data, deferredSearch, namespace, kind],
  );
  const selected = tab.schemaTable || filtered[0];
  const details = useRemote<SchemaTable>(
    "schema_table",
    { connectionId: tab.connectionId, table: selected },
    connected && active && !!selected,
  );
  const [diagram, setDiagram] = useState<DiagramState>(emptyDiagram),
    [graphKey, setGraphKey] = useState(0);
  const request = useRef<{
    cancelled: boolean;
    operationId: string;
  } | null>(null);
  const graph = useMemo(
    () => buildSchemaGraph(diagram.metadata, diagram.links),
    [diagram.metadata, diagram.links],
  );
  const stop = useCallback(() => {
    const current = request.current;
    if (current) {
      current.cancelled = true;
      if (current.operationId)
        void api("cancel_query", { operationId: current.operationId }).catch(
          () => undefined,
        );
      request.current = null;
      setDiagram((previous) =>
        previous.status === "loading"
          ? {
              ...previous,
              status: "cancelled",
              message:
                "Loading cancelled. Already loaded tables remain visible.",
            }
          : previous,
      );
    }
  }, []);
  useEffect(
    () => () => {
      const current = request.current;
      if (current) {
        current.cancelled = true;
        if (current.operationId)
          void api("cancel_query", { operationId: current.operationId }).catch(
            () => undefined,
          );
      }
    },
    [],
  );
  useEffect(() => {
    if (!active || !connected) stop();
  }, [active, connected, stop]);
  const scope = JSON.stringify([namespace, kind, deferredSearch]);
  useEffect(() => {
    stop();
    setDiagram(emptyDiagram);
  }, [scope, stop]);
  const selectTable = (table: TableRef) => {
    setDetailsVisible(true);
    patchTab(tab.id, { schemaTable: table });
  };
  async function loadDiagram(refresh = false, focused = false) {
    stop();
    if (!connected || !tab.connectionId) return;
    const token = { cancelled: false, operationId: "" };
    request.current = token;
    setGraphKey((k) => k + 1);
    let metadata: Metadata[] = [],
      links: ForeignKey[] = [],
      errors: DiagramState["errors"] = [];
    setDiagram({
      ...emptyDiagram,
      status: "loading",
      caption: focused
        ? `Relationships of ${selected?.name || "table"}`
        : namespace === null
          ? "All schemas"
          : namespace,
    });
    try {
      let targets: TableRef[];
      if (focused) {
        if (!selected)
          throw new Error("Select a table to inspect its relationships.");
        const info = await api<SchemaTable>("schema_table", {
          connectionId: tab.connectionId,
          table: selected,
          refresh,
        });
        if (token.cancelled) return;
        targets = [
          info.metadata.table,
          ...relatedTables(info.metadata.table, [
            ...info.metadata.foreignKeys,
            ...info.incoming,
          ]),
        ].slice(0, 40);
        metadata = [info.metadata];
        links = [...info.metadata.foreignKeys, ...info.incoming];
      } else targets = filtered.slice(0, SCHEMA_DIAGRAM_LIMIT);
      if (!targets.length) {
        setDiagram({
          ...emptyDiagram,
          status: "ready",
          caption: "No matching tables",
        });
        return;
      }
      let completed = metadata.length;
      setDiagram((d) => ({
        ...d,
        metadata: [...metadata],
        links,
        loaded: completed,
        total: targets.length,
      }));
      const remaining = targets.filter(
        (t) => !metadata.some((m) => tableKey(m.table) === tableKey(t)),
      );
      for (let i = 0; i < remaining.length; i += 24) {
        if (token.cancelled) return;
        token.operationId = crypto.randomUUID();
        const batch = await api<SchemaBatch>("schema_batch", {
          connectionId: tab.connectionId,
          tables: remaining.slice(i, i + 24),
          operationId: token.operationId,
          refresh: refresh && i === 0,
        });
        if (token.cancelled) return;
        metadata = [...metadata, ...batch.tables];
        errors = [...errors, ...batch.errors];
        completed += remaining.slice(i, i + 24).length;
        setDiagram((d) => ({
          ...d,
          metadata: [...metadata],
          errors: [...errors],
          loaded: completed,
          total: targets.length,
        }));
      }
      if (!token.cancelled) setDiagram((d) => ({ ...d, status: "ready" }));
    } catch (error) {
      if (!token.cancelled)
        setDiagram((d) => ({
          ...d,
          status: "error",
          message: errorMessage(error),
        }));
    } finally {
      if (request.current === token) request.current = null;
    }
  }
  function openData(table: TableRef) {
    openTab({
      kind: "table",
      title: table.name,
      connectionId: tab.connectionId,
      table,
    });
  }
  function openQuery(table: TableRef) {
    openTab({
      kind: "query",
      title: `${table.name} query`,
      connectionId: tab.connectionId,
      sql: `SELECT * FROM ${qualified(table)};`,
      savedSql: "",
    });
  }
  if (!connection)
    return (
      <Empty
        icon={<Database size={26} />}
        title="Choose a connection"
        detail="Open the schema viewer from a connected database in the sidebar."
      />
    );
  if (!connected)
    return (
      <Empty
        icon={<Database size={26} />}
        title={`${connection.name} is disconnected`}
        detail="Reconnect from the sidebar to inspect its schema. No database changes are required."
      />
    );
  const namespaces = [...new Set((tables.data || []).map((t) => t.schema))]
    .filter(Boolean)
    .sort();
  const tableCount = (tables.data || []).filter(
      (t) => t.kind === "table",
    ).length,
    viewCount = (tables.data || []).filter((t) => t.kind === "view").length;
  return (
    <div className="schema-workspace">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">{connection.name} / Database structure</div>
          <h1>
            <Database size={20} />
            Schema viewer<Tag>{tableCount} tables</Tag>
            {viewCount > 0 && <Tag>{viewCount} views</Tag>}
          </h1>
        </div>
        <div className="spacer" />
        <Button
          size="sm"
          variant="secondary"
          disabled={diagram.status === "loading"}
          onClick={() => {
            invalidate("metadata:");
            invalidate("schema_table:");
            void tables.refresh();
            void details.refresh();
            if (view === "diagram" && diagram.status !== "idle")
              void loadDiagram(true, mode === "focused");
          }}
        >
          <RefreshCw
            size={14}
            className={tables.loading || details.loading ? "spin" : ""}
          />
          Refresh metadata
        </Button>
      </div>
      <div className="schema-toolbar">
        <nav className="inline-tabs" aria-label="Schema views">
          <button
            className={view === "catalog" ? "active" : ""}
            onClick={() => {
              stop();
              setView("catalog");
            }}
          >
            <Columns3 size={13} />
            Catalog
          </button>
          <button
            className={view === "diagram" ? "active" : ""}
            onClick={() => setView("diagram")}
          >
            <Network size={13} />
            ER diagram
          </button>
        </nav>
        <div className="spacer" />
        <span className="schema-readonly">
          Metadata only · no source changes
        </span>
      </div>
      <div className="schema-filters">
        <div className="schema-search">
          <Search size={14} />
          <input
            aria-label="Search schema tables"
            placeholder="Search tables and views…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </div>
        {connection.driver !== "sqlite" && (
          <Select
            aria-label="Schema namespace"
            value={namespace === null ? "" : JSON.stringify(namespace)}
            onValueChange={(value) => {
              setNamespace(value ? (JSON.parse(value) as string) : null);
              setPage(0);
            }}
          >
            <SelectItem value="">All schemas</SelectItem>
            {namespaces.map((name) => (
              <SelectItem key={name} value={JSON.stringify(name)}>
                {name}
              </SelectItem>
            ))}
          </Select>
        )}
        <Select
          aria-label="Schema object type"
          value={kind}
          onValueChange={(value) => {
            setKind(value);
            setPage(0);
          }}
        >
          <SelectItem value="all">Tables and views</SelectItem>
          <SelectItem value="table">Tables</SelectItem>
          <SelectItem value="view">Views</SelectItem>
        </Select>
        <span className="muted">{filtered.length} matching</span>
      </div>
      {tables.error && (
        <ErrorState error={tables.error} retry={() => void tables.refresh()} />
      )}{" "}
      {tables.loading && !tables.data ? (
        <Loading label="Reading database structure…" />
      ) : !tables.data?.length ? (
        <Empty
          icon={<Table2 size={25} />}
          title="No tables or views"
          detail="This connection has no visible user tables or views. Refresh after creating one explicitly in the SQL editor."
        />
      ) : view === "catalog" ? (
        <div className="schema-catalog">
          <nav className="schema-table-list" aria-label="Schema tables">
            {filtered.slice(page * 100, (page + 1) * 100).map((table) => (
              <button
                key={tableKey(table)}
                className={
                  selected && tableKey(selected) === tableKey(table)
                    ? "selected"
                    : ""
                }
                onClick={() => selectTable(table)}
              >
                <Table2 size={14} />
                <span>
                  {table.name}
                  <small>{table.schema || connection.name}</small>
                </span>
                <Tag>{table.kind}</Tag>
              </button>
            ))}
            {!filtered.length && (
              <p className="muted pad">No matching tables or views.</p>
            )}
            {filtered.length > 100 && (
              <div className="pagination">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!page}
                  aria-label="Previous schema tables"
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={14} />
                </Button>
                <span>
                  {page + 1} / {Math.ceil(filtered.length / 100)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={(page + 1) * 100 >= filtered.length}
                  aria-label="Next schema tables"
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </nav>
          <div className="schema-catalog-details">
            {details.loading && !details.data ? (
              <Loading label="Inspecting table structure…" />
            ) : details.error ? (
              <ErrorState
                error={details.error}
                retry={() => void details.refresh()}
              />
            ) : details.data ? (
              <SchemaDetails
                info={details.data}
                onSelect={selectTable}
                onData={openData}
                onQuery={openQuery}
                onDiagram={() => {
                  setView("diagram");
                  setMode("focused");
                  void loadDiagram(false, true);
                }}
              />
            ) : (
              <Empty
                title="Select a table"
                detail="Inspect columns, keys, indexes, relationships, and available source SQL."
              />
            )}
          </div>
        </div>
      ) : view === "diagram" ? (
        <>
          <div className="schema-diagram-toolbar">
            <Select
              aria-label="Diagram scope"
              value={mode}
              onValueChange={(value) => {
                stop();
                setMode(value as "all" | "focused");
                setDiagram(emptyDiagram);
              }}
            >
              <SelectItem value="all">Full database ER diagram</SelectItem>
              <SelectItem value="focused">
                Focused table relationships
              </SelectItem>
            </Select>
            <span className="muted">
              {diagram.caption ||
                (mode === "focused"
                  ? selected?.name
                  : "Load metadata to visualize declared relationships")}
            </span>
            <div className="spacer" />
            <Button
              variant="ghost"
              size="icon"
              title={
                detailsVisible ? "Hide table details" : "Show table details"
              }
              aria-label={
                detailsVisible ? "Hide table details" : "Show table details"
              }
              onClick={() => setDetailsVisible((value) => !value)}
            >
              <PanelRight size={15} />
            </Button>
            {diagram.status === "loading" ? (
              <>
                <span className="muted" role="status">
                  Loading {diagram.loaded}/{diagram.total}
                </span>
                <Button variant="secondary" size="sm" onClick={stop}>
                  <Square size={12} />
                  Cancel loading
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={!filtered.length || (mode === "focused" && !selected)}
                onClick={() => void loadDiagram(false, mode === "focused")}
              >
                <Network size={13} />
                {diagram.status === "idle" ? "Load diagram" : "Reload diagram"}
              </Button>
            )}
          </div>
          {mode === "all" && filtered.length > SCHEMA_DIAGRAM_LIMIT && (
            <p className="schema-limit-note">
              The diagram loads the first {SCHEMA_DIAGRAM_LIMIT} of{" "}
              {filtered.length} matching tables/views. Choose a schema or narrow
              the search to inspect another scope.
            </p>
          )}
          {mode === "focused" && diagram.total === 40 && (
            <p className="schema-limit-note">
              Focused loading is limited to 40 tables. Other references may
              appear without column metadata.
            </p>
          )}
          {diagram.message &&
            (diagram.status === "cancelled" ? (
              <p className="schema-limit-note" role="status">
                {diagram.message}
              </p>
            ) : (
              <ErrorState error={diagram.message} />
            ))}{" "}
          {!!diagram.errors.length && (
            <details className="schema-load-errors">
              <summary>
                {diagram.errors.length} tables could not be loaded
              </summary>
              {diagram.errors.map((item) => (
                <p key={tableKey(item.table)}>
                  {item.table.name}: {item.error.message}
                </p>
              ))}
            </details>
          )}
          {graph.omittedRelationships > 0 && (
            <p className="schema-limit-note">
              {graph.omittedRelationships} relationships are not shown because
              of scope or the relationship limit.
            </p>
          )}
          <div className="schema-diagram-layout">
            {graph.nodes.length ? (
              <SchemaDiagram
                key={graphKey}
                graph={graph}
                preferenceKey={`schema:positions:${tab.connectionId}:${mode}:${mode === "focused" && selected ? tableKey(selected) : "all"}`}
                selected={selected}
                onSelect={selectTable}
              />
            ) : diagram.status === "loading" ? (
              <Loading label="Loading schema metadata…" />
            ) : (
              <Empty
                icon={<Network size={28} />}
                title="See how your database fits together"
                detail="Load a full ER diagram or focus on one table. Right-click a table to hide it or isolate its relationships."
              />
            )}
            {detailsVisible && selected && details.data && (
              <aside
                className="schema-diagram-details"
                style={{ width: detailsWidth }}
              >
                <div
                  className="vertical-resize left"
                  role="separator"
                  aria-label="Resize schema table details"
                  aria-orientation="vertical"
                  onPointerDown={resizeDetails}
                />
                <SchemaDetails
                  compact
                  info={details.data}
                  onSelect={selectTable}
                  onData={openData}
                  onQuery={openQuery}
                  onDiagram={() => {
                    setMode("focused");
                    void loadDiagram(false, true);
                  }}
                />
              </aside>
            )}
          </div>
        </>
      ) : (
        <></>
      )}
    </div>
  );
}
function SchemaDetails({
  info,
  onSelect,
  onData,
  onQuery,
  onDiagram,
  compact = false,
}: {
  info: SchemaTable;
  onSelect: (table: TableRef) => void;
  onData: (table: TableRef) => void;
  onQuery: (table: TableRef) => void;
  onDiagram: () => void;
  compact?: boolean;
}) {
  const [section, setSection] = useState("columns");
  const { metadata, incoming, definition } = info;
  const table = metadata.table;
  const sections = [
    ["columns", "Columns"],
    ["keys", "Keys & indexes"],
    ["relationships", "Relationships"],
    ...(definition ? [["sql", "Source SQL"]] : []),
  ];
  const current = sections.some(([key]) => key === section)
    ? section
    : "columns";
  return (
    <section className={`schema-details ${compact ? "compact" : ""}`}>
      <header className="schema-details-heading">
        <div>
          <div className="eyebrow">{table.schema || "SQLite database"}</div>
          <h2>
            <Table2 size={17} />
            {table.name}
            <Tag>{table.kind}</Tag>
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="Copy qualified table name"
          onClick={() => void copyFeedback(qualified(table))}
        >
          <Copy size={13} />
        </Button>
      </header>
      <div className="schema-table-actions">
        <Button variant="secondary" size="sm" onClick={() => onData(table)}>
          <Table2 size={13} />
          Open data
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onQuery(table)}>
          <FileCode2 size={13} />
          Query
        </Button>
        <Button variant="ghost" size="sm" onClick={onDiagram}>
          <Network size={13} />
          Focus diagram
        </Button>
      </div>
      <nav className="schema-detail-tabs" aria-label="Table metadata sections">
        {sections.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={current === key}
            className={current === key ? "active" : ""}
            onClick={() => setSection(key)}
          >
            {label}
            {key === "columns" && <span>{metadata.columns.length}</span>}
            {key === "relationships" && (
              <span>{metadata.foreignKeys.length + incoming.length}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="schema-details-content">
        {current === "columns" ? (
          <>
            <table className="schema-columns">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  {!compact && <th>Default</th>}
                </tr>
              </thead>
              <tbody>
                {metadata.columns.map((column) => (
                  <tr key={column.name}>
                    <td>
                      <Tooltip content={`Copy column ${column.name}`}>
                        <button onClick={() => void copyFeedback(column.name)}>
                          {column.pk > 0 ? (
                            <KeyRound size={11} className="accent" />
                          ) : (
                            <span className="column-dot" />
                          )}
                          <span>{column.name}</span>
                        </button>
                      </Tooltip>
                      {compact && column.defaultValue && (
                        <Tooltip content={column.defaultValue}>
                          <small>
                            Default: {column.defaultValue.slice(0, 60)}
                          </small>
                        </Tooltip>
                      )}
                    </td>
                    <td>
                      <code>{column.dataType || "dynamic"}</code>
                    </td>
                    <td>{column.nullable ? "Yes" : "No"}</td>
                    {!compact && (
                      <td>
                        <Tooltip content={column.defaultValue || undefined}>
                          <code>
                            {column.defaultValue === null
                              ? "—"
                              : column.defaultValue.slice(0, 120)}
                          </code>
                        </Tooltip>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="schema-footnote">
              {metadata.columns.filter((c) => c.pk > 0).length} primary-key
              columns · {metadata.columns.filter((c) => c.nullable).length}{" "}
              nullable columns
            </p>
          </>
        ) : current === "keys" ? (
          <>
            <h3>Primary key</h3>
            {metadata.columns.some((c) => c.pk > 0) ? (
              <div className="schema-index">
                <KeyRound size={14} className="accent" />
                <code>
                  {metadata.columns
                    .filter((c) => c.pk > 0)
                    .sort((a, b) => a.pk - b.pk)
                    .map((c) => c.name)
                    .join(", ")}
                </code>
              </div>
            ) : (
              <p className="muted small">No primary key is declared.</p>
            )}
            <h3>
              Indexes <Tag>{metadata.indexes.length}</Tag>
            </h3>
            {metadata.indexes.length ? (
              metadata.indexes.map((index) => (
                <div className="schema-index" key={index.name}>
                  <div>
                    <strong>{index.name}</strong>
                    {index.unique && <Tag>unique</Tag>}
                    {index.partial && <Tag>partial</Tag>}
                  </div>
                  <code>
                    {index.columns.map((c) => c || "expression").join(", ")}
                  </code>
                </div>
              ))
            ) : (
              <p className="muted small">
                No indexes were reported by the database.
              </p>
            )}
          </>
        ) : current === "relationships" ? (
          <>
            <h3>
              Outgoing <Tag>{metadata.foreignKeys.length}</Tag>
            </h3>
            {metadata.foreignKeys.map((key) => (
              <div className="schema-relationship" key={key.name}>
                <div>
                  <ArrowUpRight size={14} />
                  <strong>{key.name}</strong>
                </div>
                <code>
                  {key.columns.join(", ")} → {key.to.name} (
                  {key.targetColumns.join(", ")})
                </code>
                <button onClick={() => onSelect(key.to)}>
                  Inspect {key.to.schema ? `${key.to.schema}.` : ""}
                  {key.to.name}
                  <ChevronRight size={12} />
                </button>
              </div>
            ))}
            {!metadata.foreignKeys.length && (
              <p className="muted small">
                This table does not reference other tables.
              </p>
            )}
            <h3>
              Incoming <Tag>{incoming.length}</Tag>
            </h3>
            {incoming.map((key) => (
              <div
                className="schema-relationship"
                key={`${tableKey(key.from)}:${key.name}`}
              >
                <div>
                  <ArrowDownLeft size={14} />
                  <strong>{key.name}</strong>
                </div>
                <code>
                  {key.from.name} ({key.columns.join(", ")}) →{" "}
                  {key.targetColumns.join(", ")}
                </code>
                <button onClick={() => onSelect(key.from)}>
                  Inspect {key.from.schema ? `${key.from.schema}.` : ""}
                  {key.from.name}
                  <ChevronRight size={12} />
                </button>
              </div>
            ))}
            {!incoming.length && (
              <p className="muted small">
                No declared foreign keys reference this table.
              </p>
            )}
          </>
        ) : definition ? (
          <>
            <div className="schema-sql-heading">
              <span className="muted">Definition reported by SQLite</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void copyFeedback(definition)}
              >
                <Copy size={13} />
                Copy SQL
              </Button>
            </div>
            <pre className="schema-source-sql">
              {definition.slice(0, 150000)}
            </pre>
            {definition.length > 150000 && (
              <p className="schema-footnote">
                Display truncated. Copy SQL retrieves the complete definition.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
