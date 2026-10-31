import { expect, test } from "bun:test";
import { createUpdater, type AvailableUpdate } from "../src/lib/updater";
import { parseReleaseNotes } from "../src/lib/release-notes";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const result = deferred<AvailableUpdate | null>();
  let checks = 0,
    installs = 0,
    restarts = 0,
    closes = 0;
  let blocker = "",
    failRestart = false;
  const download = deferred<void>();
  let progress: Parameters<AvailableUpdate["downloadAndInstall"]>[0] = () => {};
  const update: AvailableUpdate = {
    version: "0.2.0",
    body: "Release notes",
    close: async () => {
      closes++;
    },
    downloadAndInstall: async (cb) => {
      installs++;
      progress = cb;
      return download.promise;
    },
  };
  const controller = createUpdater({
    version: "0.1.0",
    check: () => {
      checks++;
      return result.promise;
    },
    relaunch: async () => {
      restarts++;
      if (failRestart) throw new Error("Restart failed");
    },
    installationBlocker: () => blocker,
  });
  return {
    controller,
    update,
    result,
    download,
    progress: (event: Parameters<typeof progress>[0]) => progress(event),
    counts: () => ({ checks, installs, restarts, closes }),
    block: (value: string) => {
      blocker = value;
    },
    failRestart: () => {
      failRestart = true;
    },
  };
}
test("checks deduplicate, display release notes, and never install without confirmation", async () => {
  const f = fixture();
  const pending = f.controller.checkForUpdates();
  await f.controller.checkForUpdates();
  expect(f.counts().checks).toBe(1);
  f.result.resolve(f.update);
  await pending;
  expect(f.controller.snapshot()).toMatchObject({
    promptOpen: true,
    checking: false,
    checked: true,
    update: { version: "0.2.0", body: "Release notes" },
  });
  expect(f.counts().installs).toBe(0);
  f.controller.setPromptOpen(false);
  expect(f.controller.snapshot().update).toBe(f.update);
});
test("current versions and network errors leave the app usable", async () => {
  const f = fixture();
  const pending = f.controller.checkForUpdates();
  f.result.resolve(null);
  await pending;
  expect(f.controller.snapshot()).toMatchObject({
    checked: true,
    checking: false,
    update: null,
    promptOpen: false,
    error: "",
  });
  const g = fixture();
  const failed = g.controller.checkForUpdates();
  g.result.reject(new Error("Offline"));
  await failed;
  expect(g.controller.snapshot()).toMatchObject({
    checking: false,
    checked: false,
    promptOpen: false,
  });
  expect(g.controller.snapshot().error).toContain("Offline");
});
test("installs deduplicate, report download progress, and restart after installation", async () => {
  const f = fixture();
  const checking = f.controller.checkForUpdates();
  f.result.resolve(f.update);
  await checking;
  const install = f.controller.installUpdate();
  await f.controller.installUpdate();
  await f.controller.checkForUpdates();
  f.controller.setPromptOpen(false);
  expect(f.controller.snapshot().promptOpen).toBe(true);
  f.progress({ event: "Started", data: { contentLength: 100 } });
  f.progress({ event: "Progress", data: { chunkLength: 30 } });
  f.progress({ event: "Progress", data: { chunkLength: 20 } });
  expect(f.controller.snapshot()).toMatchObject({
    downloadedBytes: 50,
    totalBytes: 100,
    installing: true,
  });
  expect(f.counts()).toMatchObject({ checks: 1, installs: 1, restarts: 0 });
  f.download.resolve();
  await install;
  expect(f.controller.snapshot()).toMatchObject({
    installed: true,
    installing: false,
  });
  expect(f.counts().restarts).toBe(1);
  await f.controller.installUpdate();
  expect(f.counts().installs).toBe(1);
});
test("active work blocks installation; download failure retains the update for retry", async () => {
  const f = fixture();
  const checking = f.controller.checkForUpdates();
  f.result.resolve(f.update);
  await checking;
  f.block("Save SQL first");
  await f.controller.installUpdate();
  expect(f.controller.snapshot().error).toBe("Save SQL first");
  expect(f.counts().installs).toBe(0);
  f.block("");
  const install = f.controller.installUpdate();
  f.download.reject(new Error("Signature invalid"));
  await install;
  expect(f.controller.snapshot()).toMatchObject({
    installed: false,
    installing: false,
    update: f.update,
  });
  expect(f.controller.snapshot().error).toContain("Signature invalid");
  expect(f.counts().restarts).toBe(0);
});
test("restart failure keeps the installed state and offers restart without downloading again", async () => {
  const f = fixture();
  const checking = f.controller.checkForUpdates();
  f.result.resolve(f.update);
  await checking;
  f.failRestart();
  const install = f.controller.installUpdate();
  f.download.resolve();
  await install;
  expect(f.controller.snapshot()).toMatchObject({
    installed: true,
    installing: false,
  });
  expect(f.controller.snapshot().error).toContain("Restart Kitsune");
  await f.controller.restart();
  expect(f.counts()).toMatchObject({ installs: 1, restarts: 2 });
});
test("patch notes include only versioned files and sort numeric versions newest first", () => {
  const notes = parseReleaseNotes({
    "/docs/releases/v1.9.0.md": "Older",
    "/docs/releases/v1.10.0.md": "Newest",
    "/docs/releases/README.md": "Instructions",
  });
  expect(notes.map((n) => n.version)).toEqual(["1.10.0", "1.9.0"]);
});
