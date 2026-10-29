import { useEffect, useState } from "react";
import { Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
import { ErrorState, Field } from "./shared";

interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}
const STATUS_EVENT = "kitsune:vault-status";
export function PasswordVault({
  onUnlockedChange,
}: {
  onUnlockedChange?: (unlocked: boolean) => void;
}) {
  const [status, setStatus] = useState<VaultStatus>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [master, setMaster] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creating = status?.initialized === false;
  useEffect(() => {
    let current = true;
    let changed = false;
    const receive = (event: Event) => {
      changed = true;
      setStatus((event as CustomEvent<VaultStatus>).detail);
      setLoading(false);
      setLoadError("");
      setError("");
      setMaster("");
      setConfirmation("");
      setReveal(false);
    };
    window.addEventListener(STATUS_EVENT, receive);
    setLoading(true);
    setLoadError("");
    void api<VaultStatus>("vault_status")
      .then((next) => {
        if (current && !changed) setStatus(next);
      })
      .catch((failure) => {
        if (current && !changed) setLoadError(errorMessage(failure));
      })
      .finally(() => {
        if (current && !changed) setLoading(false);
      });
    return () => {
      current = false;
      window.removeEventListener(STATUS_EVENT, receive);
    };
  }, [attempt]);
  useEffect(() => {
    onUnlockedChange?.(status?.unlocked === true);
  }, [status?.unlocked, onUnlockedChange]);
  useEffect(() => () => onUnlockedChange?.(false), [onUnlockedChange]);
  async function action(lock = false) {
    if (busy || loading || !status) return;
    setError("");
    if (
      !lock &&
      creating &&
      (master !== confirmation || [...master].length < 12)
    ) {
      setError(
        "Use at least 12 characters and enter the same master password twice.",
      );
      return;
    }
    if (!lock && !master) {
      setError("Enter your Kitsune master password.");
      return;
    }
    setBusy(true);
    try {
      const next = await api<VaultStatus>(
        lock ? "vault_lock" : creating ? "vault_create" : "vault_unlock",
        lock ? {} : { masterPassword: master },
      );
      // Publish the authoritative mutation result directly. Shared cached
      // refreshes could invalidate one another and leave other panels locked.
      window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: next }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setMaster("");
      setConfirmation("");
      setReveal(false);
      setBusy(false);
    }
  }
  const unlocked = status?.unlocked === true;
  return (
    <div
      className={`password-vault ${unlocked ? "is-unlocked" : ""}`}
      aria-busy={busy || loading}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.stopPropagation();
          void action();
        }
      }}
    >
      <div className="vault-heading">
        <span>
          {unlocked ? <ShieldCheck size={16} /> : <LockKeyhole size={16} />}
          <strong>Local password vault</strong>
        </span>
        <span className="vault-status">
          {loading
            ? "Checking…"
            : unlocked
              ? "Unlocked"
              : creating
                ? "Not set up"
                : "Locked"}
        </span>
      </div>
      {loadError ? (
        <ErrorState error={loadError} retry={() => setAttempt((n) => n + 1)} />
      ) : (
        !loading &&
        status && (
          <>
            <p className="vault-description">
              {unlocked
                ? "Saved database passwords are available for this app session."
                : creating
                  ? "Choose a master password for Kitsune. You’ll use it to unlock saved database passwords."
                  : "Enter the master password you created for Kitsune. This is different from your database password."}
            </p>
            {error && <ErrorState error={error} />}
            {!unlocked && (
              <div className="vault-fields">
                <Field
                  label={creating ? "New master password" : "Master password"}
                >
                  <div className="vault-password-input">
                    <input
                      type={reveal ? "text" : "password"}
                      aria-label={
                        creating ? "New master password" : "Master password"
                      }
                      autoComplete={
                        creating ? "new-password" : "current-password"
                      }
                      maxLength={1024}
                      value={master}
                      disabled={busy}
                      onChange={(event) => setMaster(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={
                        reveal ? "Hide master password" : "Show master password"
                      }
                      aria-pressed={reveal}
                      disabled={busy}
                      onClick={() => setReveal((shown) => !shown)}
                    >
                      {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                  </div>
                </Field>
                {creating && (
                  <Field label="Confirm master password">
                    <input
                      type={reveal ? "text" : "password"}
                      aria-label="Confirm master password"
                      autoComplete="new-password"
                      maxLength={1024}
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </Field>
                )}
              </div>
            )}
            <div className="vault-footer">
              <small>
                {unlocked
                  ? "Locking keeps active database connections open."
                  : creating
                    ? "At least 12 characters. Keep it safe—it cannot be recovered."
                    : "Unlock once each time you open Kitsune."}
              </small>
              <Button
                type="button"
                variant={unlocked ? "ghost" : "secondary"}
                size="sm"
                disabled={busy}
                onClick={() => void action(unlocked)}
              >
                {busy
                  ? "Working…"
                  : unlocked
                    ? "Lock vault"
                    : creating
                      ? "Create local vault"
                      : "Unlock vault"}
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}
