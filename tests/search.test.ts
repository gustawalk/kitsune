import { expect, test } from "bun:test";
import { rankSearch } from "../src/lib/search";
import { filterSchemaTables } from "../src/lib/schema";
const tables = [
  "DealContract",
  "DealProposal",
  "other_deal",
  "dealAuditLogs",
  "deal",
].map((name) => ({ name, schema: "public", kind: "table" }));
const names = (t: (typeof tables)[number]) => [t.name, `${t.schema}.${t.name}`];

test("exact bare table names outrank qualified prefixes and substring matches", () => {
  expect(rankSearch(tables, "  DEAL  ", names).map((t) => t.name)).toEqual([
    "deal",
    "DealContract",
    "DealProposal",
    "dealAuditLogs",
    "other_deal",
  ]);
  expect(rankSearch(tables, "public.deal", names)[0].name).toBe("deal");
  expect(tables[0].name).toBe("DealContract");
});
test("empty searches preserve order; missing and literal punctuation searches are safe", () => {
  expect(rankSearch(tables, "   ", names)).toEqual(tables);
  expect(rankSearch(tables, "missing", names)).toEqual([]);
  expect(rankSearch(tables, "deal[", names)).toEqual([]);
});
test("detail matches stay below name matches and results are ranked before truncation", () => {
  const items = [
    { name: "Other", detail: "deal" },
    ...Array.from({ length: 150 }, (_, i) => ({
      name: `deal${i}`,
      detail: "Table",
    })),
    { name: "deal", detail: "Table" },
  ];
  const results = rankSearch(
    items,
    "deal",
    (i) => [i.name],
    (i) => [i.detail],
  );
  expect(results.slice(0, 100)[0].name).toBe("deal");
  expect(results.at(-1)?.name).toBe("Other");
});
test("schema catalog shares ranking while keeping namespace and kind filters", () => {
  const items = [...tables, { name: "deal", schema: "archive", kind: "view" }];
  expect(filterSchemaTables(items, "deal", "public", "table")[0].name).toBe(
    "deal",
  );
  expect(filterSchemaTables(items, "archive.deal", null, "view")).toEqual([
    items.at(-1)!,
  ]);
});
