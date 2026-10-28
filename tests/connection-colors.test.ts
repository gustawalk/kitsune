import { expect, test } from "bun:test";
import { emptyConnection } from "../src/lib/types";
import { connectionSchema } from "../src/lib/validation";

test("legacy connections use default colors and chosen colors survive validation", () => {
  const { color, ...legacy } = {
    ...emptyConnection(),
    id: "legacy",
    name: "Local",
  };
  expect(color).toBe("");
  expect(connectionSchema.parse(legacy).color).toBe("");
  expect(connectionSchema.parse({ ...legacy, color: "#69b7d4" }).color).toBe(
    "#69b7d4",
  );
  expect(connectionSchema.parse({ ...legacy, color: "#ABC123" }).color).toBe(
    "#ABC123",
  );
  for (const color of ["red", "#fff", "#12345g", "123456", "#12345678"])
    expect(connectionSchema.safeParse({ ...legacy, color }).success).toBe(
      false,
    );
});
