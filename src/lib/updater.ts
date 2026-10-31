export interface AvailableUpdate {
  version: string;
  body?: string;
  downloadAndInstall: (
    progress: (event: {
      event: string;
      data?: { contentLength?: number; chunkLength?: number };
    }) => void,
  ) => Promise<void>;
  close: () => Promise<void>;
}
export interface UpdaterState {
  currentVersion: string;
  tauriVersion: string;
  update: AvailableUpdate | null;
  checking: boolean;
  checked: boolean;
  installing: boolean;
  installed: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  promptOpen: boolean;
  error: string;
}
export function createUpdater(deps: {
  version: string;
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
  installationBlocker: () => string;
}) {
  let state: UpdaterState = {
    currentVersion: deps.version,
    tauriVersion: "",
    update: null,
    checking: false,
    checked: false,
    installing: false,
    installed: false,
    downloadedBytes: 0,
    totalBytes: null,
    promptOpen: false,
    error: "",
  };
  const listeners = new Set<() => void>();
  const patch = (value: Partial<UpdaterState>) => {
    state = { ...state, ...value };
    listeners.forEach((l) => l());
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setVersions: (currentVersion: string, tauriVersion: string) =>
      patch({ currentVersion, tauriVersion }),
    setPromptOpen: (promptOpen: boolean) => {
      if (!state.installing) patch({ promptOpen });
    },
    async checkForUpdates() {
      if (state.checking || state.installing || state.installed) return;
      patch({ checking: true, error: "" });
      try {
        const update = await deps.check();
        const previous = state.update;
        patch({ update, checked: true, promptOpen: !!update });
        if (previous && previous !== update)
          void previous.close().catch(() => undefined);
      } catch (e) {
        patch({ error: String(e), promptOpen: false });
      } finally {
        patch({ checking: false });
      }
    },
    async installUpdate() {
      if (
        !state.update ||
        state.checking ||
        state.installing ||
        state.installed
      )
        return;
      const blocker = deps.installationBlocker();
      if (blocker) {
        patch({ error: blocker });
        return;
      }
      const update = state.update;
      patch({
        installing: true,
        error: "",
        downloadedBytes: 0,
        totalBytes: null,
      });
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started")
            patch({ totalBytes: event.data?.contentLength ?? null });
          if (event.event === "Progress")
            patch({
              downloadedBytes:
                state.downloadedBytes + (event.data?.chunkLength || 0),
            });
        });
        patch({ installed: true });
        await deps.relaunch();
      } catch (e) {
        patch({
          error: state.installed
            ? "Update installed. Restart Kitsune to use the new version."
            : String(e),
        });
      } finally {
        patch({ installing: false });
      }
    },
    async restart() {
      if (!state.installed || state.installing) return;
      const blocker = deps.installationBlocker();
      if (blocker) {
        patch({ error: blocker });
        return;
      }
      patch({ installing: true, error: "" });
      try {
        await deps.relaunch();
      } catch {
        patch({ error: "Restart Kitsune manually to finish updating." });
      } finally {
        patch({ installing: false });
      }
    },
  };
}
