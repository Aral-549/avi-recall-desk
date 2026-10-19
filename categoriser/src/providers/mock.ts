import type { CompletionRequest, CompletionResult, Provider } from "./types.js";

export const MOCK_MODEL_VERSION = "mock-v1";

export type MockResponder = (req: CompletionRequest, call: number) => string | Promise<string>;

export type MockProviderOptions = {
  /** Override the reply. `call` is 1-based across the provider's lifetime. */
  respond?: MockResponder;
  /** Defaults to true so `--mock` exercises the same localOnly gating as a real cloud provider. */
  cloud?: boolean;
  supportsVision?: boolean;
};

const between = (text: string, open: string, close: string): string => {
  const a = text.indexOf(open);
  const b = text.indexOf(close, a + open.length);
  return a >= 0 && b > a ? text.slice(a + open.length, b) : "";
};

/**
 * Deterministic, offline reply built only from the prompt's allowed tag ids and metadata.
 * It never copies untrusted content into its output, so it cannot echo an injection.
 */
export function defaultMockReply(req: CompletionRequest): string {
  const allowed = (req.system.match(/^Allowed tags \(use ONLY these ids\): (.*)$/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = (req.system.match(/^Candidate projects \(choose at most one, or omit\): (.*)$/m)?.[1] ?? "")
    .split(" | ")
    .map((s) => s.trim())
    .filter((s) => s && s !== "(none)");
  const content = between(req.user, "<untrusted_content>", "</untrusted_content>").toLowerCase();
  const meta = between(req.user, "<metadata>", "</metadata>");
  const type = meta.match(/type: (\S+)/)?.[1] ?? "item";
  const source = meta.match(/source: (\S+)/)?.[1] ?? "manual";

  const tags = allowed.filter((id) => new RegExp(`\\b${id.replace(/-/g, "[- ]")}\\b`).test(content)).slice(0, 3);
  return JSON.stringify({
    tags,
    tagProposals: [],
    oneLineSummary: `Mock summary of a ${type} saved from ${source}.`,
    draftWhySaved: `Mock draft: saved from ${source} for later reference.`,
    ...(candidates[0] ? { project: candidates[0] } : {}),
    confidence: { tags: tags.length ? 0.7 : 0.4, summary: 0.5, ...(candidates[0] ? { project: 0.5 } : {}) },
  });
}

export function createMockProvider(opts: MockProviderOptions = {}): Provider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const respond = opts.respond ?? defaultMockReply;
  return {
    id: "mock",
    modelVersion: MOCK_MODEL_VERSION,
    supportsVision: opts.supportsVision ?? true,
    cloud: opts.cloud ?? true,
    calls,
    status: () => ({ state: "ready", detail: "mock provider (offline)" }),
    async complete(req): Promise<CompletionResult> {
      calls.push(req);
      return { text: await respond(req, calls.length), modelVersion: MOCK_MODEL_VERSION };
    },
  };
}
