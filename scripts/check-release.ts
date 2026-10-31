import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargo
  .split(/\n\[/)[0]
  .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (
  !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
  pkg.version !== tauri.version ||
  pkg.version !== cargoVersion
)
  throw new Error("Package, Cargo and Tauri release versions must match.");
if (
  process.env.GITHUB_EVENT_NAME === "push" &&
  process.env.GITHUB_REF_NAME !== `v${pkg.version}`
)
  throw new Error("Release tag must match the application version.");
if (!(await readFile(`docs/releases/v${pkg.version}.md`, "utf8")).trim())
  throw new Error("Release notes must not be empty.");
console.log(`Release ${pkg.version}: versions and release notes verified.`);
