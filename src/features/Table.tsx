import {
  ReferenceValuePicker,
  useReferenceDisplay,
} from "../components/ReferenceValuePicker";
import { ExportTable } from "../components/ExportTable";
import { FilterBuilder } from "../components/FilterBuilder";
import {
  TableMutation,
  type TableMutationKind,
} from "../components/TableMutation";
import { Select, SelectItem } from "../components/ui/select";
import { useEffect, useMemo, useState } from "react";
import {
  Eye,
  Download,
  Plus,
  Pencil,
  Trash2,
  Filter as FilterIcon,
  KeyRound,
  Network,
  RefreshCw,
  Table2,
  Gauge,
  ChevronLeft,
  ChevronRight,
  Copy,
  X,
} from "lucide-react";
import { EditCell } from "../components/EditCell";
import { notify } from "../lib/store";
import { DataGrid } from "../components/DataGrid";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import {
  DisconnectedState,
  ErrorState,
  Loading,
  Tag,
} from "../components/shared";
import { api, errorMessage, useRemote } from "../lib/api";
import { openTab, patchTab, update, useWorkspace } from "../lib/store";
import {
  rowKey,
  identityColumns,
  type DbValue,
  type Filter,
  type IndexAdvice,
  type Metadata,
  type ResultSet,
  type RowCounts,
  type RowEstimate,
  type Tab,
} from "../lib/types";
export function TableWorkspace({ tab }: { tab: Tab }) {
  const workspace = useWorkspace();
  const [exporting, setExporting] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [editing, setEditing] = useState<{
    record: import("../lib/types").RecordRef;
    column: string;
    before: DbValue;
    nullable: boolean;
  }>();
  const connection = workspace.connections.find(
    (c) => c.id === tab.connectionId,
  );
  const writable =
    !!tab.connectionId && workspace.readOnly[tab.connectionId] === false;
  const [offset, setOffset] = useState(tab.offset || 0);
  const [cursorPages, setCursorPages] = useState<Array<DbValue[] | null>>([
    null,
  ]);
  const [cursorPage, setCursorPage] = useState(0);
  const [keysetMode, setKeysetMode] = useState(!tab.offset && !tab.sort);
  const [limit, setLimit] = useState(tab.limit || workspace.settings.pageSize);
  const [sort, setSort] = useState(tab.sort || "");
  const [descending, setDescending] = useState(tab.descending || false);
  const [filters, setFilters] = useState<Filter[]>(tab.filters || []);
  const [filtering, setFiltering] = useState(false);
  const [filterGroups, setFilterGroups] = useState(tab.filterGroups || []);
  const editorGroups = useMemo(
    () => [
      ...(filters.length ? [{ mode: "all", filters }] : []),
      ...filterGroups,
    ],
    [filters, filterGroups],
  );
  const [groupMode, setGroupMode] = useState(tab.groupMode || "all");
  const filterCount =
    filters.length +
    filterGroups.reduce((count, group) => count + group.filters.length, 0);
  const [rowCounts, setRowCounts] = useState<RowCounts>();
  const [countingRows, setCountingRows] = useState(false);
  const [rowEstimate, setRowEstimate] = useState<RowEstimate>();
  const [estimatingRows, setEstimatingRows] = useState(false);
  const [indexDialogOpen, setIndexDialogOpen] = useState(false);
  const [indexAdvice, setIndexAdvice] = useState<IndexAdvice>();
  const [checkingIndexes, setCheckingIndexes] = useState(false);
  const [indexAdviceError, setIndexAdviceError] = useState("");
  const [selected, setSelected] = useState<DbValue[]>();
  const [selection, setSelection] = useState<{
    result: ResultSet;
    indices: number[];
  }>();
  const [mutation, setMutation] = useState<{
    kind: TableMutationKind;
    result: ResultSet;
    indices: number[];
    metadata: Metadata;
  }>();
  const connected = workspace.activeConnections.includes(
    tab.connectionId || "",
  );
  function resetPaging() {
    setOffset(0);
    setCursorPages([null]);
    setCursorPage(0);
    setKeysetMode(true);
  }
  const metadata = useRemote<Metadata>(
    "metadata",
    { connectionId: tab.connectionId, table: tab.table },
    connected && workspace.activeTab === tab.id,
    0,
    true,
  );
  const keysetRequested = keysetMode && !sort;
  const pageCursor = keysetRequested ? (cursorPages[cursorPage] ?? null) : null;
  const rows = useRemote<ResultSet>(
    "browse",
    {
      connectionId: tab.connectionId,
      table: tab.table,
      filters,
      filterGroups,
      groupMode,
      sort,
      descending,
      offset,
      keyset: keysetRequested,
      cursor: pageCursor,
      limit,
    },
    connected && workspace.activeTab === tab.id && tab.kind === "table",
    0,
    true,
  );
  const [referenceColumn, setReferenceColumn] = useState<string>();
  const referenceDisplay = useReferenceDisplay(
    `reference-display:${JSON.stringify([tab.connectionId, tab.table?.schema, tab.table?.name])}`,
    tab.connectionId || "",
    rows.loading ? undefined : rows.data,
    metadata.data,
    connected && workspace.activeTab === tab.id && tab.kind === "table",
  );
  const selectedIndices =
    selection?.result === rows.data ? selection?.indices || [] : [];
  const selectable =
    writable &&
    tab.table?.kind === "table" &&
    !!metadata.data &&
    identityColumns(metadata.data).length > 0;
  function mutate(kind: TableMutationKind, indices = selectedIndices) {
    if (!rows.data || !metadata.data || rows.loading) return;
    setMutation({
      kind,
      result: rows.data,
      indices: [...indices],
      metadata: metadata.data,
    });
  }
  async function countRows() {
    if (!tab.table || !tab.connectionId || countingRows) return;
    setCountingRows(true);
    try {
      setRowCounts(
        await api<RowCounts>("count_rows", {
          connectionId: tab.connectionId,
          table: tab.table,
          filters,
          filterGroups,
          groupMode,
        }),
      );
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setCountingRows(false);
    }
  }
  async function estimateRows() {
    if (!tab.table || !tab.connectionId || estimatingRows) return;
    setEstimatingRows(true);
    try {
      const estimate = await api<RowEstimate>("estimate_rows", {
        connectionId: tab.connectionId,
        table: tab.table,
      });
      setRowEstimate(estimate);
      if (estimate.total === null)
        notify(`No quick estimate available. ${estimate.source}.`, true);
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setEstimatingRows(false);
    }
  }
  async function reviewIndexes() {
    if (!tab.table || !tab.connectionId || checkingIndexes) return;
    setIndexDialogOpen(true);
    setCheckingIndexes(true);
    setIndexAdviceError("");
    try {
      setIndexAdvice(
        await api<IndexAdvice>("index_advice", {
          connectionId: tab.connectionId,
          table: tab.table,
        }),
      );
    } catch (error) {
      setIndexAdviceError(errorMessage(error));
    } finally {
      setCheckingIndexes(false);
    }
  }
  function nextPage() {
    if (!rows.data?.truncated || rows.loading) return;
    if (keysetRequested && rows.data.keysetSupported && rows.data.nextCursor) {
      const nextPageIndex = cursorPage + 1;
      setCursorPages((pages) => [
        ...pages.slice(0, nextPageIndex),
        rows.data!.nextCursor!,
      ]);
      setCursorPage(nextPageIndex);
    } else {
      setKeysetMode(false);
    }
    setOffset((n) => n + limit);
  }
  function previousPage() {
    if (rows.loading) return;
    if (keysetRequested && cursorPage > 0) {
      setCursorPage((page) => page - 1);
    } else {
      setKeysetMode(false);
    }
    setOffset((n) => Math.max(0, n - limit));
  }
  useEffect(() => {
    setSelection(undefined);
    setSelected(undefined);
  }, [offset, limit, sort, descending, filters, filterGroups, groupMode]);
  useEffect(() => setRowCounts(undefined), [filters, filterGroups, groupMode]);
  useEffect(() => {
    if (
      tab.filters &&
      JSON.stringify(tab.filters) !== JSON.stringify(filters)
    ) {
      setFilters(tab.filters);
      resetPaging();
    }
    if (
      tab.filterGroups &&
      JSON.stringify(tab.filterGroups) !== JSON.stringify(filterGroups)
    ) {
      setFilterGroups(tab.filterGroups);
      setGroupMode(tab.groupMode || "all");
      resetPaging();
    }
    if (tab.offset !== undefined && tab.offset !== offset) {
      setOffset(tab.offset);
      setCursorPages([null]);
      setCursorPage(0);
      setKeysetMode(tab.offset === 0 && !tab.sort);
    }
    if (tab.sort !== undefined && tab.sort !== sort) {
      setSort(tab.sort);
      resetPaging();
    }
    if (tab.descending !== undefined && tab.descending !== descending)
      setDescending(tab.descending);
  }, [
    tab.filters,
    tab.filterGroups,
    tab.groupMode,
    tab.offset,
    tab.sort,
    tab.descending,
  ]);
  useEffect(() => {
    patchTab(tab.id, {
      filters,
      filterGroups,
      groupMode,
      offset,
      limit,
      sort,
      descending,
    });
  }, [
    tab.id,
    filters,
    filterGroups,
    groupMode,
    offset,
    limit,
    sort,
    descending,
  ]);
  function record() {
    if (
      !selected ||
      !metadata.data ||
      !rows.data ||
      !tab.table ||
      !tab.connectionId
    )
      return null;
    const key = rowKey(metadata.data, rows.data.columns, selected);
    return Object.keys(key).length
      ? { connectionId: tab.connectionId, table: tab.table, key }
      : null;
  }
  const ref = record();
  if (!connected)
    return (
      <DisconnectedState
        connection={connection?.name}
        table={tab.table?.name}
        onReconnect={() =>
          window.dispatchEvent(
            new CustomEvent("kitsune:open-connection", { detail: connection }),
          )
        }
      />
    );
  if (!tab.table) return null;
  return (
    <div className="workspace-page">
      <Dialog
        open={indexDialogOpen}
        onClose={() => setIndexDialogOpen(false)}
        title="Relationship index review"
        description="Read-only check of indexes that begin with foreign-key columns. Kitsune will not create or change indexes."
        wide
      >
        {checkingIndexes ? (
          <Loading label="Checking relationship indexes…" />
        ) : indexAdviceError ? (
          <ErrorState error={indexAdviceError} />
        ) : indexAdvice?.recommendations.length ? (
          <div className="index-advice-list">
            {indexAdvice.recommendations.map((item) => (
              <div
                className="notice"
                key={`${item.direction}:${item.table.schema}:${item.table.name}:${item.foreignKey}`}
              >
                <strong>
                  {item.table.schema ? `${item.table.schema}.` : ""}
                  {item.table.name}
                </strong>
                <span>
                  {item.direction} relationship to{" "}
                  {item.relatedTable.schema
                    ? `${item.relatedTable.schema}.`
                    : ""}
                  {item.relatedTable.name} has no supporting index starting with{" "}
                  {item.columns.join(", ")}.
                </span>
              </div>
            ))}
            {indexAdvice.truncated && (
              <p className="muted">
                Showing the first 200 missing-index recommendations.
              </p>
            )}
            <p className="muted small">
              Review index candidates against real query plans and write
              workload before applying them.
            </p>
          </div>
        ) : (
          <div className="notice">
            No missing foreign-key index prefixes were found for this table’s
            incoming or outgoing relationships.
          </div>
        )}
      </Dialog>
      {referenceColumn && metadata.data && (
        <ReferenceValuePicker
          key={referenceColumn}
          column={referenceColumn}
          foreignKeys={metadata.data.foreignKeys}
          connectionId={tab.connectionId || ""}
          preferences={referenceDisplay.preferences}
          onChange={referenceDisplay.setPreferences}
          onClose={() => setReferenceColumn(undefined)}
        />
      )}
      {exporting && metadata.data && (
        <ExportTable
          metadata={metadata.data}
          visibleColumns={visibleColumns}
          sensitiveColumns={workspace.settings.sensitiveColumns}
          request={{
            connectionId: tab.connectionId || "",
            table: tab.table,
            filters,
            filterGroups,
            groupMode,
            sort,
            descending,
            offset,
            keyset: false,
            cursor: null,
            limit,
          }}
          onClose={() => setExporting(false)}
        />
      )}
      {mutation && tab.table && tab.connectionId && (
        <TableMutation
          {...mutation}
          connectionId={tab.connectionId}
          connectionName={connection?.name || "Database"}
          environment={connection?.environment || "development"}
          table={tab.table}
          onClose={() => setMutation(undefined)}
          onSaved={() => {
            setSelection(undefined);
            setSelected(undefined);
            void rows.refresh();
          }}
        />
      )}
      {editing && (
        <EditCell
          {...editing}
          connection={connection?.name || "Database"}
          environment={connection?.environment || "development"}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setSelected(undefined);
            void rows.refresh();
          }}
        />
      )}
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">
            {workspace.connections.find((c) => c.id === tab.connectionId)?.name}
            {tab.table.schema && ` / ${tab.table.schema}`}
          </div>
          <h1>
            <Table2 size={20} />
            {tab.table.name}
            <Tag>{tab.table.kind}</Tag>
          </h1>
        </div>
        <div className="spacer" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void rows.refresh();
            void metadata.refresh();
          }}
        >
          <RefreshCw size={14} className={rows.loading ? "spin" : ""} />
          Refresh
        </Button>
      </div>
      <div className="workspace-toolbar">
        {tab.kind === "table" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!rows.data || !metadata.data}
            onClick={() => setExporting(true)}
          >
            <Download size={13} />
            Export…
          </Button>
        )}
        {tab.kind === "table" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={checkingIndexes}
            onClick={() => void reviewIndexes()}
            title="Check relationship index coverage without changing the database"
          >
            <Gauge size={13} />
            Index review
          </Button>
        )}

        <div className="inline-tabs">
          <button
            className={tab.kind === "table" ? "active" : ""}
            onClick={() =>
              openTab({
                kind: "table",
                title: tab.table!.name,
                table: tab.table,
                connectionId: tab.connectionId,
              })
            }
          >
            Data
          </button>
          <button
            className={tab.kind === "structure" ? "active" : ""}
            onClick={() =>
              openTab({
                kind: "structure",
                title: `${tab.table!.name} structure`,
                table: tab.table,
                connectionId: tab.connectionId,
              })
            }
          >
            Structure
          </button>
        </div>
        <div className="spacer" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            openTab({
              kind: "schema",
              title: "Schema viewer",
              connectionId: tab.connectionId,
              schemaTable: tab.table,
            })
          }
        >
          <Network size={14} />
          View schema
        </Button>
        {tab.kind === "table" && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFiltering((v) => !v)}
            >
              <FilterIcon size={14} />
              Filter{filterCount ? ` (${filterCount})` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!ref}
              onClick={() =>
                ref &&
                openTab({
                  kind: "investigation",
                  title: `Investigate ${tab.table!.name}`,
                  connectionId: tab.connectionId,
                  root: ref,
                })
              }
            >
              <Network size={14} />
              Investigate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("kitsune:watch", {
                    detail: ref || {
                      connectionId: tab.connectionId,
                      table: tab.table,
                      filters,
                      filterGroups,
                      groupMode,
                      kind: "table",
                    },
                  }),
                )
              }
            >
              <Eye size={14} />
              {ref ? "Watch record" : "Watch table"}
            </Button>
          </>
        )}
      </div>
      {tab.kind === "table" && (
        <p className="table-edit-hint">
          {!writable
            ? "Read-only connection. Enable write access explicitly from the connection controls to edit."
            : metadata.data && !identityColumns(metadata.data).length
              ? "This table has no reliable unique key; use an explicit SQL query to edit."
              : tab.table.kind !== "table"
                ? "Views can be inspected here; use an explicit SQL query for changes."
                : "Double-click a value to edit · F2 edits the selected cell · Enter inspects its full value"}
        </p>
      )}
      {filtering && metadata.data && (
        <FilterBuilder
          metadata={metadata.data}
          driver={connection?.driver || "sqlite"}
          groups={editorGroups}
          mode={groupMode}
          onApply={(groups, mode) => {
            setFilters([]);
            setFilterGroups(groups);
            setFiltering(false);
            setGroupMode(mode);
            resetPaging();
          }}
          preferenceKey={`filters:${tab.connectionId}:${tab.table.schema}:${tab.table.name}`}
        />
      )}
      {(!!filters.length || !!filterGroups.length) && (
        <div className="filter-chips">
          {filters.map((f, i) => (
            <button
              key={`legacy-${i}`}
              onClick={() => {
                setFilters((fs) => fs.filter((_, n) => n !== i));
                resetPaging();
              }}
            >
              {f.column} {f.operator}{" "}
              {"value" in f.value ? String(f.value.value).slice(0, 30) : "NULL"}
              <X size={11} />
            </button>
          ))}
          {filterGroups.map((group, g) => (
            <button
              key={g}
              title="Remove filter group"
              onClick={() => {
                setFilterGroups((gs) => gs.filter((_, i) => i !== g));
                resetPaging();
              }}
            >
              {group.filters
                .map(
                  (f) =>
                    `${f.column} ${f.operator} ${"value" in f.value ? String(f.value.value).slice(0, 30) : "NULL"}`,
                )
                .join(group.mode === "any" ? " OR " : " AND ")}
              <X size={11} />
            </button>
          ))}
        </div>
      )}
      {metadata.error && (
        <ErrorState
          error={metadata.error}
          retry={() => void metadata.refresh()}
        />
      )}{" "}
      {tab.kind === "structure" ? (
        metadata.loading ? (
          <Loading />
        ) : (
          metadata.data && (
            <div className="structure">
              <h3>
                Columns <Tag>{metadata.data.columns.length}</Tag>
              </h3>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {metadata.data.columns.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.pk > 0 && <KeyRound size={12} className="accent" />}{" "}
                        {c.name}
                      </td>
                      <td className="mono">
                        {c.dataType}
                        {c.enumType &&
                          (() => {
                            const values = metadata.data!.enums.find(
                              (item) =>
                                item.schema === c.enumType!.schema &&
                                item.name === c.enumType!.name,
                            )?.values;
                            return values ? (
                              <details className="enum-values">
                                <summary>
                                  {c.enumType.name} · {values.length} values
                                </summary>
                                <div>
                                  <code>{values.join(", ")}</code>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void navigator.clipboard.writeText(
                                        values.join("\n"),
                                      )
                                    }
                                  >
                                    <Copy size={12} /> Copy
                                  </Button>
                                </div>
                              </details>
                            ) : null;
                          })()}
                      </td>
                      <td>{c.nullable ? "Yes" : "No"}</td>
                      <td className="mono">{c.defaultValue || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>
                Foreign keys <Tag>{metadata.data.foreignKeys.length}</Tag>
              </h3>
              {metadata.data.foreignKeys.map((f) => (
                <div className="metadata-item" key={f.name}>
                  <Network size={15} />
                  <strong>{f.name}</strong>
                  <code>
                    {f.columns.join(", ")} → {f.to.name} (
                    {f.targetColumns.join(", ")})
                  </code>
                </div>
              ))}
              {!metadata.data.foreignKeys.length && (
                <p className="muted">No declared foreign keys.</p>
              )}
              <h3>
                Indexes <Tag>{metadata.data.indexes.length}</Tag>
              </h3>
              {metadata.data.indexes.map((i) => (
                <div className="metadata-item" key={i.name}>
                  <KeyRound size={14} />
                  <strong>{i.name}</strong>
                  <code>{i.columns.join(", ")}</code>
                  {i.unique && <Tag>unique</Tag>}
                </div>
              ))}
            </div>
          )
        )
      ) : (
        <>
          {rows.error && (
            <ErrorState error={rows.error} retry={() => void rows.refresh()} />
          )}{" "}
          {rows.loading && !rows.data ? (
            <Loading label="Fetching table data…" />
          ) : (
            rows.data && (
              <DataGrid
                result={rows.data}
                foreignKeys={metadata.data?.foreignKeys}
                referenceLabels={referenceDisplay.labels}
                referenceForeignKeys={referenceDisplay.foreignKeys}
                onReferenceDisplay={setReferenceColumn}
                onForeignKey={(foreignKey, row) => {
                  const filters = foreignKey.columns.map((column, index) => ({
                    column: foreignKey.targetColumns[index],
                    operator: "eq",
                    value: row[rows.data!.columns.indexOf(column)],
                  }));
                  openTab({
                    kind: "table",
                    title: foreignKey.to.name,
                    connectionId: tab.connectionId,
                    table: foreignKey.to,
                    filters,
                    filterGroups: [],
                    groupMode: "all",
                  });
                }}
                onVisibleColumns={setVisibleColumns}
                preferenceKey={`grid:${tab.connectionId}:${tab.table.schema}:${tab.table.name}`}
                onInvestigate={
                  metadata.data && identityColumns(metadata.data).length
                    ? (row) => {
                        const key = rowKey(
                          metadata.data!,
                          rows.data!.columns,
                          row,
                        );
                        if (Object.keys(key).length)
                          openTab({
                            kind: "investigation",
                            title: `Investigate ${tab.table!.name}`,
                            connectionId: tab.connectionId,
                            root: {
                              connectionId: tab.connectionId!,
                              table: tab.table!,
                              key,
                            },
                          });
                      }
                    : undefined
                }
                onWatch={
                  metadata.data && identityColumns(metadata.data).length
                    ? (row) => {
                        const key = rowKey(
                          metadata.data!,
                          rows.data!.columns,
                          row,
                        );
                        if (Object.keys(key).length)
                          window.dispatchEvent(
                            new CustomEvent("kitsune:watch", {
                              detail: {
                                connectionId: tab.connectionId,
                                table: tab.table,
                                key,
                              },
                            }),
                          );
                      }
                    : undefined
                }
                onDeleteRows={
                  selectable
                    ? (indices) => mutate("delete", indices)
                    : undefined
                }
                density={workspace.settings.density}
                selectedRows={selectedIndices}
                onSelectionChange={
                  selectable
                    ? (indices) => setSelection({ result: rows.data!, indices })
                    : undefined
                }
                actions={
                  writable && tab.table.kind === "table" ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={rows.loading || !metadata.data}
                        onClick={() => mutate("insert")}
                      >
                        <Plus size={13} />
                        New record
                      </Button>
                      {selectable && (
                        <>
                          <span className="muted small">
                            {selectedIndices.length} selected
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!selectedIndices.length || rows.loading}
                            onClick={() => mutate("update")}
                          >
                            <Pencil size={13} />
                            Edit selected
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!selectedIndices.length || rows.loading}
                            onClick={() => mutate("delete")}
                          >
                            <Trash2 size={13} />
                            Delete selected
                          </Button>
                          {!!selectedIndices.length && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setSelection(undefined)}
                            >
                              Clear
                            </Button>
                          )}
                        </>
                      )}
                    </>
                  ) : undefined
                }
                onEdit={
                  writable &&
                  tab.table?.kind === "table" &&
                  metadata.data &&
                  identityColumns(metadata.data).length
                    ? (row, column, before) => {
                        const key = rowKey(
                          metadata.data!,
                          rows.data!.columns,
                          row,
                        );
                        const field = metadata.data!.columns.find(
                          (c) => c.name === column,
                        );
                        if (!Object.keys(key).length || !field) return;
                        if (
                          field.pk ||
                          identityColumns(metadata.data!).includes(column)
                        ) {
                          notify(
                            "Identity columns must be changed through an explicit SQL query.",
                            true,
                          );
                          return;
                        }
                        if (
                          ["binary", "array", "unknown"].includes(before.kind)
                        ) {
                          notify(
                            "Use the SQL editor for binary, array, or custom values.",
                            true,
                          );
                          return;
                        }
                        setEditing({
                          record: {
                            connectionId: tab.connectionId!,
                            table: tab.table!,
                            key,
                          },
                          column,
                          before,
                          nullable: field.nullable,
                        });
                      }
                    : undefined
                }
                onRow={(row) => {
                  setSelected(row);
                  if (metadata.data) {
                    const key = rowKey(metadata.data, rows.data!.columns, row);
                    if (Object.keys(key).length)
                      update({
                        inspector: {
                          connectionId: tab.connectionId!,
                          table: tab.table!,
                          key,
                        },
                      });
                  }
                }}
                onSort={(c) => {
                  setDescending(sort === c ? !descending : false);
                  setSort(c);
                  resetPaging();
                }}
                sort={sort}
                descending={descending}
              />
            )
          )}
          <div className="pagination">
            <span className="muted">
              {rows.loading
                ? "Refreshing…"
                : rows.data
                  ? rowCounts
                    ? `${rows.data.rows.length.toLocaleString()} displayed / ${rowCounts.matching.toLocaleString()} matching / ${rowCounts.total.toLocaleString()} total rows · exact · ${rows.data.durationMs} ms`
                    : rowEstimate?.total !== undefined &&
                        rowEstimate.total !== null
                      ? `${rows.data.rows.length.toLocaleString()} displayed · ~${rowEstimate.total.toLocaleString()} estimated total rows · ${rows.data.durationMs} ms`
                      : `${rows.data.rows.length.toLocaleString()} displayed this page · matching and total not counted · ${rows.data.durationMs} ms`
                  : ""}
              {metadata.data &&
                !identityColumns(metadata.data).length &&
                " · no reliable unique key; paging may be unstable"}
            </span>
            <div className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              disabled={!rows.data || estimatingRows || countingRows}
              onClick={() => void estimateRows()}
              title="Uses database statistics when available; the estimate may be stale"
            >
              {estimatingRows ? "Estimating…" : "Estimate rows"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!rows.data || countingRows}
              onClick={() => void countRows()}
              title="Runs explicit counts; may take time on large tables"
            >
              {countingRows
                ? "Counting…"
                : rowCounts
                  ? "Refresh counts"
                  : "Count rows"}
            </Button>
            <Select
              aria-label="Page size"
              value={limit}
              onValueChange={(value) => {
                setLimit(Number(value));
                resetPaging();
              }}
            >
              {[25, 50, 100, 250, 500, 1000].map((n) => (
                <SelectItem key={n} value={n}>
                  {n} rows
                </SelectItem>
              ))}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              disabled={
                (keysetRequested ? cursorPage === 0 : offset === 0) ||
                rows.loading
              }
              onClick={previousPage}
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </Button>
            <span>Page {Math.floor(offset / limit) + 1}</span>
            <Button
              size="icon"
              variant="ghost"
              disabled={!rows.data?.truncated || rows.loading}
              onClick={nextPage}
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
