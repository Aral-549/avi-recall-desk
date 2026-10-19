import { nowIso, type Field, type ItemType, type ModelSuggestion, type Source } from "../schemas/index.js";
import type { TaxonomyIndex } from "../taxonomy/index.js";
import { ProviderError, type CompletionImage, type CompletionRequest, type Provider, type ProviderErrorCode } from "../providers/types.js";
import { buildPrompt, MAX_OUTPUT_TOKENS, RETRY_NOTE, TEMPERATURE } from "./prompt.js";
import { ruleSuggest, type SuggestedFields } from "./rules.js";
import { validateSuggestion, type InvalidReason } from "./validate.js";

export * from "./prompt.js";
export * from "./rules.js";
export * from "./validate.js";

/** Backoff before each retry of a transient provider failure (SPEC §2: 1 s / 4 s / 16 s + jitter). */
export const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] as const;
/** One retry on invalid output, then discard (invariant 4). */
export const MAX_INVALID_ATTEMPTS = 2;

export type SuggestInput = {
  itemId: string;
  type: ItemType;
  source: Source;
  host?: string;
  /** All text inputs must already be redacted by the caller. */
  userNote?: string;
  title?: string;
  text: string;
  candidateProjects: readonly string[];
  /** Project used in the rule `draftWhySaved` sentence (currentProject or top similarity match). */
  project?: string;
  localOnly: boolean;
  visionOptIn: boolean;
  image?: CompletionImage;
};

export type SuggestStatus = "ok" | "skipped_local_only" | "no_provider" | "invalid_output" | "error" | ProviderErrorCode;

export type SuggestLogEvent = {
  stage: "suggest";
  itemId: string;
  status: SuggestStatus;
  provider?: string;
  calls: number;
  invalidReasons: InvalidReason[];
  promptChars: number;
  outputChars: number;
  vision: boolean;
};

export type SuggestDeps = {
  taxonomy: TaxonomyIndex;
  provider?: Provider | null;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => string;
  retryDelaysMs?: readonly number[];
  log?: (e: SuggestLogEvent) => void;
};

export type ProjectPick = { project: string; confidence: number; model: string; modelVersion: string };

export type SuggestResult = SuggestedFields & {
  status: SuggestStatus;
  by: "model" | "rule";
  calls: number;
  projectPick: ProjectPick | null;
  tagProposals: ModelSuggestion["tagProposals"];
  model?: string;
  modelVersion?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function modelFields(s: ModelSuggestion, model: string, modelVersion: string, at: string): SuggestedFields {
  const base = { state: "suggested", by: "model", model, modelVersion, at } as const;
  return {
    tags: { ...base, value: s.tags, confidence: s.confidence.tags } as Field<string[]>,
    oneLineSummary: { ...base, value: s.oneLineSummary, confidence: s.confidence.summary },
    draftWhySaved: { ...base, value: s.draftWhySaved, confidence: s.confidence.summary },
  };
}

/**
 * Stage 5. Never throws: every failure path returns the rule fallback with a status.
 * Never writes `confirmed`; all returned fields are `state:"suggested"`.
 */
export async function suggest(input: SuggestInput, deps: SuggestDeps): Promise<SuggestResult> {
  const now = deps.now ?? nowIso;
  const at = now();
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const provider = deps.provider ?? null;
  const rules = ruleSuggest(
    { type: input.type, source: input.source, title: input.title, text: input.text, project: input.project },
    deps.taxonomy,
    at,
  );

  const vision = Boolean(input.image && input.visionOptIn && provider?.supportsVision && !input.localOnly);
  const invalidReasons: InvalidReason[] = [];
  let calls = 0;
  let promptChars = 0;
  let outputChars = 0;

  const finish = (status: SuggestStatus, extra?: Partial<SuggestResult>): SuggestResult => {
    deps.log?.({ stage: "suggest", itemId: input.itemId, status, provider: provider?.id, calls, invalidReasons, promptChars, outputChars, vision });
    return { ...rules, status, by: "rule", calls, projectPick: null, tagProposals: [], ...extra };
  };

  if (!provider) return finish("no_provider");
  if (input.localOnly && provider.cloud) return finish("skipped_local_only");

  const prompt = buildPrompt({
    type: input.type,
    source: input.source,
    host: input.host,
    userNote: input.userNote,
    content: [input.title, input.text].filter(Boolean).join("\n\n"),
    taxonomyIds: deps.taxonomy.ids,
    candidateProjects: input.candidateProjects,
    vision,
  });
  let req: CompletionRequest = {
    system: prompt.system,
    user: prompt.user,
    ...(vision && input.image ? { image: input.image } : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    jsonMode: true,
  };

  let transientRetries = 0;
  for (;;) {
    calls++;
    promptChars += req.system.length + req.user.length;
    let reply: { text: string; modelVersion: string };
    try {
      reply = await provider.complete(req);
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.retryable && transientRetries < delays.length) {
          const base = delays[transientRetries++]!;
          await sleep(Math.round(base * (1 + 0.25 * random())));
          continue;
        }
        return finish(err.code);
      }
      return finish("error");
    }
    outputChars += reply.text.length;

    const v = validateSuggestion(reply.text, deps.taxonomy, input.candidateProjects);
    if (v.ok) {
      const s = v.value;
      const fields = modelFields(s, provider.id, reply.modelVersion, at);
      deps.log?.({ stage: "suggest", itemId: input.itemId, status: "ok", provider: provider.id, calls, invalidReasons, promptChars, outputChars, vision });
      return {
        ...fields,
        status: "ok",
        by: "model",
        calls,
        projectPick:
          s.project && s.confidence.project !== undefined
            ? { project: s.project, confidence: s.confidence.project, model: provider.id, modelVersion: reply.modelVersion }
            : null,
        tagProposals: s.tagProposals,
        model: provider.id,
        modelVersion: reply.modelVersion,
      };
    }
    invalidReasons.push(v.reason);
    if (invalidReasons.length >= MAX_INVALID_ATTEMPTS) return finish("invalid_output");
    req = { ...req, user: `${prompt.user}\n${RETRY_NOTE}` };
  }
}
