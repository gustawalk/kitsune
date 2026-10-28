import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { FilterBuilder } from "../src/components/FilterBuilder";
import type { FilterGroup, Metadata } from "../src/lib/types";

const metadata: Metadata = {
  table: { schema: "main", name: "issues", kind: "table" },
  columns: [
    {
      name: "title",
      dataType: "text",
      nullable: true,
      pk: 0,
      enumType: null,
      defaultValue: null,
    },
  ],
  foreignKeys: [],
  indexes: [],
  enums: [],
};
const condition = {
  column: "title",
  operator: "eq",
  value: { kind: "text" as const, value: "Example" },
};
function render(groups: FilterGroup[]) {
  return renderToString(
    <FilterBuilder
      metadata={metadata}
      driver="sqlite"
      groups={groups}
      mode="all"
      onApply={() => undefined}
      preferenceKey="test:filters"
    />,
  );
}

test("single filter keeps grouping controls hidden and saved filters collapsed", () => {
  const html = render([{ mode: "all", filters: [condition] }]);
  expect(html).toContain('aria-label="Filter value"');
  expect(html).toContain('value="Example"');
  expect(html).not.toContain('aria-label="Join conditions');
  expect(html).not.toContain('aria-label="Join filter groups"');
  expect(html).toContain('<details class="saved-filter-menu">');
  expect(html).not.toContain("<details open");
});

test("multiple conditions and groups expose the corresponding all/any controls", () => {
  const conditions = render([{ mode: "any", filters: [condition, condition] }]);
  expect(conditions).toContain('aria-label="Join conditions in group 1"');
  expect(conditions).not.toContain('aria-label="Join filter groups"');
  const groups = render([
    { mode: "all", filters: [condition] },
    { mode: "any", filters: [condition] },
  ]);
  expect(groups).toContain('aria-label="Join filter groups"');
  expect(groups).toContain('aria-label="Join conditions in group 2"');
});
