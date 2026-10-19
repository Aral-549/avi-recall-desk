import { SimilarityResultSchema, type ProjectScore, type SimilarityResult } from "../schemas/index.js";
import type { StorageAdapter } from "../storage/types.js";
import { l2normalize, type Embedder } from "./embedders.js";

export * from "./embedders.js";

const TOP_PROJECTS = 3;
const TOP_ITEMS = 5;

export type SimilarityInput = {
  userId: string;
  itemId: string;
  /** Redacted text only. Never pass raw extraction text here. */
  text: string;
};

export type SimilarityDeps = {
  storage: StorageAdapter;
  embedder: Embedder;
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Cosine of unit vectors, clamped to [0,1] and rounded so results are stable across runs. */
function score(a: number[], b: number[]): number {
  const s = Math.min(1, Math.max(0, cosine(a, b)));
  return Math.round(s * 10_000) / 10_000;
}

function centroid(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0]!.length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i]! += v[i]!;
  return l2normalize(sum);
}

/**
 * Embeds the item, stores the vector, then ranks:
 * - projects by similarity to the centroid of items whose `project` field is user-confirmed;
 * - the user's other items by direct similarity.
 * Only vectors from the same embedding model and dimension are compared. Everything is scoped to `userId`.
 */
export async function similarity(input: SimilarityInput, deps: SimilarityDeps): Promise<SimilarityResult> {
  const { userId, itemId } = input;
  const text = input.text.trim();
  if (!text) return { projects: [], similarItems: [], embeddingModel: deps.embedder.model };

  const { model, vector } = await deps.embedder.embed(text);
  await deps.storage.putEmbedding(userId, itemId, model, vector);

  const others = (await deps.storage.listEmbeddings(userId, model)).filter(
    (row) => row.itemId !== itemId && row.vector.length === vector.length,
  );
  const vectorsById = new Map(others.map((row) => [row.itemId, row.vector]));

  const confirmed = await deps.storage.listCurrentFields(userId, { names: ["project"], state: "confirmed" });
  const membersByProject = new Map<string, number[][]>();
  for (const row of confirmed) {
    const member = vectorsById.get(row.itemId);
    if (!member || !Array.isArray(row.field.value)) continue;
    const names = new Set((row.field.value as ProjectScore[]).map((p) => p.project.trim()).filter(Boolean));
    for (const name of names) {
      const list = membersByProject.get(name) ?? [];
      list.push(member);
      membersByProject.set(name, list);
    }
  }

  const projects = [...membersByProject]
    .map(([project, members]) => ({ project, score: score(vector, centroid(members)) }))
    .sort((a, b) => b.score - a.score || a.project.localeCompare(b.project))
    .slice(0, TOP_PROJECTS);

  const similarItems = others
    .map((row) => ({ itemId: row.itemId, score: score(vector, row.vector) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId))
    .slice(0, TOP_ITEMS);

  return SimilarityResultSchema.parse({ projects, similarItems, embeddingModel: model });
}
