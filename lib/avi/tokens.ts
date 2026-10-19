/**
 * Design tokens, single source of truth. `recall-desk.css` mirrors these as CSS variables;
 * `toTokensStudio()` emits Tokens Studio (Figma) format.
 * Palette logic after Oryzo AI (one hot accent on a warm near-black); values are AVI's own.
 */
import { DUR, EASE_OUT_EXPO } from "./motion";

export const TOKENS = {
  color: {
    cream: "#F4EFE4",
    kraft: "#C9A878",
    ink: "#1A1612",
    graphite: "#55524C",
    accent: "#FF8539",
    night: "#100904",
    nightPage: "#1C150F",
    nightMuted: "#A39E94",
    tapeSage: "#B9C8AE",
    tapeRose: "#E4B9B2",
  },
  font: {
    display: "Instrument Serif",
    body: "IBM Plex Sans",
    mono: "DM Mono",
    hand: "Patrick Hand",
  },
  duration: DUR,
  easing: { outExpo: `cubic-bezier(${EASE_OUT_EXPO.join(", ")})` },
  radius: { paper: 2, control: 6 },
} as const;

export const SEMANTIC = {
  light: { bg: "kraft", page: "cream", text: "ink", muted: "graphite", accent: "accent", onAccent: "ink" },
  dark: { bg: "night", page: "nightPage", text: "cream", muted: "nightMuted", accent: "accent", onAccent: "ink" },
} as const;

export function toTokensStudio() {
  const color = Object.fromEntries(Object.entries(TOKENS.color).map(([k, v]) => [k, { value: v, type: "color" }]));
  const fontFamilies = Object.fromEntries(Object.entries(TOKENS.font).map(([k, v]) => [k, { value: v, type: "fontFamilies" }]));
  const duration = Object.fromEntries(Object.entries(TOKENS.duration).map(([k, v]) => [k, { value: `${v * 1000}ms`, type: "other" }]));
  const sem = (mode: keyof typeof SEMANTIC) =>
    Object.fromEntries(Object.entries(SEMANTIC[mode]).map(([k, ref]) => [k, { value: `{color.${ref}}`, type: "color" }]));
  return {
    global: {
      color,
      fontFamilies,
      duration,
      easing: { outExpo: { value: TOKENS.easing.outExpo, type: "other" } },
      borderRadius: Object.fromEntries(Object.entries(TOKENS.radius).map(([k, v]) => [k, { value: `${v}`, type: "borderRadius" }])),
    },
    light: { semantic: sem("light") },
    dark: { semantic: sem("dark") },
    $themes: [
      { id: "light", name: "Paper", selectedTokenSets: { global: "source", light: "enabled" } },
      { id: "dark", name: "Night scratchbook", selectedTokenSets: { global: "source", dark: "enabled" } },
    ],
    $metadata: { tokenSetOrder: ["global", "light", "dark"] },
  };
}
