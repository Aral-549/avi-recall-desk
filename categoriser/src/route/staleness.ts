import type { Extraction, Field, Staleness } from "../schemas/index.js";

const DAY_MS = 86_400_000;
/** Ages (days since the content date) at which an item becomes `aging` and `stale`. */
export const STALENESS_DAYS = { aging: 180, stale: 730 } as const;
/** Content dates further than this into the future are treated as bogus and ignored. */
const FUTURE_SKEW_MS = DAY_MS;

const CONF_DEAD = 0.9;
const CONF_CONTENT_DATE = 0.7;
const CONF_SAVED_AT = 0.4;

export type StalenessInput = {
  extraction: Extraction | null;
  savedAt: string;
  now: Date;
};

function parseDate(v: unknown, now: Date): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() - now.getTime() > FUTURE_SKEW_MS) return null;
  return d;
}

/** Most specific content date available: page publish date, then GitHub last push. */
export function contentDate(extraction: Extraction | null, now: Date): Date | null {
  if (!extraction) return null;
  return parseDate(extraction.publishedAt, now) ?? parseDate(extraction.meta?.pushedAt, now);
}

export function bandForAge(ageDays: number): Staleness {
  if (ageDays >= STALENESS_DAYS.stale) return "stale";
  if (ageDays >= STALENESS_DAYS.aging) return "aging";
  return "fresh";
}

/**
 * Rule-based staleness (SPEC: fetch signals + content date + age). `not_found` is the only signal
 * strong enough for `dead`; blocked/timeout/error say nothing about the page itself.
 */
export function staleness(input: StalenessInput, at: string): Field<Staleness> {
  const rule = { state: "suggested", by: "rule", at } as const;
  if (input.extraction?.status === "not_found") return { ...rule, value: "dead", confidence: CONF_DEAD };

  const dated = contentDate(input.extraction, input.now);
  const from = dated ?? parseDate(input.savedAt, input.now) ?? input.now;
  const ageDays = Math.max(0, (input.now.getTime() - from.getTime()) / DAY_MS);
  return { ...rule, value: bandForAge(ageDays), confidence: dated ? CONF_CONTENT_DATE : CONF_SAVED_AT };
}
