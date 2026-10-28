import { expect, test } from "bun:test";
import {
  themes,
  normalizeTheme,
  resolvedTheme,
  THEME_IDS,
} from "../src/lib/themes";
import { defaults } from "../src/lib/types";
import { settingsSchema } from "../src/lib/validation";

function luminance(hex: string) {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("theme choices are valid persisted settings and system follows the device", () => {
  for (const theme of themes)
    expect(
      settingsSchema.safeParse({ ...defaults, theme: theme.id }).success,
    ).toBe(true);
  expect(new Set(themes.map((t) => t.id)).size).toBe(THEME_IDS.length);
  expect(resolvedTheme("system", true)).toBe("dark");
  expect(resolvedTheme("system", false)).toBe("light");
  expect(resolvedTheme("forest", false)).toBe("forest");
  expect(normalizeTheme("catppuccin-macchiato")).toBe("midnight");
  expect(normalizeTheme("monokai-octagon")).toBe("forest");
  expect(normalizeTheme("rose-pine-moon")).toBe("violet");
  expect(normalizeTheme("nord")).toBe("midnight");
  expect(THEME_IDS).toHaveLength(8);
  expect(
    settingsSchema.safeParse({ ...defaults, theme: "unknown" }).success,
  ).toBe(false);
});

test("new theme text and accents remain readable on both main surfaces", () => {
  for (const theme of themes.filter((choice) =>
    ["midnight", "forest", "sand", "oled", "violet"].includes(choice.id),
  )) {
    for (const foreground of [theme.text, theme.muted, theme.accent]) {
      expect(contrast(foreground, theme.background)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(foreground, theme.surface)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
