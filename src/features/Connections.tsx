import { PasswordVault } from "../components/PasswordVault";
import { ConnectionColorPicker } from "../components/ConnectionColorPicker";
import { Tooltip } from "../components/ui/tooltip";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { useEffect, useRef, useState } from "react";
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
  const passwordEdited = useRef(false);
  const passwordAutofilled = useRef(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const needsVaultUnlock =
    config.rememberPassword &&
    config.credentialStore === "localVault" &&
    !vaultUnlocked;
  const hasSavedPassword =
    !!initial?.rememberPassword &&
    config.rememberPassword &&
    (initial.credentialStore || "operatingSystem") ===
      (config.credentialStore || "operatingSystem");
  useEffect(() => {
    let current = true;
    if (
      !vaultUnlocked ||
      !hasSavedPassword ||
      config.credentialStore !== "localVault"
    ) {
      if (passwordAutofilled.current) {
        setPassword("");
        passwordAutofilled.current = false;
      }
      return;
    }
    if (passwordEdited.current || !config.id) return;
    // Fetch only the current entry after unlock. This response must never use
    // the shared request cache or be published as a vault-status event.
    void api<string | null>("vault_connection_password", {
      connectionId: config.id,
    })
      .then((saved) => {
        if (current && !passwordEdited.current && saved !== null) {
          setPassword(saved);
          passwordAutofilled.current = true;
        }
      })
      .catch((failure) => {
        if (current) setError(errorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [vaultUnlocked, hasSavedPassword, config.id, config.credentialStore]);
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
    if (needsVaultUnlock) {
      setError(
        "Unlock your Kitsune vault below before using its saved database passwords.",
      );
      return;
    }
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
        await api("save_connection", payload);
        await refreshConnections();
        onClose();
        notify(
          config.rememberPassword
            ? "Connection and password saved securely"
            : "Connection saved. Password is requested when connecting.",
        );
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
                  name: "MySQL / MariaDB",
                  detail: "Connect to a MySQL or MariaDB server",
                  icon: Database,
                },
                {
                  driver: "mssql",
                  name: "SQL Server",
                  detail: "Connect to a SQL Server instance",
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
                        ? "verify-full"
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
              <div className="full">
                <ConnectionColorPicker
                  value={config.color}
                  onChange={(color) => patch({ color })}
                />
              </div>
              {config.driver === "mysql" && (
                <p className="muted small full">
                  Rust TLS validates the server certificate and hostname in
                  verify-full mode. Managed edits and restores require InnoDB
                  tables without triggers or cascading relationships. Native SQL
                  can execute DDL and routines after review; these may commit
                  implicitly.
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
                  <Field
                    label="Password"
                    hint={
                      config.rememberPassword
                        ? hasSavedPassword
                          ? config.credentialStore === "localVault"
                            ? "Fills automatically when the vault is unlocked. You can edit it to replace it."
                            : "A password is saved. Leave blank to use it, or enter a replacement."
                          : "Enter the database password to save with this connection."
                        : "Session only · never persisted"
                    }
                  >
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => {
                        passwordEdited.current = true;
                        passwordAutofilled.current = false;
                        setPassword(e.target.value);
                      }}
                      autoComplete="current-password"
                      aria-label="Database password"
                      placeholder={
                        hasSavedPassword
                          ? "Saved password · leave blank to reuse"
                          : "Database password"
                      }
                    />
                  </Field>
                  <label className="check-row full">
                    <Checkbox
                      checked={config.rememberPassword}
                      onCheckedChange={(checked) =>
                        patch({ rememberPassword: checked })
                      }
                    />
                    Remember password securely
                  </label>
                  {config.rememberPassword && (
                    <div className="full connection-password-storage">
                      <Field label="Password storage">
                        <Select
                          value={config.credentialStore || "operatingSystem"}
                          onValueChange={(value) => {
                            patch({
                              credentialStore: value as
                                "operatingSystem" | "localVault",
                            });
                          }}
                        >
                          <SelectItem value="operatingSystem">
                            Operating-system keyring
                          </SelectItem>
                          <SelectItem value="localVault">
                            Encrypted local vault
                          </SelectItem>
                        </Select>
                      </Field>
                      {initial?.rememberPassword &&
                        (initial.credentialStore || "operatingSystem") !==
                          (config.credentialStore || "operatingSystem") && (
                          <p className="muted">
                            Enter the database password again when changing
                            storage. Existing passwords in the previous store
                            are kept.
                          </p>
                        )}
                      {config.credentialStore === "localVault" && (
                        <PasswordVault onUnlockedChange={setVaultUnlocked} />
                      )}
                    </div>
                  )}
                  <Field
                    label="TLS mode"
                    hint="require encrypts traffic; verify-full also validates server identity. Use require only for trusted endpoints."
                  >
                    <Select
                      value={config.sslMode}
                      onValueChange={(value) => patch({ sslMode: value })}
                    >
                      {(config.driver === "mysql"
                        ? ["disable", "require", "verify-full"]
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
            {config.driver === "mysql" && config.sslMode !== "disable" && (
              <div className="connection-grid">
                {(
                  [
                    ["tlsCaPath", "Trusted CA (optional)"],
                    ["tlsCertPath", "Client certificate (optional)"],
                    ["tlsKeyPath", "Client private key (optional)"],
                  ] as const
                ).map(([key, label]) => (
                  <Field
                    key={key}
                    label={label}
                    hint={
                      key === "tlsCaPath"
                        ? "Empty uses system/public roots. Selecting a CA trusts that file exclusively."
                        : "Client certificate and key must be selected together. Key contents stay in Rust."
                    }
                  >
                    <div className="database-file-picker">
                      <input
                        readOnly
                        value={config[key]}
                        aria-label={label}
                        placeholder="No file selected"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          void api<string | null>("choose_tls_file")
                            .then((path) => {
                              if (path) patch({ [key]: path });
                            })
                            .catch((e) => setError(errorMessage(e)))
                        }
                      >
                        Browse…
                      </Button>
                      {config[key] && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => patch({ [key]: "" })}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </Field>
                ))}
              </div>
            )}
          </fieldset>
          {error && <ErrorState error={error} />}
          <footer>
            <Button
              type="button"
              variant="secondary"
              disabled={
                !!busy ||
                needsVaultUnlock ||
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
              disabled={!!busy || missingFile || needsVaultUnlock}
              onClick={() => void action("save")}
            >
              Save
            </Button>
            <Button disabled={!!busy || missingFile || needsVaultUnlock}>
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
