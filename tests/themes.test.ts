import { expect, test } from "bun:test";
import { themes, resolvedTheme, THEME_IDS } from "../src/lib/themes";
import { defaults } from "../src/lib/types";
import { settingsSchema } from "../src/lib/validation";
test("theme choices are valid persisted settings and system follows the device", () => {
  for (const theme of themes)
    expect(
      settingsSchema.safeParse({ ...defaults, theme: theme.id }).success,
    ).toBe(true);
  expect(new Set(themes.map((t) => t.id)).size).toBe(THEME_IDS.length);
  expect(resolvedTheme("system", true)).toBe("dark");
  expect(resolvedTheme("system", false)).toBe("light");
  expect(resolvedTheme("forest", false)).toBe("forest");
  expect(
    settingsSchema.safeParse({ ...defaults, theme: "unknown" }).success,
  ).toBe(false);
});
