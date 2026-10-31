import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Plug, Settings2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { notify } from "../lib/store";
import type { Connection } from "../lib/types";
import { connectSaved } from "../features/Connections";
import { PasswordVault } from "./PasswordVault";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { ErrorState, Field } from "./shared";

export function QuickConnect({
  connection,
  onClose,
  onSettings,
}: {
  connection: Connection;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const localVault =
    connection.rememberPassword && connection.credentialStore === "localVault";
  const initialAttempt = useRef<Promise<
    "connected" | "vault" | "password"
  > | null>(null);
  useEffect(() => {
    let current = true;
    // StrictMode mounts effects twice; the connection attempt belongs to this
    // dialog, not to an effect invocation.
    initialAttempt.current ??= (async () => {
      if (localVault) {
        const status = await api<{ unlocked: boolean }>("vault_status");
        if (!status.unlocked) return "vault";
      }
      if (connection.driver !== "sqlite" && !connection.rememberPassword)
        return "password";
      await connectSaved(connection);
      return "connected";
    })();
    void initialAttempt.current
      .then((result) => {
        if (!current) return;
        if (result === "connected") {
          notify(`Connected to ${connection.name}`);
          onClose();
        }
        if (result === "password") setNeedsPassword(true);
      })
      .catch((failure) => {
        if (current) {
          setError(errorMessage(failure));
          setNeedsPassword(true);
        }
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [connection, localVault, onClose]);
  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await connectSaved(connection, password);
      setPassword("");
      notify(`Connected to ${connection.name}`);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setNeedsPassword(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Connect to ${connection.name}`}
      description={`${connection.host || "Local database"}${connection.database ? ` / ${connection.database}` : ""}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        {busy && (
          <p role="status">
            <LoaderCircle size={14} className="spin" />
            Connecting…
          </p>
        )}
        {localVault && <PasswordVault onUnlockedChange={setVaultUnlocked} />}
        {needsPassword && (
          <Field label="Database password">
            <input
              type="password"
              aria-label="Database password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {error && <ErrorState error={error} />}
        <footer>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onSettings}
          >
            <Settings2 size={14} />
            Connection settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || (localVault && !vaultUnlocked)}>
            <Plug size={14} />
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
