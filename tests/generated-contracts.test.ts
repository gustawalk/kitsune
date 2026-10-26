import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
function check(drift: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "kitsune-generated-"));
  try {
    for (const folder of ["scripts", "src-tauri/src", "src/lib"])
      mkdirSync(join(directory, folder), { recursive: true });
    for (const file of [
      "scripts/generate-types.ts",
      "src-tauri/src/model.rs",
      "src/lib/generated.ts",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      writeFileSync(join(directory, file), text.replace(/\r?\n/g, "\r\n"));
    }
    if (drift) {
      const file = join(directory, "src/lib/generated.ts");
      writeFileSync(
        file,
        readFileSync(file, "utf8") + "export type Drift = string;\r\n",
      );
    }
    return Bun.spawnSync(
      [process.execPath, "scripts/generate-types.ts", "--check"],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("contract generation accepts a Windows CRLF checkout", () => {
  const result = check(false);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
test("contract generation still rejects semantic drift with CRLF", () => {
  const result = check(true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "Rust/TypeScript contracts differ",
  );
});
