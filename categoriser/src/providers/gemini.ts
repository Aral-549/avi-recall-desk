import { BudgetGuard, type BudgetLimits } from "./budget.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.js";

export const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";
const GEMINI_HOST = "https://generativelanguage.googleapis.com";
/** Conservative free-tier defaults; real quotas vary per project, so they are configurable. */
export const GEMINI_FREE_TIER: BudgetLimits = { rpm: 10, rpd: 250 };
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

export type GeminiOptions = {
  apiKey?: string;
  model?: string;
  budget?: BudgetGuard;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

const intEnv = (v: string | undefined, fallback: number) => {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  modelVersion?: string;
};

export function createGeminiProvider(opts: GeminiOptions = {}): Provider & { budget: BudgetGuard } {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env.GEMINI_API_KEY;
  const model = opts.model ?? env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
  if (!MODEL_ID.test(model)) throw new ProviderError("not_configured", "gemini", "invalid GEMINI_MODEL");
  const budget =
    opts.budget ?? new BudgetGuard({ rpm: intEnv(env.GEMINI_RPM, GEMINI_FREE_TIER.rpm), rpd: intEnv(env.GEMINI_RPD, GEMINI_FREE_TIER.rpd) });
  const doFetch = opts.fetch ?? fetch;

  return {
    id: "gemini",
    modelVersion: model,
    supportsVision: true,
    cloud: true,
    budget,
    status: () => (apiKey ? { state: "ready", detail: `model ${model}` } : { state: "not_configured", detail: "GEMINI_API_KEY not set" }),
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (!apiKey) throw new ProviderError("not_configured", "gemini", "GEMINI_API_KEY not set");
      if (!budget.tryConsume()) throw new ProviderError("budget_exceeded", "gemini", "free-tier budget guard tripped");

      const parts: Array<Record<string, unknown>> = [];
      if (req.image) parts.push({ inline_data: { mime_type: req.image.mime, data: Buffer.from(req.image.bytes).toString("base64") } });
      parts.push({ text: req.user });

      const generationConfig: Record<string, unknown> = {
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
        // 2.5 models count thinking against maxOutputTokens; a 600 token cap would truncate the JSON.
        ...(model.startsWith("gemini-2.5-flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      };
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      let res: Response;
      try {
        res = await doFetch(`${GEMINI_HOST}/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: "user", parts }],
            generationConfig,
          }),
          redirect: "error",
          signal,
        });
      } catch (err) {
        throw new ProviderError("unavailable", "gemini", (err as Error)?.name ?? "fetch failed");
      }

      if (res.status === 429) throw new ProviderError("rate_limited", "gemini", "HTTP 429");
      if (res.status === 401 || res.status === 403) throw new ProviderError("not_configured", "gemini", `HTTP ${res.status}`);
      if (res.status >= 500) throw new ProviderError("unavailable", "gemini", `HTTP ${res.status}`);
      if (!res.ok) throw new ProviderError("bad_request", "gemini", `HTTP ${res.status}`);

      let body: GeminiResponse;
      try {
        body = (await res.json()) as GeminiResponse;
      } catch {
        throw new ProviderError("unavailable", "gemini", "non-JSON response");
      }
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
      return { text, modelVersion: body.modelVersion ?? model };
    },
  };
}
