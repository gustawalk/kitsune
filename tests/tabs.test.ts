import { expect, test } from "bun:test";
import { tabCloseIds, reorderedTabs } from "../src/lib/tabs";
import type { Tab } from "../src/lib/types";
const tabs: Tab[] = ["a", "b", "c", "d"].map((id) => ({
  id,
  kind: "query",
  title: id,
}));
test("tab close scopes use the visible order and never include the anchor accidentally", () => {
  expect(tabCloseIds(tabs, "b", "tab")).toEqual(["b"]);
  expect(tabCloseIds(tabs, "b", "others")).toEqual(["a", "c", "d"]);
  expect(tabCloseIds(tabs, "b", "left")).toEqual(["a"]);
  expect(tabCloseIds(tabs, "b", "right")).toEqual(["c", "d"]);
  expect(tabCloseIds(tabs, "b", "all")).toEqual(["a", "b", "c", "d"]);
  expect(tabCloseIds(tabs, "missing", "all")).toEqual([]);
  expect(tabCloseIds(tabs, "a", "left")).toEqual([]);
});
test("tab moves work in both directions without mutating tabs or duplicating their sessions", () => {
  expect(reorderedTabs(tabs, "a", "c", "after").map((t) => t.id)).toEqual([
    "b",
    "c",
    "a",
    "d",
  ]);
  expect(reorderedTabs(tabs, "d", "b", "before").map((t) => t.id)).toEqual([
    "a",
    "d",
    "b",
    "c",
  ]);
  expect(reorderedTabs(tabs, "a", "a", "after")).toBe(tabs);
  expect(reorderedTabs(tabs, "missing", "b", "after")).toBe(tabs);
  expect(tabs.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
  expect(reorderedTabs(tabs, "d", "a", "before")[0]).toBe(tabs[3]);
});
