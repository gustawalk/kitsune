import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { DataGrid } from "../src/components/DataGrid";
import type { ForeignKey, ResultSet } from "../src/lib/types";

test("FK labels are display-only and original IDs remain available in the cell", () => {
  const table = { schema: "main", name: "events", kind: "table" };
  const key: ForeignKey = {
    name: "issue",
    from: table,
    to: { ...table, name: "issues" },
    columns: ["issue_id"],
    targetColumns: ["id"],
  };
  const result: ResultSet = {
    columns: ["issue_id"],
    types: ["text"],
    rows: [[{ kind: "text", value: "raw-id" }]],
    affected: 0,
    durationMs: 0,
    truncated: false,
    nextCursor: null,
    keysetSupported: false,
  };
  const render = (labels?: Map<string, Array<string | undefined>>) =>
    renderToString(
      <DataGrid
        result={result}
        foreignKeys={[key]}
        referenceLabels={labels}
        onForeignKey={() => undefined}
        onReferenceDisplay={() => undefined}
      />,
    );
  const labeled = render(new Map([["issue_id", ["Issue title"]]]));
  expect(labeled).toContain(
    'title="Issue title · raw-id · Open referenced record"',
  );
  expect(labeled).toContain(">Issue title</button>");
  expect(labeled).toContain(
    'aria-label="Display referenced value for issue_id"',
  );
  expect(render()).toContain(">raw-id</button>");
  expect(render(new Map([["issue_id", [undefined]]]))).toContain(
    ">raw-id</button>",
  );
  expect(result.rows[0][0]).toEqual({ kind: "text", value: "raw-id" });
});

test("wide results render only nearby columns without losing their grid positions", () => {
  const columns = Array.from({ length: 100 }, (_, i) => `column${i}`);
  const result: ResultSet = {
    columns,
    types: columns.map(() => "text"),
    rows: [columns.map((value) => ({ kind: "text", value }))],
    affected: 0,
    durationMs: 0,
    truncated: false,
    nextCursor: null,
    keysetSupported: false,
  };
  const html = renderToString(<DataGrid result={result} />);
  expect((html.match(/role="gridcell"/g) || []).length).toBeLessThan(12);
  expect(html).toContain("grid-column:2");
  expect(html).not.toContain('data-grid-cell="0:99"');
});
