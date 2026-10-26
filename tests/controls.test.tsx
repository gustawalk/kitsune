import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Checkbox } from "../src/components/ui/checkbox";
import { Button } from "../src/components/ui/button";
test("themed checkbox exposes mixed, checked and required states", () => {
  const mixed = renderToString(
    <Checkbox
      aria-label="Select page"
      checked={false}
      indeterminate
      onCheckedChange={() => undefined}
    />,
  );
  expect(mixed).toContain('role="checkbox"');
  expect(mixed).toContain('aria-checked="mixed"');
  expect(mixed).toContain('data-state="indeterminate"');
  const checked = renderToString(
    <form>
      <Checkbox name="consent" checked required />
    </form>,
  );
  expect(checked).toContain('aria-checked="true"');
  expect(checked).toContain('required=""');
});
test("disabled tooltip triggers stay keyboard discoverable without native titles", () => {
  const markup = renderToString(
    <Button disabled title="Enable write access first">
      Restore
    </Button>,
  );
  expect(markup).not.toContain('title="Enable write access first"');
  expect(markup).toContain('class="tooltip-disabled"');
  expect(markup).toContain('tabindex="0"');
});
