export const THEME_IDS = [
  "dark",
  "light",
  "system",
  "midnight",
  "forest",
  "sand",
  "oled",
  "violet",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const themes: {
  id: ThemeId;
  name: string;
  description: string;
  background: string;
  surface: string;
  accent: string;
  text: string;
  muted: string;
}[] = [
  {
    id: "dark",
    name: "Graphite",
    description: "The original dark workspace",
    background: "#191b1f",
    surface: "#25282e",
    accent: "#e85d3f",
    text: "#e8e9ec",
    muted: "#9da1aa",
  },
  {
    id: "light",
    name: "Daylight",
    description: "Clean and bright",
    background: "#fafafa",
    surface: "#e7e9ed",
    accent: "#c9442a",
    text: "#202228",
    muted: "#5d626d",
  },
  {
    id: "system",
    name: "System",
    description: "Follow your device",
    background: "linear-gradient(120deg,#191b1f 50%,#fafafa 50%)",
    surface: "#82858b",
    accent: "#e85d3f",
    text: "#202228",
    muted: "#5d626d",
  },
  {
    id: "midnight",
    name: "Midnight Blue",
    description: "Deep navy with clear sky-blue accents",
    background: "#111827",
    surface: "#1b2638",
    accent: "#7dd3fc",
    text: "#edf4ff",
    muted: "#b2c0d4",
  },
  {
    id: "forest",
    name: "Forest",
    description: "Pine green surfaces with fresh mint accents",
    background: "#14231e",
    surface: "#1c3028",
    accent: "#86efac",
    text: "#edf7f0",
    muted: "#b0c8b9",
  },
  {
    id: "sand",
    name: "Sandstone",
    description: "Warm light surfaces with readable clay accents",
    background: "#f4eee4",
    surface: "#fffaf2",
    accent: "#873d1d",
    text: "#29251f",
    muted: "#62584b",
  },
  {
    id: "oled",
    name: "Pitch Black",
    description: "Near-black surfaces with bright coral accents",
    background: "#08090b",
    surface: "#14161a",
    accent: "#ff9b80",
    text: "#f3f4f6",
    muted: "#bdc1ca",
  },
  {
    id: "violet",
    name: "Violet Dusk",
    description: "Deep aubergine with soft lavender accents",
    background: "#211b2d",
    surface: "#2d2540",
    accent: "#c4b5fd",
    text: "#f2edff",
    muted: "#c1b8d5",
  },
];
export function normalizeTheme(theme: string): ThemeId {
  const legacy: Record<string, Exclude<ThemeId, "system">> = {
    "catppuccin-macchiato": "midnight",
    "monokai-octagon": "forest",
    "rose-pine-moon": "violet",
    nord: "midnight",
  };
  return (
    legacy[theme] ||
    (THEME_IDS.includes(theme as ThemeId) ? (theme as ThemeId) : "dark")
  );
}
export function resolvedTheme(
  theme: ThemeId,
  prefersDark: boolean,
): Exclude<ThemeId, "system"> {
  const normalized = normalizeTheme(theme);
  return normalized === "system"
    ? prefersDark
      ? "dark"
      : "light"
    : normalized;
}
