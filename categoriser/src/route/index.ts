import { CategoriserError, FieldNameSchema, type FieldName, type Route } from "../schemas/index.js";
import type { AnyField } from "../storage/types.js";

export * from "./staleness.js";

/** Initial default only; calibrated per-field values come from `eval --calibrate` (redline 2). */
export const DEFAULT_THRESHOLD = 0.8;

export type Thresholds = Partial<Record<FieldName, number>>;

export type RouteDecision = {
  route: Route;
  /** Fields that sent the item to review, in schema order. Empty when `route` is "suggest". */
  review: FieldName[];
};

/** Only model and embedding output is gated; rule and user fields never decide the band. */
const GATED_BY = new Set<AnyField["by"]>(["model", "embedding"]);

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function validateThresholds(t: Thresholds): Thresholds {
  for (const [name, value] of Object.entries(t)) {
    if (!FieldNameSchema.safeParse(name).success || typeof value !== "number" || !(value >= 0 && value <= 1)) {
      throw new CategoriserError("config", "route", `invalid threshold for ${name}`);
    }
  }
  return t;
}

/**
 * Stage 6. Pure and total. `suggest` only when every gated field that has a value meets its
 * threshold; otherwise `review`. There is no drop band and nothing auto-confirms.
 * A missing confidence on a gated field counts as 0 (fail towards review).
 */
export function route(fields: Partial<Record<FieldName, AnyField>>, thresholds: Thresholds = {}): RouteDecision {
  validateThresholds(thresholds);
  const review: FieldName[] = [];
  for (const name of FieldNameSchema.options) {
    const f = fields[name];
    if (!f || !GATED_BY.has(f.by) || !hasValue(f.value)) continue;
    const min = thresholds[name] ?? DEFAULT_THRESHOLD;
    if ((f.confidence ?? 0) < min) review.push(name);
  }
  return { route: review.length ? "review" : "suggest", review };
}
