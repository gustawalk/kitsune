import { Tooltip } from "../components/ui/tooltip";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  FlaskConical,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { Dialog } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Field, ErrorState } from "../components/shared";
import { api, errorMessage, invalidate } from "../lib/api";
import { notify, update } from "../lib/store";
import { emptyConnection, type Bootstrap, type Connection } from "../lib/types";
export async function refreshConnections() {
  const b = await api<Bootstrap>("bootstrap");
  update({
    connections: b.connections,
    activeConnections: b.active,
    watches: b.watches,
  });
  invalidate();
}
export function ConnectionDialog({
  initial,
  onClose,
}: {
  initial?: Connection;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"choose" | "configure">(
    initial ? "configure" : "choose",
  );
  const [config, setConfig] = useState(initial || emptyConnection());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const patch = (v: Partial<Connection>) => {
    setConfig((c) => {
      const next = { ...c, ...v };
      if (next.create && (next.readOnly || next.environment === "production")) {
        next.create = false;
        next.path = "";
      }
      return next;
    });
    setTested(false);
  };
  async function chooseFile() {
    setBusy("file");
    setError("");
    try {
      const path = await api<string | null>("choose_sqlite_file", {
        mode: config.create ? "create" : "open",
        path: config.path,
      });
      if (path !== null) patch({ path });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  const missingFile = config.driver === "sqlite" && !config.path;
  async function action(kind: string) {
    if (busy) return;
    if (missingFile) {
      setError("Choose a database file first.");
      return;
    }
    setBusy(kind);
    setError("");
    try {
      const payload = { ...config, password };
      if (kind === "test") {
        await api("test_connection", payload);
        setTested(true);
        notify("Connection test succeeded");
      } else if (kind === "save") {
        await api("save_connection", config);
        await refreshConnections();
        onClose();
        notify("Connection saved. Credentials are requested each session.");
      } else {
        const result = await api<{
          id: string;
          readOnly: boolean;
        }>("connect", payload);
        setPassword("");
        await refreshConnections();
        update((s) => ({
          activeConnection: result.id,
          readOnly: { ...s.readOnly, [result.id]: result.readOnly },
        }));
        onClose();
        notify(`Connected to ${config.name}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={
        initial
          ? "Connection settings"
          : step === "choose"
            ? "Connect a database"
            : config.driver === "sqlite"
              ? "Connect to SQLite"
              : config.driver === "mysql"
                ? "Connect to MySQL / MariaDB"
                : config.driver === "mssql"
                  ? "Connect to SQL Server"
                  : "Connect to PostgreSQL"
      }
      description="Your data stays on your machine. Credentials remain in Rust for this session."
    >
      {step === "choose" ? (
        <div className="database-chooser">
          <p className="database-chooser-label">Choose your database</p>
          <div className="database-driver-grid">
            {(
              [
                {
                  driver: "postgres",
                  name: "PostgreSQL",
                  detail: "Connect to a local or remote server",
                  icon: Database,
                },
                {
                  driver: "mysql",
                  name: "MySQL / MariaDB · Preview",
                  detail: "Connect using MariaDB Connector/C 3",
                  icon: Database,
                },
                {
                  driver: "mssql",
                  name: "SQL Server",
                  detail: "Encrypted TDS connection",
                  icon: Database,
                },
                {
                  driver: "sqlite",
                  name: "SQLite",
                  detail: "Open a database file or create a new one",
                  icon: FolderOpen,
                },
              ] as const
            ).map(({ driver, name, detail, icon: Icon }) => (
              <button
                key={driver}
                type="button"
                className="database-driver-card"
                onClick={() => {
                  patch({
                    driver,
                    port:
                      driver === "mysql"
                        ? 3306
                        : driver === "mssql"
                          ? 1433
                          : 5432,
                    sslMode:
                      driver === "mysql"
                        ? "require"
                        : driver === "mssql"
                          ? "verify-full"
                          : "prefer",
                  });
                  setStep("configure");
                }}
              >
                <Icon size={26} strokeWidth={1.5} />
                <strong>{name}</strong>
                <span>{detail}</span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
          <p className="database-support-note">
            Connect to a server or open a local database file. Saved connections
            stay on this device.
          </p>
        </div>
      ) : (
        <form
          className="connection-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action("connect");
          }}
        >
          <fieldset disabled={!!busy} className="connection-fields">
            <div className="connection-form-heading">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setStep("choose")}
              >
                <ArrowLeft size={14} /> Change database
              </Button>
              <span>
                {config.driver === "sqlite"
                  ? "Local file"
                  : "Server connection"}
              </span>
            </div>
            <div className="form-grid">
              <Field label="Connection name">
                <input
                  autoFocus
                  required
                  placeholder="Local development"
                  value={config.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Environment">
                <Select
                  value={config.environment}
                  onValueChange={(value) =>
                    patch({
                      environment: value as Connection["environment"],
                    })
                  }
                >
                  {["development", "staging", "production", "custom"].map(
                    (e) => (
                      <SelectItem key={e}>{e}</SelectItem>
                    ),
                  )}
                </Select>
              </Field>
              {config.driver === "mysql" && (
                <p className="muted small full">
                  Requires MariaDB Connector/C 3. Managed writes support InnoDB.
                  Strict verify-full is blocked because the connector can skip
                  peer checks; require encrypts without verifying server
                  identity. DDL, routines and historical restore are
                  unavailable.
                </p>
              )}
              {config.driver === "mssql" && (
                <p className="muted small full">
                  SQL Server read-only/Production mode requires a dedicated
                  read-only login. Cancellation closes the connection; server
                  cancellation is not confirmed. DDL and historical restore are
                  unavailable.
                </p>
              )}
              {config.driver !== "sqlite" ? (
                <>
                  <Field label="Host">
                    <input
                      required
                      value={config.host}
                      onChange={(e) => patch({ host: e.target.value })}
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={config.port}
                      onChange={(e) => patch({ port: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Database">
                    <input
                      required
                      value={config.database}
                      placeholder="app_development"
                      onChange={(e) => patch({ database: e.target.value })}
                    />
                  </Field>
                  <Field label="Username">
                    <input
                      required
                      value={config.username}
                      onChange={(e) => patch({ username: e.target.value })}
                      autoComplete="username"
                    />
                  </Field>
                  <Field label="Password" hint="Session only · never persisted">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </Field>
                  <Field
                    label="TLS mode"
                    hint="require encrypts traffic; verify-full also validates server identity. Use require only for trusted endpoints."
                  >
                    <Select
                      value={config.sslMode}
                      onValueChange={(value) => patch({ sslMode: value })}
                    >
                      {(config.driver === "mysql"
                        ? ["disable", "require"]
                        : config.driver === "mssql"
                          ? ["disable", "require", "verify-full"]
                          : [
                              "disable",
                              "allow",
                              "prefer",
                              "require",
                              "verify-ca",
                              "verify-full",
                            ]
                      ).map((s) => (
                        <SelectItem key={s}>{s}</SelectItem>
                      ))}
                      {config.driver === "mysql" && (
                        <SelectItem value="verify-full" disabled>
                          verify-full · unavailable
                        </SelectItem>
                      )}
                    </Select>
                  </Field>
                </>
              ) : (
                <div className="full">
                  <Field
                    label="Database file"
                    hint={
                      config.create
                        ? "Choose a new filename. The database is created only when you connect."
                        : "Choose an existing SQLite database on your computer."
                    }
                  >
                    <div className="database-file-picker">
                      <Tooltip content={config.path}>
                        <input
                          readOnly
                          aria-label="Selected database path"
                          placeholder="No file selected"
                          value={config.path}
                        />
                      </Tooltip>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void chooseFile()}
                      >
                        {busy === "file" ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <FolderOpen size={14} />
                        )}
                        {config.create ? "Choose location…" : "Browse…"}
                      </Button>
                    </div>
                  </Field>
                  <label className="check-row">
                    <Checkbox
                      checked={config.create}
                      disabled={
                        config.readOnly || config.environment === "production"
                      }
                      onCheckedChange={(checked) =>
                        patch({ create: checked, path: "" })
                      }
                    />
                    Create a new SQLite database
                  </label>
                </div>
              )}
            </div>
            <label className="check-row">
              <Checkbox
                checked={config.readOnly || config.environment === "production"}
                disabled={config.environment === "production"}
                onCheckedChange={(checked) => patch({ readOnly: checked })}
              />
              Open read-only
              {config.environment === "production" &&
                " · required for Production"}
            </label>
            {config.environment === "production" && (
              <p className="notice">
                Production starts read-only. Prefer database credentials
                restricted to read access.
              </p>
            )}
          </fieldset>
          {error && <ErrorState error={error} />}
          <footer>
            <Button
              type="button"
              variant="secondary"
              disabled={
                !!busy ||
                missingFile ||
                (config.driver === "sqlite" && config.create)
              }
              onClick={() => void action("test")}
            >
              {busy === "test" ? (
                <LoaderCircle size={14} className="spin" />
              ) : tested ? (
                <Check size={14} />
              ) : (
                <FlaskConical size={14} />
              )}
              {tested ? "Connected" : "Test connection"}
            </Button>
            <div className="spacer" />
            <Button
              type="button"
              variant="ghost"
              disabled={!!busy || missingFile}
              onClick={() => void action("save")}
            >
              Save
            </Button>
            <Button disabled={!!busy || missingFile}>
              {busy === "connect" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <ArrowRight size={14} />
              )}
              Connect
            </Button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
