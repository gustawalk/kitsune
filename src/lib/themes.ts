export const THEME_IDS = [
  "dark",
  "light",
  "system",
  "midnight",
  "forest",
  "sand",
  "oled",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const themes: {
  id: ThemeId;
  name: string;
  description: string;
  background: string;
  surface: string;
  accent: string;
}[] = [
  {
    id: "dark",
    name: "Graphite",
    description: "The original dark workspace",
    background: "#191b1f",
    surface: "#25282e",
    accent: "#e85d3f",
  },
  {
    id: "light",
    name: "Daylight",
    description: "Clean and bright",
    background: "#fafafa",
    surface: "#e7e9ed",
    accent: "#c9442a",
  },
  {
    id: "system",
    name: "System",
    description: "Follow your device",
    background: "linear-gradient(120deg,#191b1f 50%,#fafafa 50%)",
    surface: "#82858b",
    accent: "#e85d3f",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Cool blue, quieter surfaces",
    background: "#101724",
    surface: "#243147",
    accent: "#ed8065",
  },
  {
    id: "forest",
    name: "Forest",
    description: "Deep green and warm accents",
    background: "#14201c",
    surface: "#2c4036",
    accent: "#ed9573",
  },
  {
    id: "sand",
    name: "Sand",
    description: "Warm paper for daytime",
    background: "#f5efe4",
    surface: "#e7dcc9",
    accent: "#ad422d",
  },
  {
    id: "oled",
    name: "Pitch black",
    description: "Minimal light, clear contrast",
    background: "#08090b",
    surface: "#202226",
    accent: "#f07659",
  },
];
export function resolvedTheme(
  theme: ThemeId,
  prefersDark: boolean,
): Exclude<ThemeId, "system"> {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}
