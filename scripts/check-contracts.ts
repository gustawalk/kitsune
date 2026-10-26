import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponse } from "../src/lib/validation";
const directory = mkdtempSync(join(tmpdir(), "kitsune-contract-"));
try {
  const file = join(directory, "responses.json");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "scripts/test-rust.ts",
      "emit_contract_fixture",
      "--",
      "--ignored",
    ],
    {
      env: { ...process.env, KITSUNE_CONTRACT_FILE: file },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0) throw new Error("Rust contract fixture failed");
  const responses = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  for (const [method, response] of Object.entries(responses))
    validateResponse(method, response);
  console.log(
    `Validated ${Object.keys(responses).length} real SQLite service responses against frontend schemas.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
