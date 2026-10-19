import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CategoriserError, type Field, type RawItem, type StoredTagProposal } from "../src/schemas/index.js";
import { SqliteStorage } from "../src/storage/index.js";
import { TaxonomyIndex } from "../src/taxonomy/index.js";

const ALICE = "user-alice";
const BOB = "user-bob";

function item(userId = ALICE, extra: Partial<RawItem> = {}): RawItem {
  return {
    id: randomUUID(),
    userId,
    url: "https://github.com/vercel/next.js",
    localOnly: false,
    visionOptIn: false,
    savedAt: "2026-10-19T10:00:00.000Z",
    ...extra,
  };
}

const modelTags = (at = "2026-10-19T12:00:00.000Z", modelVersion = "claude-haiku"): Field<string[]> => ({
  value: ["web-dev"], state: "suggested", by: "model", model: "bedrock", modelVersion, confidence: 0.9, at,
});
const userTags = (value: string[]): Field<string[]> => ({ value, state: "confirmed", by: "user", at: "2026-10-19T13:00:00.000Z" });

let db: SqliteStorage;
beforeEach(async () => {
  db = new SqliteStorage();
  await db.init();
});
afterEach(async () => {
  await db.close();
});

describe("storage: items", () => {
  it("saves and reads back a raw item, and reports health", async () => {
    const it1 = item();
    await db.saveItem(it1);
    expect(await db.getItem(ALICE, it1.id)).toEqual(it1);
    expect(await db.health()).toEqual({ ok: true, kind: "sqlite" });
  });

  it("rejects invalid and duplicate items", async () => {
    await expect(db.saveItem({ ...item(), url: "ftp://x" } as RawItem)).rejects.toThrow();
    const it1 = item();
    await db.saveItem(it1);
    await expect(db.saveItem(it1)).rejects.toMatchObject({ code: "duplicate" });
  });

  it("scopes every read by userId", async () => {
    const it1 = item(ALICE);
    await db.saveItem(it1);
    expect(await db.getItem(BOB, it1.id)).toBeNull();
    expect(await db.listItemIds(BOB)).toEqual([]);
    expect(await db.listItemIds(ALICE)).toEqual([it1.id]);
  });

  it("stores route meta only for the owner", async () => {
    const it1 = item();
    await db.saveItem(it1);
    await db.setItemMeta(ALICE, it1.id, { route: "review", pipelineVersion: "1.1.0" });
    expect(await db.getItem(ALICE, it1.id)).toMatchObject({ route: "review", pipelineVersion: "1.1.0" });
    await expect(db.setItemMeta(BOB, it1.id, { route: "suggest", pipelineVersion: "1.1.0" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("storage: extractions", () => {
  it("upserts and validates", async () => {
    const it1 = item();
    await db.saveItem(it1);
    await db.saveExtraction(ALICE, it1.id, { status: "unavailable", fetchedAt: "2026-10-19T10:00:01.000Z", bytes: 0 });
    await db.saveExtraction(ALICE, it1.id, { status: "ok", title: "Next.js", fetchedAt: "2026-10-19T10:00:02.000Z", bytes: 1200 });
    expect(await db.getExtraction(ALICE, it1.id)).toMatchObject({ status: "ok", title: "Next.js" });
    expect(await db.getExtraction(BOB, it1.id)).toBeNull();
    await expect(db.saveExtraction(BOB, it1.id, { status: "ok", fetchedAt: "2026-10-19T10:00:02.000Z", bytes: 1 })).rejects.toMatchObject({ code: "not_found" });
    await expect(db.saveExtraction(ALICE, it1.id, { status: "nope", fetchedAt: "x", bytes: -1 } as never)).rejects.toThrow();
  });
});

describe("storage: fields and provenance", () => {
  it("keeps every version, exposes only the current one, and audits each change", async () => {
    const it1 = item();
    await db.saveItem(it1);
    await db.writeField(ALICE, it1.id, "tags", modelTags());
    await db.writeField(ALICE, it1.id, "tags", userTags(["web-dev", "open-source"]));
    expect((await db.getFields(ALICE, it1.id)).tags).toMatchObject({ value: ["web-dev", "open-source"], by: "user" });
    const versions = await db.getFieldVersions(ALICE, it1.id, "tags");
    expect(versions.map((v) => [v.by, v.current])).toEqual([["model", false], ["user", true]]);
  });

  it("forbids anything but the user from confirming (invariant 1)", async () => {
    const it1 = item();
    await db.saveItem(it1);
    for (const by of ["model", "rule", "embedding"] as const) {
      const f = { ...modelTags(), by, state: "confirmed" as const };
      await expect(db.writeField(ALICE, it1.id, "tags", f)).rejects.toMatchObject({ code: "confirm_forbidden" });
    }
    expect(await db.getFields(ALICE, it1.id)).toEqual({});
  });

  it("requires confidence for non-user fields and model id for model fields", async () => {
    const it1 = item();
    await db.saveItem(it1);
    const { confidence: _c, ...noConf } = modelTags();
    await expect(db.writeField(ALICE, it1.id, "tags", noConf)).rejects.toMatchObject({ code: "invalid_field" });
    const { model: _m, ...noModel } = modelTags();
    await expect(db.writeField(ALICE, it1.id, "tags", noModel)).rejects.toMatchObject({ code: "invalid_field" });
    await expect(db.writeField(ALICE, it1.id, "bogus" as never, modelTags())).rejects.toThrow();
  });

  it("refuses to write fields onto another user's item", async () => {
    const it1 = item(ALICE);
    await db.saveItem(it1);
    await expect(db.writeField(BOB, it1.id, "tags", modelTags())).rejects.toBeInstanceOf(CategoriserError);
    expect(await db.getFields(BOB, it1.id)).toEqual({});
  });

  it("filters current fields by model, version, state and date", async () => {
    const a = item();
    const b = item();
    await db.saveItem(a);
    await db.saveItem(b);
    await db.writeField(ALICE, a.id, "tags", modelTags("2026-10-19T12:00:00.000Z", "v1"));
    await db.writeField(ALICE, b.id, "tags", modelTags("2026-10-18T12:00:00.000Z", "v2"));
    await db.writeField(ALICE, b.id, "oneLineSummary", { value: "A framework", state: "confirmed", by: "user", at: "2026-10-19T12:00:00.000Z" });

    const after = await db.listCurrentFields(ALICE, { model: "bedrock", after: "2026-10-19T00:00:00+00:00" });
    expect(after.map((r) => r.itemId)).toEqual([a.id]);
    expect(await db.listCurrentFields(ALICE, { modelVersion: "v2" })).toHaveLength(1);
    expect(await db.listCurrentFields(ALICE, { state: "confirmed" })).toHaveLength(1);
    expect(await db.listCurrentFields(ALICE, { names: [] })).toEqual([]);
    expect(await db.listCurrentFields(BOB)).toEqual([]);
    await expect(db.listCurrentFields(ALICE, { after: "not-a-date" })).rejects.toMatchObject({ code: "invalid_filter" });
  });

  it("compares dates across timezone offsets correctly", async () => {
    const a = item();
    await db.saveItem(a);
    await db.writeField(ALICE, a.id, "tags", modelTags("2026-10-19T08:00:00+05:30"));
    expect(await db.listCurrentFields(ALICE, { after: "2026-10-19T03:00:00Z" })).toHaveLength(0);
    expect(await db.listCurrentFields(ALICE, { after: "2026-10-19T02:00:00Z" })).toHaveLength(1);
  });

  it("applies grouped changes atomically and records them under one opId", async () => {
    const a = item();
    const b = item();
    await db.saveItem(a);
    await db.saveItem(b);
    await db.writeField(ALICE, a.id, "tags", modelTags());
    const opId = randomUUID();
    await db.applyFieldChanges(ALICE, [{ itemId: a.id, name: "tags", field: null }, { itemId: b.id, name: "tags", field: modelTags() }], { opId });
    const history = await db.getHistoryByOp(ALICE, opId);
    expect(history.map((h) => [h.itemId, h.from === null, h.to === null])).toEqual([[a.id, false, true], [b.id, true, false]]);
    expect(await db.getHistoryByOp(BOB, opId)).toEqual([]);
  });

  it("rolls back the whole batch if any change is invalid", async () => {
    const a = item();
    await db.saveItem(a);
    const opId = randomUUID();
    const bad = { ...modelTags(), state: "confirmed" as const };
    await expect(
      db.applyFieldChanges(ALICE, [{ itemId: a.id, name: "tags", field: modelTags() }, { itemId: a.id, name: "source", field: bad }], { opId }),
    ).rejects.toMatchObject({ code: "confirm_forbidden" });
    expect(await db.getFields(ALICE, a.id)).toEqual({});
    expect(await db.getHistoryByOp(ALICE, opId)).toEqual([]);
  });

  it("clearField is a no-op on an empty field", async () => {
    const a = item();
    await db.saveItem(a);
    const opId = randomUUID();
    await db.clearField(ALICE, a.id, "tags", { opId });
    expect(await db.getHistoryByOp(ALICE, opId)).toEqual([]);
  });
});

describe("storage: taxonomy", () => {
  it("seeds per user on first read and only accepts newer versions", async () => {
    const t = await db.getTaxonomy(ALICE);
    expect(t.version).toBe(1);
    const next = new TaxonomyIndex(t).approveProposal("rust", "Rust language");
    await db.putTaxonomy(ALICE, next);
    expect((await db.getTaxonomy(ALICE)).version).toBe(2);
    expect((await db.getTaxonomy(BOB)).version).toBe(1);
    await expect(db.putTaxonomy(ALICE, next)).rejects.toMatchObject({ code: "stale_taxonomy" });
  });
});

describe("storage: tag proposals", () => {
  it("adds, lists and decides once", async () => {
    const a = item();
    await db.saveItem(a);
    const p: StoredTagProposal = {
      id: randomUUID(), itemId: a.id, tag: "rust", reason: "Rust crate", state: "pending",
      by: "model", model: "bedrock", at: "2026-10-19T12:00:00.000Z",
    };
    await db.addTagProposal(ALICE, p);
    expect(await db.listTagProposals(ALICE, { state: "pending" })).toHaveLength(1);
    expect(await db.listTagProposals(BOB)).toEqual([]);
    await db.setTagProposalState(ALICE, p.id, "approved");
    expect((await db.getTagProposal(ALICE, p.id))?.state).toBe("approved");
    await expect(db.setTagProposalState(ALICE, p.id, "rejected")).rejects.toMatchObject({ code: "invalid_state" });
    await expect(db.setTagProposalState(BOB, p.id, "rejected")).rejects.toMatchObject({ code: "not_found" });
    await expect(db.addTagProposal(ALICE, { ...p, id: randomUUID(), tag: "Bad Tag" })).rejects.toThrow();
  });
});

describe("storage: embeddings", () => {
  it("upserts per model and rejects non-finite vectors", async () => {
    const a = item();
    await db.saveItem(a);
    await db.putEmbedding(ALICE, a.id, "hash-v1", [0.1, 0.2]);
    await db.putEmbedding(ALICE, a.id, "hash-v1", [0.3, 0.4]);
    expect(await db.listEmbeddings(ALICE, "hash-v1")).toEqual([{ itemId: a.id, model: "hash-v1", vector: [0.3, 0.4] }]);
    expect(await db.listEmbeddings(BOB, "hash-v1")).toEqual([]);
    await expect(db.putEmbedding(ALICE, a.id, "hash-v1", [Number.NaN])).rejects.toMatchObject({ code: "invalid_embedding" });
    await expect(db.putEmbedding(ALICE, a.id, "hash-v1", [])).rejects.toMatchObject({ code: "invalid_embedding" });
  });
});
