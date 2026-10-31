import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUpdaterManifest } from "../scripts/generate-updater-manifest";
async function fixture(
  run: (
    directory: string,
    options: Parameters<typeof generateUpdaterManifest>[0],
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "kitsune-updater-"));
  const options = {
    assetsDirectory: directory,
    releaseTag: "v0.2.0",
    repository: "gustawalk/kitsune",
    notesFile: join(directory, "notes.md"),
  };
  try {
    await writeFile(
      options.notesFile,
      "# Kitsune v0.2.0\n\n- Improved updates.\n",
    );
    for (const name of [
      "Kitsune setup.exe",
      "Kitsune.AppImage",
      "Kitsune.deb",
    ]) {
      await writeFile(join(directory, name), "artifact");
      await writeFile(join(directory, name + ".sig"), name + "-signature\n");
    }
    await run(directory, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("signed manifest routes Debian and AppImage installs to their matching bundles", async () =>
  fixture(async (_, options) => {
    const result = await generateUpdaterManifest(options);
    expect(result.version).toBe("0.2.0");
    expect(result.notes).toContain("Improved updates.");
    expect(Number.isNaN(Date.parse(result.pub_date))).toBe(false);
    expect(result.platforms["windows-x86_64"]).toEqual({
      signature: "Kitsune setup.exe-signature",
      url: "https://github.com/gustawalk/kitsune/releases/download/v0.2.0/Kitsune%20setup.exe",
    });
    expect(result.platforms["linux-x86_64-deb"].url).toEndWith("/Kitsune.deb");
    expect(result.platforms["linux-x86_64-appimage"].url).toEndWith(
      "/Kitsune.AppImage",
    );
  }));
test("manifest rejects missing signatures, empty bundles, duplicate assets, and empty notes", async () => {
  for (const fault of ["signature", "empty", "duplicate", "notes"] as const)
    await fixture(async (directory, options) => {
      if (fault === "signature") await rm(join(directory, "Kitsune.deb.sig"));
      if (fault === "empty")
        await writeFile(join(directory, "Kitsune.AppImage"), "");
      if (fault === "duplicate") {
        await mkdir(join(directory, "duplicate"));
        await writeFile(join(directory, "duplicate/Other.exe"), "artifact");
      }
      if (fault === "notes") await writeFile(options.notesFile, "\n");
      await expect(generateUpdaterManifest(options)).rejects.toThrow();
    });
});
test("stable publication rejects mismatched tag formats and invalid repositories", async () =>
  fixture(async (_, options) => {
    for (const releaseTag of ["0.2.0", "v0.2.0-beta.1", "vnext", "v0.2"])
      await expect(
        generateUpdaterManifest({ ...options, releaseTag }),
      ).rejects.toThrow();
    await expect(
      generateUpdaterManifest({ ...options, repository: "../elsewhere" }),
    ).rejects.toThrow();
  }));
