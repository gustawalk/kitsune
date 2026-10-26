import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const command =
  process.platform === "win32"
    ? [
        Bun.which("pwsh") || "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(root, "scripts/test-windows.ps1"),
      ]
    : ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"];
const child = Bun.spawn([...command, ...process.argv.slice(2)], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
