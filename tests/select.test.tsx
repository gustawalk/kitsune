import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Select, SelectItem } from "../src/components/ui/select";
test("shared select renders an accessible required combobox and keeps raw numeric form values", () => {
  const html = renderToString(
    <form>
      <label>
        Page size
        <Select
          name="pageSize"
          aria-label="Page size"
          required
          value={100}
          onValueChange={() => undefined}
        >
          <SelectItem value={25}>25 rows</SelectItem>
          <SelectItem value={100}>100 rows</SelectItem>
        </Select>
      </label>
    </form>,
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-required="true"');
  expect(html).toMatch(/name="pageSize"[^>]*value="100"/);
  expect(html).not.toContain('name="pageSize" value="option:100"');
});
test("shared select supports empty placeholders, disabled controls, and zero values", () => {
  const empty = renderToString(
    <Select
      aria-label="Connection"
      disabled
      value=""
      onValueChange={() => undefined}
    >
      <SelectItem value="">Select connection</SelectItem>
      <SelectItem value="local">Local</SelectItem>
    </Select>,
  );
  expect(empty).toContain("Select connection");
  expect(empty).toContain('disabled=""');
  const zero = renderToString(
    <Select name="statement" value={0} onValueChange={() => undefined}>
      <SelectItem value={0}>Statement 1</SelectItem>
    </Select>,
  );
  expect(zero).toMatch(/name="statement"[^>]*value="0"/);
});
