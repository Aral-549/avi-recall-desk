import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Field, ProjectScore, RawItem } from "../src/schemas/index.js";
import { SqliteStorage } from "../src/storage/index.js";
import {
  HASH_MODEL,
  MINILM_MODEL,
  createMiniLmEmbedder,
  hashEmbedder,
  similarity,
  type Embedder,
} from "../src/similarity/index.js";

const ALICE = "user-alice";
const BOB = "user-bob";

const GARDEN = [
  "tomato seedlings need compost, sunlight and regular watering in the vegetable garden",
  "raised garden beds with compost help tomato and pepper plants grow",
  "watering schedule for vegetable garden seedlings during summer",
];
const TAX = [
  "quarterly tax filing deadline for freelancers and estimated payments",
  "deductible business expenses on your annual tax return",
];

let db: SqliteStorage;
beforeEach(async () => {
  db = new SqliteStorage();
  await db.init();
});
afterEach(async () => {
  await db.close();
});

async function addItem(userId = ALICE): Promise<string> {
  const item: RawItem = { id: randomUUID(), userId, url: "https://example.com/a", localOnly: false, visionOptIn: false, savedAt: "2026-10-19T10:00:00.000Z" };
  await db.saveItem(item);
  return item.id;
}

const confirmedProject = (...names: string[]): Field<ProjectScore[]> => ({
  value: names.map((project) => ({ project, score: 1 })),
  state: "confirmed",
  by: "user",
  at: "2026-10-19T11:00:00.000Z",
});

async function seed(userId: string, project: string, texts: string[], embedder: Embedder = hashEmbedder): Promise<string[]> {
  const ids: string[] = [];
  for (const text of texts) {
    const id = await addItem(userId);
    await similarity({ userId, itemId: id, text }, { storage: db, embedder });
    await db.writeField(userId, id, "project", confirmedProject(project));
    ids.push(id);
  }
  return ids;
}

describe("hash-v1 embedder", () => {
  it("is deterministic, unit-length and ranks related text above unrelated text", async () => {
    const a = await hashEmbedder.embed(GARDEN[0]);
    expect(await hashEmbedder.embed(GARDEN[0])).toEqual(a);
    expect(a.model).toBe(HASH_MODEL);
    expect(Math.hypot(...a.vector)).toBeCloseTo(1, 6);

    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    const related = (await hashEmbedder.embed(GARDEN[1])).vector;
    const unrelated = (await hashEmbedder.embed(TAX[0])).vector;
    expect(dot(a.vector, related)).toBeGreaterThan(dot(a.vector, unrelated));
  });

  it("returns a zero vector for text with no tokens instead of NaN", async () => {
    const { vector } = await hashEmbedder.embed("!!! ... ???");
    expect(vector.every((x) => x === 0)).toBe(true);
  });
});

describe("similarity", () => {
  it("ranks projects by centroid of user-confirmed items and stores the embedding", async () => {
    await seed(ALICE, "Garden", GARDEN);
    await seed(ALICE, "Taxes", TAX);
    const id = await addItem();
    const r = await similarity({ userId: ALICE, itemId: id, text: "compost and watering tips for tomato seedlings" }, { storage: db, embedder: hashEmbedder });

    expect(r.embeddingModel).toBe(HASH_MODEL);
    expect(r.projects[0].project).toBe("Garden");
    expect(r.projects[0].score).toBeGreaterThan(r.projects[1]?.score ?? 0);
    expect(r.similarItems.length).toBeGreaterThan(0);
    expect(r.similarItems.length).toBeLessThanOrEqual(5);
    expect(r.similarItems.map((s) => s.itemId)).not.toContain(id);
    expect((await db.listEmbeddings(ALICE, HASH_MODEL)).map((e) => e.itemId)).toContain(id);
  });

  it("ignores suggested (unconfirmed) project fields", async () => {
    const [g] = await seed(ALICE, "Garden", GARDEN.slice(0, 1));
    const other = await addItem();
    await similarity({ userId: ALICE, itemId: other, text: GARDEN[1] }, { storage: db, embedder: hashEmbedder });
    await db.writeField(ALICE, other, "project", {
      value: [{ project: "Suggested Only", score: 0.9 }], state: "suggested", by: "embedding", confidence: 0.9, at: "2026-10-19T11:00:00.000Z",
    });

    const id = await addItem();
    const r = await similarity({ userId: ALICE, itemId: id, text: GARDEN[2] }, { storage: db, embedder: hashEmbedder });
    expect(r.projects.map((p) => p.project)).toEqual(["Garden"]);
    expect(r.similarItems.map((s) => s.itemId).sort()).toEqual([g, other].sort());
  });

  it("does not let an item vote for its own project when re-run after confirmation", async () => {
    const [only] = await seed(ALICE, "Garden", GARDEN.slice(0, 1));
    const r = await similarity({ userId: ALICE, itemId: only, text: GARDEN[0] }, { storage: db, embedder: hashEmbedder });
    expect(r.projects).toEqual([]);
    expect(r.similarItems).toEqual([]);
  });

  it("caps projects at 3 and items at 5, sorted descending", async () => {
    for (const [i, p] of ["A", "B", "C", "D"].entries()) await seed(ALICE, p, [`${GARDEN[i % 3]} ${p}`, TAX[i % 2]]);
    const id = await addItem();
    const r = await similarity({ userId: ALICE, itemId: id, text: GARDEN[0] }, { storage: db, embedder: hashEmbedder });
    expect(r.projects).toHaveLength(3);
    expect(r.similarItems).toHaveLength(5);
    const sorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
    expect(sorted(r.projects.map((p) => p.score))).toBe(true);
    expect(sorted(r.similarItems.map((s) => s.score))).toBe(true);
  });

  it("never sees another user's items or projects", async () => {
    await seed(BOB, "Bob Garden", GARDEN);
    const id = await addItem(ALICE);
    const r = await similarity({ userId: ALICE, itemId: id, text: GARDEN[0] }, { storage: db, embedder: hashEmbedder });
    expect(r).toEqual({ projects: [], similarItems: [], embeddingModel: HASH_MODEL });
  });

  it("only compares vectors from the same embedding model", async () => {
    const fake: Embedder = { model: "fake-v1", embed: async () => ({ model: "fake-v1", vector: [1, 0, 0] }) };
    await seed(ALICE, "Fake Project", ["anything"], fake);
    const id = await addItem();
    const r = await similarity({ userId: ALICE, itemId: id, text: GARDEN[0] }, { storage: db, embedder: hashEmbedder });
    expect(r.projects).toEqual([]);
    expect(r.similarItems).toEqual([]);
  });

  it("returns an empty result for blank text without storing anything", async () => {
    const id = await addItem();
    const r = await similarity({ userId: ALICE, itemId: id, text: "   " }, { storage: db, embedder: hashEmbedder });
    expect(r).toEqual({ projects: [], similarItems: [], embeddingModel: HASH_MODEL });
    expect(await db.listEmbeddings(ALICE, HASH_MODEL)).toEqual([]);
  });

  it("rejects an itemId that belongs to another user", async () => {
    const bobs = await addItem(BOB);
    await expect(similarity({ userId: ALICE, itemId: bobs, text: GARDEN[0] }, { storage: db, embedder: hashEmbedder })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("MiniLM embedder", () => {
  it("falls back to hash-v1 when the model is not cached and downloads are disabled", async () => {
    const embedder = createMiniLmEmbedder({ allowDownload: false, cacheDir: mkdtempSync(join(tmpdir(), "no-model-")) });
    expect(embedder.model).toBe(MINILM_MODEL);
    const e = await embedder.embed(GARDEN[0]);
    expect(e).toEqual(await hashEmbedder.embed(GARDEN[0]));
  }, 30_000);

  const cache = process.env.CATEGORISER_MODEL_CACHE;
  it.skipIf(!cache || !existsSync(join(cache, "Xenova", "all-MiniLM-L6-v2")))(
    "produces 384-dim unit vectors from a local cache (set CATEGORISER_MODEL_CACHE to run)",
    async () => {
      const embedder = createMiniLmEmbedder({ allowDownload: false, cacheDir: cache });
      const e = await embedder.embed(GARDEN[0]);
      expect(e.model).toBe(MINILM_MODEL);
      expect(e.vector).toHaveLength(384);
      expect(Math.hypot(...e.vector)).toBeCloseTo(1, 4);
    },
    60_000,
  );
});
