export const PROVIDER_IDS = ["mock", "bedrock", "gemini", "kimi", "anthropic", "ollama"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type CompletionImage = { mime: string; bytes: Uint8Array };

export type CompletionRequest = {
  system: string;
  user: string;
  image?: CompletionImage;
  maxOutputTokens: number;
  temperature: number;
  /** Ask for JSON-only output where the provider supports a native JSON mode. */
  jsonMode: boolean;
  signal?: AbortSignal;
};

export type CompletionResult = {
  text: string;
  /** Exact model id that answered (may differ from the configured one, e.g. an inference profile). */
  modelVersion: string;
};

export type ProviderStatus = { state: "ready" | "not_configured"; detail: string };

export interface Provider {
  readonly id: ProviderId;
  readonly modelVersion: string;
  readonly supportsVision: boolean;
  /** Cloud providers are never called for `localOnly` items. */
  readonly cloud: boolean;
  status(): ProviderStatus;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type ProviderErrorCode = "rate_limited" | "budget_exceeded" | "unavailable" | "not_configured" | "bad_request";

/** Messages must never contain prompt or page content; they end up in logs. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Only transient upstream failures are worth backing off for. Budget and config failures fail closed. */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable";
  }
}
