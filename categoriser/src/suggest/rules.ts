import type { Field, ItemType, Source } from "../schemas/index.js";
import { MAX_TAGS, type TaxonomyIndex } from "../taxonomy/index.js";

export const RULE_CONFIDENCE = { tags: 0.6, summary: 0.5, draftWhySaved: 0.3 } as const;
const RULE_SUMMARY_CHARS = 120;

export type RuleInput = {
  type: ItemType;
  source: Source;
  /** Redacted. */
  title?: string;
  /** Redacted. */
  text: string;
  project?: string;
};

export type SuggestedFields = {
  tags: Field<string[]>;
  oneLineSummary: Field<string>;
  draftWhySaved: Field<string>;
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function ruleSuggest(input: RuleInput, taxonomy: TaxonomyIndex, at: string): SuggestedFields {
  const title = squash(input.title ?? "");
  const body = squash(input.text);
  const tags = taxonomy.suggestFromText(`${title} ${body}`, MAX_TAGS).map((t) => t.id);
  const summary = title ? clip(title, RULE_SUMMARY_CHARS) : body ? clip(body, RULE_SUMMARY_CHARS) : `Saved ${input.type} from ${input.source}`;
  const project = input.project ? squash(input.project).slice(0, 120) : "";
  const why = project ? `Saved from ${input.source} while working on ${project}` : `Saved from ${input.source}`;
  const base = { state: "suggested", by: "rule", at } as const;
  return {
    tags: { ...base, value: tags, confidence: RULE_CONFIDENCE.tags },
    oneLineSummary: { ...base, value: summary, confidence: RULE_CONFIDENCE.summary },
    draftWhySaved: { ...base, value: why, confidence: RULE_CONFIDENCE.draftWhySaved },
  };
}
