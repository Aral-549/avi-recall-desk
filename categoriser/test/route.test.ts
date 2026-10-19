import { describe, expect, it } from "vitest";
import { CategoriserError } from "../src/schemas/index.js";
import { DEFAULT_THRESHOLD, route, staleness } from "../src/route/index.js";
import type { AnyField } from "../src/storage/types.js";

const at = "2026-10-19T00:00:00.000Z";
const f = (by: AnyField["by"], value: unknown, confidence?: number): AnyField => ({
  value,
  state: "suggested",
  by,
  at,
  ...(confidence === undefined ? {} : { confidence }),
  ...(by === "model" ? { model: "mock" } : {}),
});

describe("route", () => {
  it("defaults to 0.80 and suggests with no gated fields", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.8);
    expect(route({})).toEqual({ route: "suggest", review: [] });
  });

  it("ignores rule and user fields regardless of confidence", () => {
    const r = route({
      type: f("rule", "link", 0.1),
      draftWhySaved: f("rule", "Saved from web", 0.3),
      tags: { value: ["chess"], state: "confirmed", by: "user", at },
      staleness: f("rule", "fresh", 0.4),
    });
    expect(r).toEqual({ route: "suggest", review: [] });
  });

  it("sends a low-confidence model field to review and lists it", () => {
    const r = route({ tags: f("model", ["chess"], 0.79), oneLineSummary: f("model", "A summary here", 0.95) });
    expect(r).toEqual({ route: "review", review: ["tags"] });
  });

  it("treats the threshold as inclusive", () => {
    expect(route({ tags: f("model", ["chess"], 0.8) }).route).toBe("suggest");
  });

  it("gates embedding project rankings on the top-1 score carried as confidence", () => {
    expect(route({ project: f("embedding", [{ project: "a", score: 0.6 }], 0.6) }).review).toEqual(["project"]);
    expect(route({ project: f("embedding", [{ project: "a", score: 0.9 }], 0.9) }).route).toBe("suggest");
  });

  it("ignores gated fields with no value (empty ranking, blank string, empty tags)", () => {
    const r = route({
      project: f("embedding", [], 0),
      oneLineSummary: f("model", "   ", 0.1),
      tags: f("model", [], 0.1),
    });
    expect(r.route).toBe("suggest");
  });

  it("fails towards review when a gated field has no confidence", () => {
    expect(route({ tags: f("model", ["chess"]) }).review).toEqual(["tags"]);
  });

  it("uses per-field calibrated thresholds", () => {
    const fields = { tags: f("model", ["chess"], 0.6), oneLineSummary: f("model", "Summary text", 0.6) };
    expect(route(fields, { tags: 0.5 }).review).toEqual(["oneLineSummary"]);
    expect(route(fields, { tags: 0.5, oneLineSummary: 0.5 }).route).toBe("suggest");
  });

  it("rejects invalid thresholds with a config error", () => {
    expect(() => route({}, { tags: 1.5 })).toThrow(CategoriserError);
    expect(() => route({}, { tags: Number.NaN })).toThrow(/invalid threshold/);
    expect(() => route({}, { bogus: 0.5 } as never)).toThrow(/invalid threshold/);
  });

  it("returns review fields in schema order", () => {
    const r = route({
      draftWhySaved: f("model", "Why", 0.1),
      project: f("embedding", [{ project: "a", score: 0.1 }], 0.1),
      tags: f("model", ["x"], 0.1),
    });
    expect(r.review).toEqual(["project", "tags", "draftWhySaved"]);
  });
});

describe("staleness", () => {
  const now = new Date("2026-10-19T00:00:00.000Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const ex = (extra: object) => ({ status: "ok" as const, fetchedAt: at, bytes: 10, ...extra });

  it("marks not_found as dead", () => {
    const s = staleness({ extraction: ex({ status: "not_found" }), savedAt: daysAgo(1), now }, at);
    expect(s).toMatchObject({ value: "dead", by: "rule", state: "suggested", confidence: 0.9 });
  });

  it("does not treat blocked/timeout/error as dead", () => {
    for (const status of ["blocked", "timeout", "error", "unavailable"] as const) {
      expect(staleness({ extraction: ex({ status }), savedAt: daysAgo(1), now }, at).value).toBe("fresh");
    }
  });

  it("bands on the content date", () => {
    expect(staleness({ extraction: ex({ publishedAt: daysAgo(30) }), savedAt: at, now }, at)).toMatchObject({ value: "fresh", confidence: 0.7 });
    expect(staleness({ extraction: ex({ publishedAt: daysAgo(200) }), savedAt: at, now }, at).value).toBe("aging");
    expect(staleness({ extraction: ex({ publishedAt: daysAgo(800) }), savedAt: at, now }, at).value).toBe("stale");
  });

  it("uses GitHub pushedAt when there is no publish date", () => {
    expect(staleness({ extraction: ex({ meta: { pushedAt: daysAgo(1000) } }), savedAt: at, now }, at).value).toBe("stale");
  });

  it("ignores far-future and malformed content dates and falls back to savedAt", () => {
    const future = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    expect(staleness({ extraction: ex({ publishedAt: future }), savedAt: daysAgo(400), now }, at)).toMatchObject({ value: "aging", confidence: 0.4 });
    expect(staleness({ extraction: ex({ meta: { pushedAt: "not a date" } }), savedAt: daysAgo(1), now }, at)).toMatchObject({ value: "fresh", confidence: 0.4 });
  });

  it("works with no extraction at all", () => {
    expect(staleness({ extraction: null, savedAt: daysAgo(900), now }, at)).toMatchObject({ value: "stale", confidence: 0.4 });
  });
});
