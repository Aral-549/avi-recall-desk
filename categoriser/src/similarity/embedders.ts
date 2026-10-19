import { homedir } from "node:os";
import { join } from "node:path";

export const HASH_MODEL = "hash-v1";
export const MINILM_MODEL = "all-MiniLM-L6-v2";
const MINILM_HF_ID = "Xenova/all-MiniLM-L6-v2";
const HASH_DIM = 512;
/** MiniLM truncates at 256 word pieces anyway; capping chars keeps tokenisation cheap. */
export const MAX_EMBED_CHARS = 2000;

export type Embedding = { model: string; vector: number[] };

export interface Embedder {
  /** Preferred model id; the actual model used is reported per call in `Embedding.model`. */
  readonly model: string;
  embed(text: string): Promise<Embedding>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? v.map(() => 0) : v.map((x) => x / norm);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 4000);
}

/**
 * Deterministic signed feature-hashing over unigrams and bigrams with sublinear tf.
 * Same input always yields the same vector; no network, no files.
 */
export const hashEmbedder: Embedder = {
  model: HASH_MODEL,
  async embed(text: string): Promise<Embedding> {
    const tokens = tokenize(text.slice(0, MAX_EMBED_CHARS * 4));
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      counts.set(`u:${tokens[i]}`, (counts.get(`u:${tokens[i]}`) ?? 0) + 1);
      if (i > 0) counts.set(`b:${tokens[i - 1]} ${tokens[i]}`, (counts.get(`b:${tokens[i - 1]} ${tokens[i]}`) ?? 0) + 1);
    }
    const v = new Array<number>(HASH_DIM).fill(0);
    for (const [feature, tf] of counts) {
      const h = fnv1a(feature);
      const weight = (1 + Math.log(tf)) * (feature.startsWith("b:") ? 0.5 : 1);
      v[h % HASH_DIM]! += h & 0x80000000 ? -weight : weight;
    }
    return { model: HASH_MODEL, vector: l2normalize(v) };
  },
};

export type MiniLmOptions = {
  /** Allow downloading weights from Hugging Face on first use. Item text never leaves the machine either way. */
  allowDownload?: boolean;
  cacheDir?: string;
};

type FeaturePipeline = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * Local all-MiniLM-L6-v2 with automatic fallback to `hash-v1` if the model can't load or a call fails.
 * The load is attempted once per instance; a failed load is remembered.
 */
export function createMiniLmEmbedder(opts: MiniLmOptions = {}): Embedder {
  let loading: Promise<FeaturePipeline | null> | null = null;

  const load = () =>
    (loading ??= (async () => {
      try {
        const { pipeline, env } = await import("@xenova/transformers");
        env.cacheDir = opts.cacheDir ?? process.env.CATEGORISER_MODEL_CACHE ?? join(homedir(), ".cache", "avi-categoriser", "models");
        env.allowRemoteModels = opts.allowDownload ?? true;
        env.allowLocalModels = true;
        return (await pipeline("feature-extraction", MINILM_HF_ID)) as unknown as FeaturePipeline;
      } catch {
        return null;
      }
    })());

  return {
    model: MINILM_MODEL,
    async embed(text: string): Promise<Embedding> {
      const extractor = await load();
      if (!extractor) return hashEmbedder.embed(text);
      try {
        const out = await extractor([text.slice(0, MAX_EMBED_CHARS)], { pooling: "mean", normalize: true });
        const vector = out.tolist()[0];
        if (!vector?.length || vector.some((x) => !Number.isFinite(x))) return hashEmbedder.embed(text);
        return { model: MINILM_MODEL, vector };
      } catch {
        return hashEmbedder.embed(text);
      }
    },
  };
}
