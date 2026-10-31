import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion, getTauriVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { version } from "../../package.json";
import { getWorkspace } from "./store";
import { createUpdater } from "./updater";

export const updater = createUpdater({
  version,
  check: () => check({ timeout: 15000 }),
  relaunch,
  installationBlocker: () => {
    const workspace = getWorkspace();
    if (
      Object.values(workspace.pendingEdits).some((pending) => pending.count > 0)
    )
      return "Apply or discard pending table edits before installing the update.";
    if (Object.values(workspace.transactions).includes("active"))
      return "Commit or roll back active SQL transactions before installing the update.";
    if (
      workspace.tabs.some(
        (tab) => tab.kind === "query" && tab.sql && tab.sql !== tab.savedSql,
      )
    )
      return "Save or close your unsaved SQL tabs before installing the update.";
    return "";
  },
});
let started = false;
export function startUpdater() {
  if (started || !isTauri()) return;
  started = true;
  void Promise.all([getVersion(), getTauriVersion()])
    .then(([version, tauri]) => updater.setVersions(version, tauri))
    .catch(() => undefined);
  if (import.meta.env.PROD) void updater.checkForUpdates();
}
export const useUpdater = () =>
  useSyncExternalStore(updater.subscribe, updater.snapshot);
