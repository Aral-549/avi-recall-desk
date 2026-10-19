import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCategoriser, type CategoriserDeps, type PipelineLogEvent } from "../src/pipeline.js";
import { createMockProvider, type MockResponder } from "../src/providers/index.js";
import { CategorisedItemSchema, CategoriserError, type Extraction } from "../src/schemas/index.js";
import { hashEmbedder } from "../src/similarity/index.js";
import { SqliteStorage } from "../src/storage/index.js";
import type { OcrRunner } from "../src/extract/index.js";

const USER = "user-1";
const NOW = new Date("2026-10-19T12:00:00.000Z");
const SECRET_AWS = "AKIAIOSFODNN7EXAMPLE";
const SECRET_GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const CANARY = "ZEBRACANARY-content-marker";

const ok = (extra: Partial<Extraction>): Extraction => ({ status: "ok", fetchedAt: NOW.toISOString(), bytes: 1000, ...extra });

const FIXTURES = new Map<string, Extraction>([
  ["https://example.com/chess-openings", ok({ title: "Chess openings guide", text: `A tutorial on chess openings. ${CANARY}` })],
  ["https://example.com/leaky", ok({ title: "Config dump", text: `aws key ${SECRET_AWS} and token ${SECRET_GH} in a tutorial` })],
  ["https://example.com/gone", { status: "not_found", fetchedAt: NOW.toISOString(), bytes: 0 }],
]);

let storage: SqliteStorage;
let logs: PipelineLogEvent[];

function make(extra: Partial<CategoriserDeps> = {}) {
  return createCategoriser({
    storage,
    embedder: hashEmbedder,
    provider: createMockProvider(),
    extract: { mock: true, fixtures: FIXTURES },
    now: () => NOW,
    log: (e) => logs.push(e),
    suggest: { sleep: async () => {}, retryDelaysMs: [0, 0, 0] },
    ...extra,
  });
}

beforeEach(async () => {
  storage = new SqliteStorage();
  await storage.init();
  logs = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await storage.close();
});

describe("save", () => {
  it("persists the item with stage 1 fields and returns before processing", async () => {
    const c = make();
    const r = await c.save({ userId: USER, url: "https://example.com/chess-openings" }, { process: false });
    expect(r).toMatchObject({ type: "link", source: "web", queued: false });
    const view = await c.get(USER, r.itemId);
    expect(view?.status).toBe("pending");
    expect(view?.categorised).toBeNull();
    expect(view?.fields.type).toMatchObject({ value: "link", by: "rule", state: "suggested" });
  });

  it("rejects invalid input without writing anything", async () => {
    const c = make();
    await expect(c.save({ userId: USER })).rejects.toBeInstanceOf(CategoriserError);
    await expect(c.save({ userId: USER, url: "ftp://x.test/a" })).rejects.toThrow(/invalid item: url/);
    expect(await storage.listItemIds(USER)).toEqual([]);
  });

  it("does not echo input values in validation errors", async () => {
    const c = make();
    await expect(c.save({ userId: USER, url: `javascript:${SECRET_AWS}` })).rejects.not.toThrow(SECRET_AWS);
  });

  it("seeds a rule project from currentProject", async () => {
    const c = make();
    const r = await c.save({ userId: USER, text: "note", currentProject: "Thesis" }, { process: false });
    expect((await c.get(USER, r.itemId))?.fields.project).toMatchObject({ value: [{ project: "Thesis", score: 0.9 }], by: "rule" });
  });
});

describe("process", () => {
  it("runs stages 2-6 in the background and produces a schema-valid CategorisedItem", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/chess-openings" });
    await c.idle();
    const view = await c.get(USER, itemId);
    expect(view?.status).toBe("processed");
    expect(CategorisedItemSchema.safeParse(view?.categorised).success).toBe(true);
    expect(view?.categorised?.tags).toMatchObject({ by: "model", model: "mock", state: "suggested" });
    expect(view?.categorised?.tags.value).toEqual(expect.arrayContaining(["chess", "tutorial"]));
    expect(view?.extraction?.status).toBe("ok");
  });

  it("never writes a confirmed value", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/chess-openings", currentProject: "P" });
    await c.idle();
    const fields = (await c.get(USER, itemId))!.fields;
    for (const f of Object.values(fields)) expect(f!.state).toBe("suggested");
  });

  it("still categorises when extraction is unavailable (redline 5)", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, url: "https://unknown.example/page", text: "remember the chess tutorial" });
    await c.idle();
    const view = await c.get(USER, itemId);
    expect(view?.extraction?.status).toBe("unavailable");
    expect(view?.status).toBe("processed");
    expect(view?.categorised).not.toBeNull();
  });

  it("marks not_found pages as dead", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/gone" });
    await c.idle();
    expect((await c.get(USER, itemId))?.fields.staleness).toMatchObject({ value: "dead", by: "rule" });
  });

  it("falls back to rules on invalid model output and stays processed", async () => {
    const provider = createMockProvider({ respond: () => "not json" });
    const c = make({ provider });
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/chess-openings" });
    await c.idle();
    const view = await c.get(USER, itemId);
    expect(provider.calls).toHaveLength(2);
    expect(view?.categorised?.tags.by).toBe("rule");
    expect(view?.categorised?.oneLineSummary.by).toBe("rule");
    expect(logs.find((l) => l.stage === "suggest")).toMatchObject({ status: "invalid_output" });
  });

  it("works with no provider at all", async () => {
    const c = make({ provider: null });
    const { itemId } = await c.save({ userId: USER, text: "a chess tutorial note" });
    await c.idle();
    const view = await c.get(USER, itemId);
    expect(view?.categorised?.tags).toMatchObject({ by: "rule", value: expect.arrayContaining(["chess"]) });
    expect(view?.categorised?.route).toBe("suggest");
  });

  it("puts a bare note in untrusted_content, not in metadata", async () => {
    const provider = createMockProvider();
    const c = make({ provider });
    await c.save({ userId: USER, text: `chess note ${CANARY}` });
    await c.idle();
    const user = provider.calls[0]!.user;
    const content = user.slice(user.indexOf("<untrusted_content>"));
    expect(content).toContain(CANARY);
    expect(user.slice(0, user.indexOf("<untrusted_content>"))).not.toContain(CANARY);
  });
});

describe("safety invariants", () => {
  it("--mock path makes zero network calls (redline 5)", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network forbidden in --mock");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const c = make();
    const ids = await Promise.all([
      c.save({ userId: USER, url: "https://example.com/chess-openings" }),
      c.save({ userId: USER, url: "https://github.com/owner/repo" }),
      c.save({ userId: USER, url: "https://www.youtube.com/watch?v=abc123" }),
      c.save({ userId: USER, url: "https://not-in-fixtures.example/x" }),
      c.save({ userId: USER, text: "just a note" }),
    ]);
    await c.idle();
    const health = await c.health();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const { itemId } of ids) expect((await c.get(USER, itemId))?.status).toBe("processed");
    expect(health.sidecar.state).toBe("mock");
    expect(logs.some((l) => l.stage === "pipeline")).toBe(false);
  });

  it("redacts secrets before they reach the provider, the embedder or the logs", async () => {
    const provider = createMockProvider();
    const embedded: string[] = [];
    const embedder = { model: hashEmbedder.model, embed: (t: string) => (embedded.push(t), hashEmbedder.embed(t)) };
    const c = make({ provider, embedder });
    await c.save({ userId: USER, url: "https://example.com/leaky", text: `my note ${SECRET_GH}` });
    await c.idle();
    const sent = provider.calls.map((r) => r.system + r.user).join("\n");
    for (const s of [SECRET_AWS, SECRET_GH]) {
      expect(sent).not.toContain(s);
      expect(embedded.join("\n")).not.toContain(s);
      expect(JSON.stringify(logs)).not.toContain(s);
    }
    const r = logs.find((l) => l.stage === "redact");
    expect(r && "counts" in r && r.counts.apiKey + r.counts.token).toBeGreaterThan(0);
  });

  it("never logs page content", async () => {
    const c = make();
    await c.save({ userId: USER, url: "https://example.com/chess-openings" });
    await c.idle();
    expect(JSON.stringify(logs)).not.toContain(CANARY);
  });

  it("localOnly makes no provider call", async () => {
    const provider = createMockProvider();
    const c = make({ provider });
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/chess-openings", localOnly: true });
    await c.idle();
    expect(provider.calls).toHaveLength(0);
    const view = await c.get(USER, itemId);
    expect(view?.extraction?.status).toBe("skipped");
    expect(view?.categorised?.tags.by).toBe("rule");
    expect(logs.find((l) => l.stage === "suggest")).toMatchObject({ status: "skipped_local_only", calls: 0 });
  });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

  it("withholds the image from vision when its OCR text contained secrets", async () => {
    const provider = createMockProvider();
    const ocr: OcrRunner = async () => ({ text: `screenshot of config ${SECRET_AWS}`, confidence: 90 });
    const c = make({ provider, extract: { mock: true, ocr } });
    await c.save({ userId: USER, file: { mime: "image/png", bytes: png }, visionOptIn: true });
    await c.idle();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.image).toBeUndefined();
    expect(provider.calls[0]!.user).not.toContain(SECRET_AWS);
    expect(logs.find((l) => l.stage === "suggest")).toMatchObject({ visionWithheld: true, vision: false });
  });

  it("sends the image when vision is opted in and nothing was redacted", async () => {
    const provider = createMockProvider();
    const ocr: OcrRunner = async () => ({ text: "a chess board diagram", confidence: 90 });
    const c = make({ provider, extract: { mock: true, ocr } });
    await c.save({ userId: USER, file: { mime: "image/png", bytes: png }, visionOptIn: true });
    await c.idle();
    expect(provider.calls[0]!.image?.mime).toBe("image/png");
  });

  it("never sends the image without vision opt-in", async () => {
    const provider = createMockProvider();
    const ocr: OcrRunner = async () => ({ text: "a chess board diagram", confidence: 90 });
    const c = make({ provider, extract: { mock: true, ocr } });
    await c.save({ userId: USER, file: { mime: "image/png", bytes: png } });
    await c.idle();
    expect(provider.calls[0]!.image).toBeUndefined();
  });

  it("keeps user-set fields on re-run", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, url: "https://example.com/chess-openings" });
    await c.idle();
    const confirmed = { value: ["article"], state: "confirmed" as const, by: "user" as const, at: NOW.toISOString() };
    await storage.writeField(USER, itemId, "tags", confirmed);
    const r = await c.process(USER, itemId);
    expect(r.keptUserFields).toEqual(["tags"]);
    expect((await c.get(USER, itemId))?.fields.tags).toMatchObject(confirmed);
  });

  it("isolates users", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, text: "private note" });
    await c.idle();
    expect(await c.get("someone-else", itemId)).toBeNull();
    await expect(c.process("someone-else", itemId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("projects and tag proposals", () => {
  async function seedConfirmed(c: ReturnType<typeof make>, project: string, texts: string[]) {
    for (const text of texts) {
      const { itemId } = await c.save({ userId: USER, text }, { process: false });
      await c.process(USER, itemId);
      await storage.writeField(USER, itemId, "project", {
        value: [{ project, score: 1 }],
        state: "confirmed",
        by: "user",
        at: NOW.toISOString(),
      });
    }
  }

  it("ranks by similarity and lets a model pick re-order within candidates", async () => {
    const c = make();
    await seedConfirmed(c, "Chess club", ["chess openings sicilian defence", "chess endgame tactics practice"]);
    await seedConfirmed(c, "Garden", ["tomato seedlings watering schedule", "compost bin layering"]);
    const { itemId } = await c.save({ userId: USER, text: "chess tactics openings practice" }, { process: false });
    await c.process(USER, itemId);
    const project = (await c.get(USER, itemId))!.fields.project!;
    const ranking = project.value as Array<{ project: string; score: number }>;
    expect(ranking[0]!.project).toBe("Chess club");
    expect(project).toMatchObject({ by: "model", model: "mock", modelVersion: "mock-v1" });
    expect(project.confidence).toBe(ranking[0]!.score);
  });

  it("drops a model project pick that is not a candidate and keeps the embedding ranking", async () => {
    const respond: MockResponder = () =>
      JSON.stringify({
        tags: [],
        tagProposals: [],
        oneLineSummary: "A summary that is long enough",
        draftWhySaved: "A draft that is long enough",
        project: "Invented project",
        confidence: { tags: 0.9, summary: 0.9, project: 0.99 },
      });
    const c = make({ provider: createMockProvider({ respond }) });
    await seedConfirmed(c, "Chess club", ["chess openings sicilian defence"]);
    const { itemId } = await c.save({ userId: USER, text: "chess openings" }, { process: false });
    await c.process(USER, itemId);
    const project = (await c.get(USER, itemId))!.fields.project!;
    expect(project.by).toBe("embedding");
    expect(JSON.stringify(project.value)).not.toContain("Invented project");
  });

  it("stores model tag proposals once as pending", async () => {
    const respond: MockResponder = () =>
      JSON.stringify({
        tags: ["chess"],
        tagProposals: [{ tag: "speedrun", reason: "missing tag" }],
        oneLineSummary: "A summary that is long enough",
        draftWhySaved: "A draft that is long enough",
        confidence: { tags: 0.9, summary: 0.9 },
      });
    const c = make({ provider: createMockProvider({ respond }) });
    const { itemId } = await c.save({ userId: USER, text: "chess speedrun" }, { process: false });
    await c.process(USER, itemId);
    await c.process(USER, itemId);
    const view = await c.get(USER, itemId);
    expect(view?.categorised?.tagProposals).toHaveLength(1);
    expect(view?.categorised?.tagProposals[0]).toMatchObject({ tag: "speedrun", state: "pending", by: "model", model: "mock" });
  });

  it("routes to suggest only when every gated field clears its threshold", async () => {
    const respond: MockResponder = () =>
      JSON.stringify({
        tags: ["chess"],
        tagProposals: [],
        oneLineSummary: "A summary that is long enough",
        draftWhySaved: "A draft that is long enough",
        confidence: { tags: 0.95, summary: 0.6 },
      });
    const c = make({ provider: createMockProvider({ respond }) });
    const { itemId } = await c.save({ userId: USER, text: "chess" }, { process: false });
    expect(await c.process(USER, itemId)).toMatchObject({ route: "review", review: ["oneLineSummary", "draftWhySaved"] });

    const lenient = make({ provider: createMockProvider({ respond }), thresholds: { oneLineSummary: 0.5, draftWhySaved: 0.5 } });
    expect(await lenient.process(USER, itemId)).toMatchObject({ route: "suggest", review: [] });
  });

  it("rejects bad thresholds at construction", () => {
    expect(() => make({ thresholds: { tags: 2 } })).toThrow(/invalid threshold/);
  });
});

describe("queue", () => {
  it("runs at most `concurrency` items at once", async () => {
    let active = 0;
    let peak = 0;
    const respond: MockResponder = async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return (await import("../src/providers/index.js")).defaultMockReply(req);
    };
    const c = make({ provider: createMockProvider({ respond }) });
    for (let i = 0; i < 6; i++) await c.save({ userId: USER, text: `note number ${i}` });
    await c.idle();
    expect(peak).toBe(2);
  });

  it("dedupes an item that is already queued", async () => {
    const provider = createMockProvider();
    const c = make({ provider });
    const { itemId } = await c.save({ userId: USER, text: "note" }, { process: false });
    const a = c.enqueue(USER, itemId);
    const b = c.enqueue(USER, itemId);
    expect(a).toBe(b);
    await c.idle();
    expect(provider.calls).toHaveLength(1);
  });

  it("logs a pipeline failure by code, leaves the item pending, and keeps the queue alive", async () => {
    const c = make();
    const { itemId } = await c.save({ userId: USER, text: "note" }, { process: false });
    const spy = vi.spyOn(storage, "getTaxonomy").mockRejectedValueOnce(new CategoriserError("db_down", "storage", `boom ${CANARY}`));
    expect(await c.enqueue(USER, itemId)).toBeNull();
    expect(logs.find((l) => l.stage === "pipeline")).toEqual({ stage: "pipeline", itemId, status: "error", code: "db_down" });
    expect(JSON.stringify(logs)).not.toContain(CANARY);
    expect((await c.get(USER, itemId))?.status).toBe("pending");
    spy.mockRestore();
    expect(await c.enqueue(USER, itemId)).toMatchObject({ itemId });
  });
});

describe("health", () => {
  it("reports storage, provider, mock sidecar and queue", async () => {
    const h = await make().health();
    expect(h).toMatchObject({
      ok: true,
      storage: { ok: true },
      provider: { id: "mock", state: "ready", cloud: true },
      sidecar: { state: "mock" },
      queue: { size: 0, pending: 0 },
    });
  });

  it("reports no provider and an unreachable sidecar without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const h = await make({ provider: null, extract: { fetchImpl: fetchImpl as unknown as typeof fetch } }).health();
    expect(h.provider).toMatchObject({ state: "none" });
    expect(h.sidecar.state).toBe("unavailable");
  });
});
