import { expect, test } from "bun:test";
import { validateResponse } from "../src/lib/validation";

test("file picker accepts local paths and cancellation but rejects malformed responses", () => {
  const path = "/home/developer/My databases/app.sqlite";
  expect(validateResponse("choose_sqlite_file", path)).toBe(path);
  expect(validateResponse("choose_sqlite_file", null)).toBeNull();
  expect(() => validateResponse("choose_sqlite_file", { path })).toThrow();
});
