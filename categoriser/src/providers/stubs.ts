import { ProviderError, type Provider, type ProviderId } from "./types.js";

const NOT_CONFIGURED_DETAIL: Record<"kimi" | "anthropic" | "ollama", { cloud: boolean; model: string }> = {
  kimi: { cloud: true, model: "moonshot-v1-8k" },
  anthropic: { cloud: true, model: "claude-haiku-4-5" },
  ollama: { cloud: false, model: "llama3.1" },
};

/** Interface-only providers (SPEC redline 3). Every call fails closed to rules. */
export function createNotConfiguredProvider(id: Extract<ProviderId, "kimi" | "anthropic" | "ollama">): Provider {
  const { cloud, model } = NOT_CONFIGURED_DETAIL[id];
  return {
    id,
    modelVersion: model,
    supportsVision: false,
    cloud,
    status: () => ({ state: "not_configured", detail: `${id} adapter not implemented yet` }),
    complete: async () => {
      throw new ProviderError("not_configured", id, `${id} adapter not implemented yet`);
    },
  };
}
