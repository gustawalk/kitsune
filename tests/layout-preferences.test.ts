import { expect, test } from "bun:test";
import {
  columnPreferenceKeys,
  gridLayoutSchema,
  reconciledColumns,
} from "../src/lib/layout-preferences";
test("layouts preserve duplicate columns and reconcile changed metadata", () => {
  const keys = columnPreferenceKeys(["id", "id", "__proto__"]);
  expect(new Set(keys).size).toBe(3);
  expect(
    reconciledColumns(keys, {
      hidden: [],
      order: [keys[1], "removed", keys[1]],
      widths: {},
    }),
  ).toEqual([keys[1], keys[0], keys[2]]);
  expect(
    gridLayoutSchema.safeParse({ hidden: [], order: [], widths: { id: 220 } })
      .success,
  ).toBe(true);
  for (const width of [0, Infinity, 1000])
    expect(
      gridLayoutSchema.safeParse({
        hidden: [],
        order: [],
        widths: { id: width },
      }).success,
    ).toBe(false);
});
