/**
 * Categoriser adapter. The UI only calls `categoriser.categorise(input, context)`. Today it is a
 * deterministic, rule-based mock with fake latency ("Demo mode: simulated AI"); the real
 * `categoriser/` backend can be dropped in behind the same interface.
 *
 * Contract (tested in tests/unit/categoriser.test.ts):
 *  - Every returned field has state "suggested". The categoriser never writes "confirmed".
 *  - Same input + context -> same output (only `at` differs).
 *  - Tags are always taxonomy ids (closed set), at most 3.
 *  - Rejects with CategoriseError for unreadable inputs; the item is kept either way.
 */
import { tagLookup, type TagId } from "./taxonomy";
import { hash32 } from "./seeded";
import type { Field, ItemFields, ItemType, Source } from "./types";

export const MOCK_MODEL = "mock-categoriser-v1";

export interface CategoriseInput {
  id: string;
  url?: string;
  title?: string;
  rawContent: string;
  attachment?: { name: string; mime: string };
}

export interface CategoriseContext {
  /** Tag profile of each collection, built from its confirmed items. */
  collections: { id: string; name: string; tags: Partial<Record<TagId, number>> }[];
}

export interface Suggestion {
  /** Derived display title when the item has none. */
  title?: string;
  fields: Partial<ItemFields>;
}

export interface Categoriser {
  readonly label: string;
  categorise(input: CategoriseInput, context: CategoriseContext): Promise<Suggestion>;
}

export class CategoriseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoriseError";
  }
}

/* ---------------- rules ---------------- */

const HOST_SOURCE: [RegExp, Source][] = [
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)slack\.com$/, "slack"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
];

const HOST_TAGS: [RegExp, TagId[]][] = [
  [/(^|\.)github\.com$/, ["open-source"]],
  [/(^|\.)tympanus\.net$/, ["tutorial", "web-dev"]],
  [/(^|\.)awwwards\.com$/, ["inspiration", "design-ui"]],
  [/(^|\.)fonts\.google\.com$/, ["design-ui"]],
  [/(^|\.)developer\.mozilla\.org$/, ["docs-reference", "web-dev"]],
  [/(^|\.)w3\.org$/, ["docs-reference"]],
  [/(^|\.)web\.dev$/, ["web-dev", "article"]],
  [/(^|\.)lichess\.org$/, ["chess"]],
  [/(^|\.)devpost\.com$/, ["hackathon"]],
  [/(^|\.)owasp\.org$/, ["cybersecurity", "docs-reference"]],
  [/(^|\.)tailwindcss\.com$/, ["web-dev", "docs-reference"]],
  [/(^|\.)playwright\.dev$/, ["tool-library", "docs-reference"]],
];

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.invalid|.*\.test|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i;

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function typeFor(input: CategoriseInput, host?: string): ItemType {
  const mime = input.attachment?.mime ?? "";
  if (input.attachment) {
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
    return "file";
  }
  if (!host) return "note";
  if (/github\.com$/.test(host)) return "github";
  if (/(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return "video";
  if (/(reddit\.com|x\.com|twitter\.com|bsky\.app|threads\.net)$/.test(host)) return "social";
  return "link";
}

function sourceFor(input: CategoriseInput, host?: string): Source {
  if (input.attachment) return "upload";
  if (!host) return "manual";
  return HOST_SOURCE.find(([re]) => re.test(host))?.[1] ?? "web";
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean);

function tagsFor(input: CategoriseInput, host: string | undefined, type: ItemType) {
  const score = new Map<TagId, number>();
  const bump = (t: TagId, n: number) => score.set(t, (score.get(t) ?? 0) + n);
  if (host) for (const [re, tags] of HOST_TAGS) if (re.test(host)) tags.forEach((t) => bump(t, 2));
  if (type === "github") bump("open-source", 1);
  let path = "";
  try {
    path = input.url ? new URL(input.url).pathname : "";
  } catch {
    /* ignore */
  }
  const text = [input.title ?? "", input.rawContent, path.replace(/[/_-]/g, " "), input.attachment?.name ?? ""].join(" ");
  for (const w of words(text)) {
    const clean = w.replace(/^[.-]+|[.-]+$/g, "");
    const tag = tagLookup.get(clean) ?? tagLookup.get(clean.replace(/\./g, ""));
    if (tag) bump(tag, 1);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const top = ranked[0]?.[1] ?? 0;
  return {
    tags: ranked.map(([t]) => t),
    confidence: ranked.length ? Math.min(0.92, 0.5 + top * 0.1) : 0.3,
  };
}

export function matchTags(text: string): { tags: TagId[] } {
  const found: TagId[] = [];
  for (const w of words(text)) {
    const clean = w.replace(/^[.-]+|[.-]+$/g, "");
    const tag = tagLookup.get(clean) ?? tagLookup.get(clean.replace(/\./g, ""));
    if (tag && !found.includes(tag)) found.push(tag);
  }
  return { tags: found.slice(0, 5) };
}

export function titleFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (/github\.com$/.test(host) && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    const slug = parts.at(-1);
    if (slug && !/^\d+$/.test(slug)) {
      const t = decodeURIComponent(slug).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim();
      if (t.length > 2) return t[0].toUpperCase() + t.slice(1);
    }
    return host;
  } catch {
    return undefined;
  }
}

function firstSentence(text: string): string {
  const flat = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : flat).trim();
  if (s.length <= 96) return s;
  const cut = s.slice(0, 95);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 95).replace(/[,;:]$/, "")}…`;
}

function summaryFor(input: CategoriseInput, type: ItemType, host: string | undefined, title?: string) {
  const text = input.rawContent.trim();
  const isJustUrl = !!input.url && text.replace(input.url, "").trim() === "";
  if (text && !isJustUrl && !input.attachment) return { value: firstSentence(text), confidence: 0.82 };
  if (input.attachment) {
    const kind = type === "image" ? "Screenshot" : type === "pdf" ? "PDF" : "File";
    const base = input.attachment.name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ");
    const extra = text ? `: ${firstSentence(text)}` : ".";
    return { value: `${kind} “${base}”${extra}`.slice(0, 120), confidence: 0.55 };
  }
  if (type === "github") return { value: `GitHub repo ${title ?? ""}, worth a closer read.`.replace(" ,", ","), confidence: 0.6 };
  if (type === "video") return { value: `A video${title && title !== host ? ` on ${title.toLowerCase()}` : ""}.`, confidence: 0.5 };
  return { value: `${title && title !== host ? `${title}, on` : "A page on"} ${host}.`, confidence: 0.55 };
}

function collectionFor(tags: TagId[], ctx: CategoriseContext) {
  let best: { id: string; score: number } | undefined;
  for (const c of ctx.collections) {
    const total = Object.values(c.tags).reduce((a, b) => a + (b ?? 0), 0);
    if (!total) continue;
    const score = tags.reduce((acc, t, i) => acc + ((c.tags[t] ?? 0) / total) * (i === 0 ? 1.2 : 1), 0);
    if (!best || score > best.score || (score === best.score && c.id < best.id)) best = { id: c.id, score };
  }
  return best && best.score >= 0.18 ? { id: best.id, confidence: Math.min(0.9, 0.4 + best.score) } : undefined;
}

/** Pure core. Exported for seeding and tests. */
export function categoriseSync(input: CategoriseInput, ctx: CategoriseContext, at = new Date().toISOString()): Suggestion {
  const host = hostOf(input.url);
  if (input.url && !host) throw new CategoriseError("That link doesn't parse, so there was nothing to read.");
  if (host && BLOCKED_HOST.test(host)) throw new CategoriseError(`Couldn't reach ${host} from here. The link is saved; the tidy-up isn't.`);
  if (!input.rawContent.trim() && !input.url && !input.attachment) throw new CategoriseError("There's nothing in this scrap to read.");

  const type = typeFor(input, host);
  const source = sourceFor(input, host);
  const title = input.title ?? (input.url ? titleFromUrl(input.url) : undefined);
  const { tags, confidence: tagConf } = tagsFor(input, host, type);
  const summary = summaryFor(input, type, host, title);
  const coll = collectionFor(tags, ctx);

  const model = <T,>(value: T, confidence: number): Field<T> => ({
    value,
    state: "suggested",
    by: "model",
    model: MOCK_MODEL,
    confidence: Math.round(confidence * 100) / 100,
    at,
  });
  const rule = <T,>(value: T): Field<T> => ({ value, state: "suggested", by: "rule", confidence: 1, at });

  const fields: Partial<ItemFields> = {
    type: rule(type),
    source: rule(source),
    tags: model(tags, tagConf),
    oneLineSummary: model(summary.value, summary.confidence),
  };
  if (coll) fields.collection = model<string | null>(coll.id, coll.confidence);
  return { title: input.title ? undefined : title, fields };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockCategoriser(opts: { latency?: (id: string) => number } = {}): Categoriser {
  const latency = opts.latency ?? ((id: string) => 900 + (hash32(id) % 900));
  return {
    label: "Demo mode: simulated AI",
    async categorise(input, ctx) {
      await sleep(latency(input.id));
      return categoriseSync(input, ctx);
    },
  };
}

export const categoriser: Categoriser = createMockCategoriser();
