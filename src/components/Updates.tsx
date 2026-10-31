import { Dialog as DialogPrimitive } from "radix-ui";
import { ReleaseNotes } from "./ReleaseNotes";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  ArrowRight,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { updater, useUpdater, startUpdater } from "../lib/use-updater";
import { parseReleaseNotes } from "../lib/release-notes";
import { openTab } from "../lib/store";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorState } from "./shared";

const notes = parseReleaseNotes(
  import.meta.glob<string>("../../docs/releases/v*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
export function VersionStatus() {
  const state = useUpdater();
  return (
    <button
      onClick={() =>
        state.update
          ? updater.setPromptOpen(true)
          : openTab({ kind: "settings", title: "Settings" })
      }
      title={
        state.update
          ? `Update to ${state.update.version}`
          : "Version and updates"
      }
    >
      Kitsune {state.currentVersion}
      {state.update ? " · Update available" : ""}
    </button>
  );
}
export function Updates() {
  const state = useUpdater();
  useEffect(startUpdater, []);
  if (!state.promptOpen || !state.update) return null;
  const title = state.installed
    ? "You’re ready to restart"
    : `Kitsune v${state.update.version} is ready`;
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => updater.setPromptOpen(open)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog update-dialog">
          <header className="update-dialog-header">
            <span className="update-dialog-icon" aria-hidden="true">
              {state.installed ? <Check size={20} /> : <Download size={20} />}
            </span>
            <div className="update-dialog-heading">
              <span className="update-dialog-kicker">
                {state.installed ? "ALL SET" : "UPDATE AVAILABLE"}
              </span>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                {state.installed
                  ? "The update is installed. Restart to use the new version."
                  : "See what changed, then update when it works for you."}
              </DialogPrimitive.Description>
              <span className="update-version-change">
                <span>v{state.currentVersion}</span>
                <ArrowRight size={13} />
                <strong>v{state.update.version}</strong>
              </span>
            </div>
          </header>
          <section className="update-notes" aria-label="Release notes">
            <h3>What’s new</h3>
            <div className="update-notes-panel">
              <ReleaseNotes body={state.update.body} />
            </div>
          </section>
          {state.installing && (
            <div className="update-progress" role="status">
              <div>
                <LoaderCircle size={13} className="spin" />
                <span>
                  {state.totalBytes
                    ? `Downloading update… ${Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))}%`
                    : "Downloading and installing update…"}
                </span>
              </div>
              <progress
                aria-label="Update download"
                max={state.totalBytes || undefined}
                value={state.totalBytes ? state.downloadedBytes : undefined}
              />
            </div>
          )}
          {state.error && (
            <div className="update-feedback">
              <ErrorState error={state.error} />
            </div>
          )}
          <p className="update-footnote">
            Kitsune will restart after updating. Finish your database work
            first.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={state.installing}
              onClick={() => updater.setPromptOpen(false)}
            >
              Maybe later
            </Button>
            <Button
              disabled={state.installing || state.checking}
              onClick={() =>
                void (state.installed
                  ? updater.restart()
                  : updater.installUpdate())
              }
            >
              {state.installing ? (
                <LoaderCircle size={14} className="spin" />
              ) : state.installed ? (
                <Check size={14} />
              ) : (
                <Download size={14} />
              )}
              {state.installing
                ? "Updating…"
                : state.installed
                  ? "Restart Kitsune"
                  : "Update Kitsune"}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function UpdateSettings() {
  const state = useUpdater();
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <section className="system-card">
      <div className="system-card-brand">
        <img src="/icon.svg" alt="" width={42} height={42} />
        <div>
          <h2>About Kitsune</h2>
          <p>Understand your data.</p>
        </div>
      </div>
      <div className="system-details">
        <div>
          <span>App version</span>
          <strong className="system-version">
            v{state.currentVersion}
            {state.update && (
              <>
                <ArrowRight size={13} />
                <span>v{state.update.version}</span>
              </>
            )}
          </strong>
        </div>
        <div>
          <span>Tauri Core</span>
          <span>{state.tauriVersion || "—"}</span>
        </div>
        <div>
          <span>Updates</span>
          <span className={`system-status ${state.update ? "has-update" : ""}`}>
            <i />
            {state.installed
              ? "Ready"
              : state.update
                ? "Update available"
                : state.checking
                  ? "Checking…"
                  : state.checked && !state.error
                    ? "Up to date"
                    : "Check for a new version"}
          </span>
        </div>
      </div>
      <div className="system-actions">
        <Button
          type="button"
          disabled={
            !isTauri() || state.checking || state.installing || state.installed
          }
          onClick={() => void updater.checkForUpdates()}
        >
          <RefreshCw size={14} />
          {state.checking ? "Checking for updates…" : "Check for updates"}
        </Button>
        {state.update && (
          <Button
            type="button"
            variant="secondary"
            disabled={state.installing}
            onClick={() => updater.setPromptOpen(true)}
          >
            {state.installed
              ? "Restart to finish updating"
              : `Review update ${state.update.version}`}
          </Button>
        )}
      </div>
      <p role="status" className="small muted">
        {!isTauri()
          ? "Open the desktop app to check for updates."
          : state.installed
            ? "Update installed. Restart Kitsune to use it."
            : state.update
              ? `Version ${state.update.version} is available.`
              : state.checked && !state.checking && !state.error
                ? "You’re up to date."
                : ""}
      </p>
      {state.error && <ErrorState error={state.error} />}
      <div className="system-card-footer">
        <span>Updates are checked at startup.</span>
        <button type="button" onClick={() => setHistoryOpen(true)}>
          View patch notes <ArrowRight size={12} />
        </button>
      </div>
      {historyOpen && (
        <Dialog
          open
          wide
          title="Patch notes"
          className="patch-notes-dialog"
          description="The latest improvements to Kitsune."
          onClose={() => setHistoryOpen(false)}
        >
          <div className="release-history">
            {notes.map((note) => (
              <details key={note.version} open={note === notes[0]}>
                <summary>
                  <strong>Kitsune v{note.version}</strong>
                  {note === notes[0] && <span>Latest</span>}
                  <ArrowRight size={14} />
                </summary>
                <ReleaseNotes body={note.body} />
              </details>
            ))}
          </div>
        </Dialog>
      )}
    </section>
  );
}
