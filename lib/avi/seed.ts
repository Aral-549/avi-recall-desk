/** ~30 believable sample scraps across 3 collections, so first load is never empty. All marked origin "seed". */
import { categoriseSync } from "./categoriser";
import { seedUuid } from "./seeded";
import { STORAGE_SCHEMA_VERSION, type AppData, type Collection, type Field, type Item } from "./types";

export const SEED_COLLECTIONS: Collection[] = [
  { id: seedUuid(9001), name: "Portfolio redesign", createdAt: "2026-09-18T09:00:00.000Z", origin: "seed" },
  { id: seedUuid(9002), name: "Side project: AVI", createdAt: "2026-09-18T09:05:00.000Z", origin: "seed" },
  { id: seedUuid(9003), name: "Reading pile", createdAt: "2026-09-18T09:10:00.000Z", origin: "seed" },
];

type SeedSpec = {
  url?: string;
  raw?: string;
  why?: string;
  image?: string;
  /** Collection index, or null for Unfiled. */
  col: 0 | 1 | 2 | null;
  /** Confirmed seeds look "done"; the rest wait in review so the review flow has work. */
  confirmed: boolean;
};

const SPECS: SeedSpec[] = [
  { url: "https://www.awwwards.com/sites/oryzo-ai", raw: "Dark warm palette, one orange accent, huge type. The restraint is the whole trick.", why: "steal the one-accent rule", col: 0, confirmed: true },
  { url: "https://tympanus.net/codrops/2024/unreveal-text-animation", raw: "Codrops tutorial on clip-path text wipes with expo easing.", why: "for the cleanup moment", col: 1, confirmed: true },
  { url: "https://github.com/pmndrs/zustand", raw: "Bear necessities for state management in React. Tiny, no providers.", col: 1, confirmed: true },
  { url: "https://github.com/101arrowz/fflate", raw: "Fast JavaScript compression library, zip in the browser.", why: "markdown zip export", col: 1, confirmed: false },
  { url: "https://fonts.google.com/specimen/Instrument+Serif", raw: "Condensed display serif, free, great at 10vw.", col: 0, confirmed: true },
  { raw: "Case studies should open with the outcome, not the process. Nobody reads step 1 of 9.", why: "said in a crit, it stuck", col: 0, confirmed: true },
  { image: "hero-type-study.png", raw: "Screenshot: hero with oversized serif and a tiny mono caption.", why: "the scale contrast", col: 0, confirmed: false },
  { url: "https://camillemormal.com", raw: "Drag gallery with eased momentum. Feels physical without a physics engine.", why: "board panning feel", col: 1, confirmed: true },
  { url: "https://www.nngroup.com/articles/undo/", raw: "Undo beats confirmation dialogs. Make destructive actions reversible instead of asking twice.", col: 1, confirmed: false },
  { url: "https://react.dev/reference/react/useOptimistic", raw: "React docs for useOptimistic, optimistic UI updates.", col: 1, confirmed: false },
  { url: "https://www.youtube.com/watch?v=portfolio-teardown", raw: "Portfolio teardown video: 12 designer portfolios reviewed live.", col: 0, confirmed: false },
  { raw: "Rotation above 2 degrees makes body text feel drunk. Stay at 1.5 max.", why: "rule for AVI notes", col: 1, confirmed: true },
  { url: "https://github.com/vercel/next.js", raw: "The React framework. Static export works with output: export.", col: 1, confirmed: true },
  { url: "https://www.smashingmagazine.com/2024/05/accessible-focus-indicators", raw: "Article on focus indicators that pass contrast on any background.", why: "double ring trick", col: 1, confirmed: false },
  { image: "portfolio-grid-wip.png", raw: "Current portfolio grid, too many columns on tablet.", col: 0, confirmed: true },
  { url: "https://paulgraham.com/makersschedule.html", raw: "Maker's schedule, manager's schedule. One meeting can blow a whole afternoon.", why: "reread before planning week", col: 2, confirmed: true },
  { url: "https://www.robinsloan.com/notes/home-cooked-app", raw: "An app can be a home-cooked meal: made for four people, no growth plan.", why: "this is what AVI is", col: 2, confirmed: true },
  { url: "https://x.com/rauchg/status/1820000000000000000", raw: "Thread on shipping small and often, with preview links for every change.", col: 2, confirmed: false },
  { url: "https://www.reddit.com/r/web_design/comments/abc123/portfolio_feedback", raw: "Reddit thread asking for brutal portfolio feedback. Top comment: cut half the projects.", col: 0, confirmed: false },
  { url: "https://ciechanow.ski/mechanical-watch", raw: "Interactive essay on how a mechanical watch works. Absurdly good explanations.", why: "the bar for explainers", col: 2, confirmed: true },
  { url: "https://www.figma.com/community/plugin/tokens-studio", raw: "Tokens Studio plugin for Figma, imports tokens.json.", col: 1, confirmed: false },
  { raw: "Idea: export should be the most trusted feature, not an afterthought. If people can leave, they stay.", why: "core principle", col: 1, confirmed: true },
  { url: "https://overreacted.io/the-two-reacts", raw: "Dan Abramov essay on server and client React as two halves.", col: 2, confirmed: false },
  { url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API", raw: "MDN reference for IndexedDB, storing files and blobs in the browser.", col: 1, confirmed: true },
  { image: "night-palette.png", raw: "Night mode palette test: #100904 base, cream text.", col: 0, confirmed: false },
  { url: "https://www.joshwcomeau.com/css/designing-shadows", raw: "Designing beautiful shadows in CSS: layered, tinted, consistent light source.", why: "paper shadows", col: 0, confirmed: true },
  { raw: "Interview prep: walk through one project end to end in 4 minutes, outcome first.", col: 2, confirmed: false },
  { url: "https://github.com/microsoft/playwright", raw: "Playwright, browser automation and end-to-end testing.", col: 1, confirmed: false },
  { url: "https://craigmod.com/essays/fast_software", raw: "Essay: fast software is the best software. Speed is a feature people feel.", col: 2, confirmed: false },
  { raw: "Hackathon in November? Maybe build the Idea Lab part properly.", col: null, confirmed: false },
];

const DAY = 86_400_000;
const BASE = Date.parse("2026-10-18T16:00:00.000Z");

export function buildSeed(): AppData {
  const items: Record<string, Item> = {};
  const collectionsForCat = SEED_COLLECTIONS.map((c) => ({ id: c.id, name: c.name, tags: {} }));
  SPECS.forEach((s, i) => {
    const id = seedUuid(i + 1);
    const created = new Date(BASE - i * DAY * 0.9 - (i % 5) * 3_600_000);
    const attachment = s.image ? { blobId: `seed:${s.image}`, name: s.image, mime: "image/png", bytes: 184_000 + i * 913 } : undefined;
    const sug = categoriseSync(
      { id, url: s.url, rawContent: s.raw ?? "", attachment },
      { collections: collectionsForCat },
      new Date(created.getTime() + 2000).toISOString(),
    );
    const colId = s.col === null ? null : SEED_COLLECTIONS[s.col].id;
    const fields = { ...sug.fields };
    fields.collection = { ...fields.collection, value: colId, confidence: colId ? Math.max(fields.collection.confidence ?? 0.5, 0.62) : 0.35 };
    if (s.confirmed) {
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
        (fields as Record<string, Field<unknown>>)[k] = { ...fields[k], state: "confirmed" };
      }
    }
    items[id] = {
      id,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      url: s.url,
      title: sug.title,
      rawContent: s.raw ?? "",
      whyISavedThis: s.why,
      attachment,
      fields,
      status: "ready",
      origin: "seed",
    };
  });
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    items,
    collections: SEED_COLLECTIONS.map((c) => ({ ...c })),
    settings: { tidy: null, theme: "system", connectors: {} },
    chat: [],
    jobs: {},
    sampleCleared: false,
  };
}

export function emptyData(): AppData {
  return { ...buildSeed(), items: {}, collections: [], sampleCleared: true };
}
