import { ModelSuggestionSchema, type ModelSuggestion } from "../schemas/index.js";
import { normalizeTagToken, type TaxonomyIndex } from "../taxonomy/index.js";
import { cleanProjectName } from "./prompt.js";

export type InvalidReason =
  | "empty"
  | "not_json"
  | "schema"
  | "unknown_tag"
  | "proposal_exists"
  | "duplicate_proposal"
  | "project_without_confidence";

export type ValidationResult = { ok: true; value: ModelSuggestion } | { ok: false; reason: InvalidReason };

const FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;
const tidy = (s: string) => s.replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();

/**
 * Strict validation (invariant 4): any problem rejects the whole reply. The only tolerated
 * deviations are a single surrounding code fence and a project that is not a candidate,
 * which SPEC §1 says is dropped rather than rejected.
 */
export function validateSuggestion(raw: string, taxonomy: TaxonomyIndex, candidateProjects: readonly string[]): ValidationResult {
  let text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  const fenced = text.match(FENCE);
  if (fenced) text = fenced[1]!.trim();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }

  const first = ModelSuggestionSchema.safeParse(json);
  if (!first.success) return { ok: false, reason: "schema" };
  const s = first.data;

  const { resolved, unknown } = taxonomy.resolveAll(s.tags);
  if (unknown.length) return { ok: false, reason: "unknown_tag" };

  const proposals: ModelSuggestion["tagProposals"] = [];
  for (const p of s.tagProposals) {
    const tag = normalizeTagToken(p.tag);
    if (taxonomy.resolve(tag)) return { ok: false, reason: "proposal_exists" };
    if (proposals.some((q) => q.tag === tag)) return { ok: false, reason: "duplicate_proposal" };
    proposals.push({ tag, reason: tidy(p.reason) || p.tag });
  }

  let project: string | undefined;
  let projectConfidence: number | undefined;
  if (s.project !== undefined) {
    const wanted = cleanProjectName(s.project).toLowerCase();
    const match = candidateProjects.find((c) => cleanProjectName(c).toLowerCase() === wanted);
    if (match) {
      if (s.confidence.project === undefined) return { ok: false, reason: "project_without_confidence" };
      project = match;
      projectConfidence = s.confidence.project;
    }
  }

  const candidate: ModelSuggestion = {
    tags: resolved,
    tagProposals: proposals,
    oneLineSummary: tidy(s.oneLineSummary),
    draftWhySaved: tidy(s.draftWhySaved),
    ...(project ? { project } : {}),
    confidence: {
      tags: s.confidence.tags,
      summary: s.confidence.summary,
      ...(projectConfidence !== undefined ? { project: projectConfidence } : {}),
    },
  };
  // Re-check after tidying: stripping control characters can push a string under the minimum.
  const second = ModelSuggestionSchema.safeParse(candidate);
  return second.success ? { ok: true, value: second.data } : { ok: false, reason: "schema" };
}
