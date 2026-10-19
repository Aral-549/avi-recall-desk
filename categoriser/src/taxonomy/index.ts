import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { TagIdSchema } from "../schemas/index.js";

export const TaxonomyTagSchema = z
  .object({
    id: TagIdSchema,
    label: z.string().min(1).max(60).optional(),
    synonyms: z.array(z.string().min(1).max(60)).default([]),
    description: z.string().max(200).optional(),
  })
  .strict();
export type TaxonomyTag = z.infer<typeof TaxonomyTagSchema>;

export const TaxonomySchema = z
  .object({
    version: z.number().int().positive(),
    tags: z.array(TaxonomyTagSchema).min(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const tag of t.tags) {
      if (ids.has(tag.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate tag id ${tag.id}` });
      ids.add(tag.id);
    }
  });
export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const MAX_TAGS = 5;

/** lowercase, trim, spaces/underscores -> hyphen, strip anything not [a-z0-9-], collapse hyphens. */
export function normalizeTagToken(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[\s_/.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class TaxonomyIndex {
  private readonly lookup = new Map<string, string>();
  readonly ids: readonly string[];

  constructor(readonly taxonomy: Taxonomy) {
    this.ids = taxonomy.tags.map((t) => t.id);
    for (const tag of taxonomy.tags) {
      this.lookup.set(tag.id, tag.id);
      if (tag.label) this.lookup.set(normalizeTagToken(tag.label), tag.id);
      for (const s of tag.synonyms) this.lookup.set(normalizeTagToken(s), tag.id);
    }
  }

  /** Returns the canonical id or null. Never invents. */
  resolve(raw: string): string | null {
    const norm = normalizeTagToken(raw);
    if (!norm) return null;
    return this.lookup.get(norm) ?? null;
  }

  has(id: string): boolean {
    return this.lookup.get(id) === id;
  }

  /**
   * Resolve a list of raw tags. Returns resolved ids (deduped, max 5) and the raw tokens that failed.
   * Callers decide whether unknowns invalidate the whole result (model path) or are dropped (rule path).
   */
  resolveAll(raw: string[]): { resolved: string[]; unknown: string[] } {
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const r of raw) {
      const id = this.resolve(r);
      if (!id) unknown.push(r);
      else if (!resolved.includes(id)) resolved.push(id);
    }
    return { resolved: resolved.slice(0, MAX_TAGS), unknown };
  }

  /** Keyword-based rule tagging: counts synonym/label/id hits in text, returns top ids with a crude score. */
  suggestFromText(text: string, max = MAX_TAGS): Array<{ id: string; score: number }> {
    const hay = ` ${normalizeTagToken(text.slice(0, 20_000)).replace(/-/g, " ")} `;
    const scores = new Map<string, number>();
    for (const tag of this.taxonomy.tags) {
      const tokens = new Set([tag.id, ...(tag.label ? [tag.label] : []), ...tag.synonyms].map((s) => normalizeTagToken(s).replace(/-/g, " ")));
      let hits = 0;
      for (const tok of tokens) {
        if (tok.length < 2) continue;
        const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        hits += (hay.match(re) ?? []).length;
      }
      if (hits > 0) scores.set(tag.id, hits);
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
    const top = ranked[0]?.[1] ?? 1;
    return ranked.map(([id, hits]) => ({ id, score: Math.min(0.6, 0.3 + (0.3 * hits) / top) }));
  }

  /** Returns a new taxonomy with the tag appended and version bumped. Pure. */
  approveProposal(tag: string, reason?: string): Taxonomy {
    const id = normalizeTagToken(tag);
    TagIdSchema.parse(id);
    if (this.resolve(id)) throw new Error(`tag ${id} already exists or is a synonym of ${this.resolve(id)}`);
    return TaxonomySchema.parse({
      version: this.taxonomy.version + 1,
      tags: [...this.taxonomy.tags, { id, synonyms: [], ...(reason ? { description: reason.slice(0, 200) } : {}) }],
    });
  }
}

export function parseTaxonomy(yamlText: string): Taxonomy {
  return TaxonomySchema.parse(parseYaml(yamlText));
}

export function serializeTaxonomy(t: Taxonomy): string {
  return stringifyYaml(t);
}

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = resolve(here, "../../taxonomy.seed.yaml");

export function loadSeedTaxonomy(): Taxonomy {
  return parseTaxonomy(readFileSync(SEED_PATH, "utf8"));
}
