import { createBedrockProvider } from "./bedrock.js";
import { createGeminiProvider } from "./gemini.js";
import { createMockProvider } from "./mock.js";
import { createNotConfiguredProvider } from "./stubs.js";
import { PROVIDER_IDS, type Provider, type ProviderId } from "./types.js";

export * from "./types.js";
export * from "./budget.js";
export { createMockProvider, defaultMockReply, MOCK_MODEL_VERSION, type MockProviderOptions, type MockResponder } from "./mock.js";
export { createBedrockProvider, mapBedrockError, BEDROCK_DEFAULT_MODEL, BEDROCK_DEFAULT_REGION, type BedrockOptions, type ConverseClient } from "./bedrock.js";
export { createGeminiProvider, GEMINI_DEFAULT_MODEL, GEMINI_FREE_TIER, type GeminiOptions } from "./gemini.js";
export { createNotConfiguredProvider } from "./stubs.js";

export const isProviderId = (v: string): v is ProviderId => (PROVIDER_IDS as readonly string[]).includes(v);

/** Construction never makes a network call; misconfiguration surfaces via `status()` or on first `complete`. */
export function createProvider(id: ProviderId, env: NodeJS.ProcessEnv = process.env): Provider {
  switch (id) {
    case "mock":
      return createMockProvider();
    case "bedrock":
      return createBedrockProvider({ env });
    case "gemini":
      return createGeminiProvider({ env });
    case "kimi":
    case "anthropic":
    case "ollama":
      return createNotConfiguredProvider(id);
  }
}
