/** Stage native drivers explicitly: dlopen dependencies are invisible to bundlers. */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const runtime = join(root, "src-tauri/runtime");
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
if (process.platform === "win32") {
  const installed = process.env.KITSUNE_VCPKG_INSTALLED;
  if (!installed)
    throw Error(
      "Set KITSUNE_VCPKG_INSTALLED to vcpkg's x64-windows directory.",
    );
  for (const file of await readdir(join(installed, "bin"))) {
    if (file.endsWith(".dll"))
      await cp(join(installed, "bin", file), join(runtime, file));
  }
  for (const name of ["libpq.dll"]) await readFile(join(runtime, name));
  const redist = process.env.KITSUNE_MSVC_REDIST;
  if (!redist)
    throw Error(
      "Set KITSUNE_MSVC_REDIST to the x64 Microsoft.VC*.CRT redistributable directory.",
    );
  for (const file of await readdir(redist)) {
    if (file.endsWith(".dll"))
      await cp(join(redist, file), join(runtime, file));
  }
  const resources: Record<string, string> = {};
  for (const file of await readdir(runtime))
    if (file.endsWith(".dll")) resources[`runtime/${file}`] = file;
  await cp(join(installed, "share"), join(runtime, "licenses"), {
    recursive: true,
  });
  resources["runtime/licenses/"] = "licenses/";
  await writeFile(
    join(root, "src-tauri/tauri.runtime.conf.json"),
    JSON.stringify({ bundle: { resources } }, null, 2),
  );
} else if (process.platform === "linux") {
  const files: Record<string, string> = {};
  for (const library of ["libpq.so.5"]) {
    const result = Bun.spawnSync(["ldconfig", "-p"]);
    if (result.exitCode) throw Error("ldconfig failed");
    const source = result.stdout
      .toString()
      .split("\n")
      .find((line) => line.trimStart().startsWith(library + " "))
      ?.split(" => ")[1]
      ?.trim();
    if (!source) throw Error(`Install ${library} before packaging`);
    await cp(source, join(runtime, library));
    files[`usr/lib/${library}`] = `runtime/${library}`;
  }
  // Include transitive dependencies too, since the libraries are dynamically loaded.
  for (const library of ["libpq.so.5"]) {
    const result = Bun.spawnSync(["ldd", join(runtime, library)]);
    if (result.exitCode) throw Error("ldd failed");
    for (const line of result.stdout.toString().split("\n")) {
      const match = line.match(/^\s*(\S+) => (\/\S+)/);
      if (
        !match ||
        /^(libc\.|libm\.|libpthread\.|libdl\.|librt\.)/.test(match[1])
      )
        continue;
      await cp(match[2], join(runtime, match[1]));
      files[`usr/lib/${match[1]}`] = `runtime/${match[1]}`;
    }
  }
  for (const pkg of ["libpq5", "libssl3", "zlib1g", "libzstd1", "liblz4-1"]) {
    const source = `/usr/share/doc/${pkg}/copyright`;
    if (await Bun.file(source).exists()) {
      const name = `${pkg}-copyright`;
      await cp(source, join(runtime, name));
      files[`usr/share/doc/kitsune/runtime-licenses/${name}`] =
        `runtime/${name}`;
    }
  }
  await writeFile(
    join(root, "src-tauri/tauri.runtime.conf.json"),
    JSON.stringify({ bundle: { linux: { appimage: { files } } } }, null, 2),
  );
} else
  throw Error("Runtime staging currently supports Windows and Linux only.");
console.log("Native driver packaging configuration ready.");
