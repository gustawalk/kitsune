import { PasswordVault } from "../components/PasswordVault";
import { Checkbox } from "../components/ui/checkbox";
import { themes } from "../lib/themes";
import { Select, SelectItem } from "../components/ui/select";
import { useRef, useState, type CSSProperties } from "react";
import {
  Check,
  History,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Field, ErrorState, Loading, Empty, Tag } from "../components/shared";
import { api, errorMessage, useRemote } from "../lib/api";
import {
  getWorkspace,
  newQuery,
  openTab,
  notify,
  update,
  useWorkspace,
} from "../lib/store";
import type { Settings } from "../lib/types";
export function SettingsWorkspace() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<Settings>(workspace.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clear, setClear] = useState("");
  const [appearanceStatus, setAppearanceStatus] = useState(
    "Changes apply and save immediately",
  );
  const [appearanceError, setAppearanceError] = useState("");
  const appearanceQueue = useRef<Promise<void>>(Promise.resolve());
  const appearanceVersion = useRef(0);
  function appearance(patch: Partial<Pick<Settings, "theme" | "density">>) {
    setSettings((s) => ({ ...s, ...patch }));
    update((s) => ({ settings: { ...s.settings, ...patch } }));
    const current = getWorkspace().settings;
    const payload = { theme: current.theme, density: current.density };
    const version = ++appearanceVersion.current;
    setAppearanceError("");
    setAppearanceStatus("Saving appearance…");
    appearanceQueue.current = appearanceQueue.current
      .catch(() => undefined)
      .then(async () => {
        await api("save_appearance", payload);
      })
      .then(() => {
        if (version === appearanceVersion.current)
          setAppearanceStatus("Appearance saved");
      })
      .catch((e) => {
        if (version === appearanceVersion.current) {
          setAppearanceStatus("Applied for this session · not saved");
          setAppearanceError(errorMessage(e));
        }
      });
  }
  const patch = (v: Partial<Settings>) => setSettings((s) => ({ ...s, ...v }));
  async function save() {
    if (busy || appearanceStatus === "Saving appearance…") return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Settings>("save_settings", settings);
      update({ settings: result });
      setAppearanceError("");
      setAppearanceStatus("Appearance saved");
      notify("Settings saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-page settings-page">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">Workspace preferences</div>
          <h1>
            <Settings2 size={20} />
            Settings
          </h1>
        </div>
        <div className="spacer" />
        <Button
          size="sm"
          disabled={busy || appearanceStatus === "Saving appearance…"}
          onClick={() => void save()}
        >
          <Save size={14} />
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
      <form
        className="settings-content"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <ErrorState error={error} />}
        <section>
          <h2>Appearance</h2>
          <p>
            Choose a palette for your workspace. Changes appear immediately.
          </p>
          <fieldset className="appearance-themes" disabled={busy}>
            <legend className="sr-only">Color theme</legend>
            {themes.map((theme) => (
              <label
                key={theme.id}
                className={`appearance-theme ${settings.theme === theme.id ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="color-theme"
                  value={theme.id}
                  checked={settings.theme === theme.id}
                  onChange={() => appearance({ theme: theme.id })}
                />
                <span
                  aria-hidden="true"
                  className="appearance-preview"
                  style={
                    {
                      "--preview-bg": theme.background,
                      "--preview-surface": theme.surface,
                      "--preview-accent": theme.accent,
                    } as CSSProperties
                  }
                >
                  <i />
                  <span>
                    <b />
                    <b />
                    <b />
                  </span>
                </span>
                <strong>
                  {theme.name}
                  {settings.theme === theme.id && <Check size={13} />}
                </strong>
                <small>{theme.description}</small>
              </label>
            ))}
          </fieldset>
          <div className="appearance-options">
            <Field label="Interface density">
              <Select
                disabled={busy}
                value={settings.density}
                onValueChange={(value) =>
                  appearance({ density: value as Settings["density"] })
                }
              >
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="comfortable">Comfortable</SelectItem>
              </Select>
            </Field>
            <span className="muted small" role="status">
              {appearanceStatus}
            </span>
          </div>
          {appearanceError && (
            <ErrorState error={appearanceError} retry={() => appearance({})} />
          )}
          <label className="check-row">
            <Checkbox
              checked={settings.restoreTabs}
              onCheckedChange={(checked) => patch({ restoreTabs: checked })}
            />
            Restore previous tabs on launch (SQL text is stored locally)
          </label>
        </section>
        <section>
          <h2>Local password vault</h2>
          <PasswordVault />
        </section>
        <section>
          <h2>Database execution</h2>
          <div className="form-grid">
            <Field label="Query timeout (seconds)">
              <input
                required
                type="number"
                min={1}
                max={300}
                value={settings.queryTimeout}
                onChange={(e) =>
                  patch({ queryTimeout: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Maximum result rows">
              <input
                required
                type="number"
                min={1}
                max={100000}
                value={settings.rowLimit}
                onChange={(e) => patch({ rowLimit: Number(e.target.value) })}
              />
            </Field>
            <Field label="Default page size">
              <Select
                value={settings.pageSize}
                onValueChange={(value) => patch({ pageSize: Number(value) })}
              >
                {[25, 50, 100, 250, 500, 1000].map((n) => (
                  <SelectItem key={n}>{n}</SelectItem>
                ))}
              </Select>
            </Field>
          </div>
          <p className="small muted">
            Production starts read-only. Other environments start writable.
            Destructive SQL requires review.
          </p>
        </section>
        <section>
          <h2>Monitoring and retention</h2>
          <div className="form-grid">
            <Field label="Default polling interval (seconds)">
              <input
                required
                type="number"
                min={2}
                max={3600}
                value={settings.pollInterval}
                onChange={(e) =>
                  patch({ pollInterval: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Retention (days)">
              <input
                required
                type="number"
                min={1}
                max={3650}
                value={settings.retentionDays}
                onChange={(e) =>
                  patch({ retentionDays: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Maximum events per watch">
              <input
                required
                type="number"
                min={1}
                max={100000}
                value={settings.maxEvents}
                onChange={(e) => patch({ maxEvents: Number(e.target.value) })}
              />
            </Field>
            <Field label="Maximum event payload storage (MiB)">
              <input
                required
                type="number"
                min={1}
                max={2048}
                value={settings.storageMiB}
                onChange={(e) => patch({ storageMiB: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="small muted">
            Watches restore paused. Polls never overlap for a watch. Cleanup
            bounds stored payloads; SQLite file allocation may remain larger
            after deletion.
          </p>
        </section>
        <section>
          <h2>SQL editor</h2>
          <div className="form-grid">
            <Field label="Font size">
              <input
                required
                type="number"
                min={10}
                max={24}
                value={settings.editorFontSize}
                onChange={(e) =>
                  patch({ editorFontSize: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Tab size">
              <Select
                value={settings.editorTabSize}
                onValueChange={(value) =>
                  patch({ editorTabSize: Number(value) })
                }
              >
                {[2, 4, 8].map((n) => (
                  <SelectItem key={n}>{n}</SelectItem>
                ))}
              </Select>
            </Field>
          </div>
          <label className="check-row">
            <Checkbox
              checked={settings.editorWrap}
              onCheckedChange={(checked) => patch({ editorWrap: checked })}
            />
            Wrap long lines
          </label>
          <label className="check-row">
            <Checkbox
              checked={settings.queryHistory}
              onCheckedChange={(checked) => patch({ queryHistory: checked })}
            />
            Save SQL execution history locally
          </label>
          <p className="small muted">
            SQL text may contain sensitive literals. Prepared parameter values
            are not saved by application-generated queries.
          </p>
        </section>
        <section>
          <h2>
            <ShieldCheck size={17} />
            Privacy and local data
          </h2>
          <Field
            label="Default sensitive-column exclusions"
            hint="Exact names, comma-separated. Names containing password, secret, token, private_key, or ssn are also excluded for record/table watches."
          >
            <input
              value={settings.sensitiveColumns}
              onChange={(e) => patch({ sensitiveColumns: e.target.value })}
            />
          </Field>
          <div className="security-note">
            <Check size={15} />
            <div>
              <strong>Session-only credentials</strong>
              <p>
                Passwords are held in Rust while connected, never written to
                application metadata. Enter them again after restarting.
              </p>
            </div>
          </div>
          <div className="watch-controls">
            <Button
              variant="secondary"
              type="button"
              size="sm"
              onClick={() => setClear("history")}
            >
              <Trash2 size={13} />
              Clear query history
            </Button>
            <Button
              variant="secondary"
              type="button"
              size="sm"
              onClick={() => setClear("events")}
            >
              <Trash2 size={13} />
              Clear captured events
            </Button>
          </div>
        </section>
      </form>
      {clear && (
        <Dialog
          open
          onClose={() => setClear("")}
          title="Permanently clear local history?"
          description={
            clear === "history"
              ? "Remove saved SQL execution history. Pinned queries remain."
              : "Remove captured watch events. Watch definitions remain."
          }
        >
          <footer>
            <Button variant="secondary" onClick={() => setClear("")}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void api(clear === "history" ? "clear_history" : "clear_events")
                  .then(() => {
                    setClear("");
                    notify("History cleared");
                  })
                  .catch((e) => notify(errorMessage(e), true));
              }}
            >
              Clear history
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
interface QueryHistory {
  sql: string;
  connectionId: string;
  createdAt: string;
  durationMs: number;
  success: boolean;
  rows: number | null;
}
interface SavedQuery {
  id: string;
  name: string;
  sql: string;
}
export function HistoryWorkspace() {
  const history = useRemote<QueryHistory[]>("history", {});
  const saved = useRemote<SavedQuery[]>("saved_queries", {});
  const [view, setView] = useState("recent");
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<SavedQuery>();
  return (
    <div className="workspace-page">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">Local SQL library</div>
          <h1>
            <History size={20} />
            Queries
          </h1>
        </div>
      </div>
      <div className="timeline-filters">
        <div className="inline-tabs">
          <button
            className={view === "recent" ? "active" : ""}
            onClick={() => setView("recent")}
          >
            Recent
          </button>
          <button
            className={view === "saved" ? "active" : ""}
            onClick={() => setView("saved")}
          >
            Saved queries
          </button>
        </div>
        <div className="spacer" />
        <input
          aria-label="Search SQL history"
          placeholder="Search queries…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {history.error && <ErrorState error={history.error} />}{" "}
      {history.loading && !history.data && <Loading />}
      <div className="query-history-list">
        {view === "recent"
          ? history.data
              ?.filter((h) =>
                h.sql.toLowerCase().includes(search.toLowerCase()),
              )
              .map((h, i) => (
                <button
                  key={i}
                  className="query-history-item"
                  onClick={() => {
                    openTab({
                      kind: "query",
                      title: "History query",
                      connectionId: h.connectionId,
                      sql: h.sql,
                      savedSql: "",
                    });
                  }}
                >
                  <div>
                    <Tag tone={h.success ? "success" : "danger"}>
                      {h.success ? "Success" : "Failed"}
                    </Tag>
                    <time>{new Date(h.createdAt).toLocaleString()}</time>
                    <span>{h.durationMs} ms</span>
                    <span>{h.rows ?? "—"} rows</span>
                  </div>
                  <pre>{h.sql.slice(0, 700)}</pre>
                </button>
              ))
          : saved.data
              ?.filter((q) =>
                `${q.name} ${q.sql}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((q) => (
                <div className="query-history-item" key={q.id}>
                  <div>
                    <button onClick={() => newQuery(q.sql)}>
                      <strong>{q.name}</strong>
                    </button>
                    <div className="spacer" />
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Delete saved query"
                      onClick={() => setDeleting(q)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                  <pre onDoubleClick={() => newQuery(q.sql)}>
                    {q.sql.slice(0, 700)}
                  </pre>
                </div>
              ))}
        {(view === "recent" ? !history.data?.length : !saved.data?.length) && (
          <Empty
            icon={<History size={24} />}
            title={
              view === "recent" ? "No query history yet" : "No saved queries"
            }
            detail={
              view === "recent"
                ? "Executed SQL will appear here when history is enabled."
                : "Save a query with Ctrl/Cmd+S in the SQL editor."
            }
          />
        )}
      </div>
      {deleting && (
        <Dialog
          open
          onClose={() => setDeleting(undefined)}
          title="Delete saved query?"
          description={deleting.name}
        >
          <footer>
            <Button
              variant="destructive"
              onClick={() => {
                void api("delete_query", { id: deleting.id })
                  .then(() => {
                    setDeleting(undefined);
                    void saved.refresh();
                  })
                  .catch((e) => notify(errorMessage(e), true));
              }}
            >
              Delete query
            </Button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
