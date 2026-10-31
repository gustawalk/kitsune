import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

export async function generateUpdaterManifest({
  assetsDirectory,
  releaseTag,
  repository,
  notesFile,
}: {
  assetsDirectory: string;
  releaseTag: string;
  repository: string;
  notesFile: string;
}) {
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag))
    throw new Error(`Expected a stable version tag: ${releaseTag}`);
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repository))
    throw new Error("Invalid GitHub repository.");
  const files = await readdir(assetsDirectory, { recursive: true });
  const notes = (await readFile(notesFile, "utf8")).trim();
  if (!notes) throw new Error("Release notes must not be empty.");
  async function asset(suffix: string) {
    const matches = files.filter((file) => file.endsWith(suffix));
    if (matches.length !== 1)
      throw new Error(
        `Expected one ${suffix} updater asset, found ${matches.length}.`,
      );
    const file = matches[0];
    if (!(await stat(path.join(assetsDirectory, file))).size)
      throw new Error(`Empty update artifact: ${file}`);
    const signature = (
      await readFile(path.join(assetsDirectory, `${file}.sig`), "utf8")
    ).trim();
    if (!signature) throw new Error(`Empty signature for ${file}.`);
    return {
      signature,
      url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(path.basename(file))}`,
    };
  }
  return {
    version: releaseTag.slice(1),
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": await asset(".exe"),
      "linux-x86_64-appimage": await asset(".AppImage"),
      "linux-x86_64-deb": await asset(".deb"),
    },
  };
}
if (import.meta.main) {
  const {
    RELEASE_ASSETS_DIR,
    RELEASE_TAG,
    GITHUB_REPOSITORY,
    RELEASE_NOTES_FILE,
    UPDATER_MANIFEST_PATH,
  } = process.env;
  if (
    !RELEASE_ASSETS_DIR ||
    !RELEASE_TAG ||
    !GITHUB_REPOSITORY ||
    !RELEASE_NOTES_FILE
  )
    throw new Error(
      "RELEASE_ASSETS_DIR, RELEASE_TAG, GITHUB_REPOSITORY and RELEASE_NOTES_FILE are required.",
    );
  const manifest = await generateUpdaterManifest({
    assetsDirectory: RELEASE_ASSETS_DIR,
    releaseTag: RELEASE_TAG,
    repository: GITHUB_REPOSITORY,
    notesFile: RELEASE_NOTES_FILE,
  });
  await writeFile(
    UPDATER_MANIFEST_PATH || "updater.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
