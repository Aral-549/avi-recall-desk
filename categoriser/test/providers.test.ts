import { describe, expect, it } from "vitest";
import type { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  BEDROCK_DEFAULT_MODEL,
  BudgetGuard,
  ProviderError,
  createBedrockProvider,
  createGeminiProvider,
  createProvider,
  mapBedrockError,
  type CompletionRequest,
} from "../src/providers/index.js";

const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "SYS",
  user: "USER",
  maxOutputTokens: 600,
  temperature: 0,
  jsonMode: true,
  ...over,
});

const named = (name: string) => Object.assign(new Error(name), { name });

describe("BudgetGuard", () => {
  it("enforces RPM and RPD with a sliding window", () => {
    let t = 0;
    const g = new BudgetGuard({ rpm: 2, rpd: 3 }, () => t);
    expect(g.tryConsume()).toBe(true);
    expect(g.tryConsume()).toBe(true);
    expect(g.tryConsume()).toBe(false);
    t = 60_001;
    expect(g.tryConsume()).toBe(true);
    t = 120_002;
    expect(g.tryConsume()).toBe(false);
    t = 24 * 3_600_000 + 1;
    expect(g.tryConsume()).toBe(true);
  });
});

describe("bedrock", () => {
  it("builds a Converse request with system, image + text, and inference config", async () => {
    let sent: ConverseCommand | undefined;
    const p = createBedrockProvider({
      env: {},
      client: {
        send: async (cmd) => {
          sent = cmd;
          return { output: { message: { role: "assistant", content: [{ text: '{"a":' }, { text: "1}" }] } } } as never;
        },
      },
    });
    const out = await p.complete(req({ image: { mime: "image/jpeg", bytes: new Uint8Array([9]) } }));
    expect(out).toEqual({ text: '{"a":1}', modelVersion: BEDROCK_DEFAULT_MODEL });
    const input = sent!.input;
    expect(input.modelId).toBe(BEDROCK_DEFAULT_MODEL);
    expect(input.system).toEqual([{ text: "SYS" }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 600, temperature: 0 });
    expect(input.messages![0]!.content![0]).toMatchObject({ image: { format: "jpeg" } });
    expect(input.messages![0]!.content![1]).toEqual({ text: "USER" });
  });

  it("honours BEDROCK_MODEL_ID and reports status from credential hints", () => {
    expect(createBedrockProvider({ env: { BEDROCK_MODEL_ID: "x.y" } }).modelVersion).toBe("x.y");
    expect(createBedrockProvider({ env: {} }).status().state).toBe("not_configured");
    expect(createBedrockProvider({ env: { AWS_PROFILE: "dev" } }).status().state).toBe("ready");
  });

  it.each([
    ["ThrottlingException", "rate_limited"],
    ["ServiceUnavailableException", "unavailable"],
    ["AccessDeniedException", "not_configured"],
    ["CredentialsProviderError", "not_configured"],
    ["ValidationException", "bad_request"],
    ["SomethingNew", "unavailable"],
  ])("maps %s -> %s", (name, code) => {
    expect(mapBedrockError(named(name)).code).toBe(code);
  });

  it("rejects unsupported image types before calling", async () => {
    const p = createBedrockProvider({ env: {}, client: { send: async () => ({}) as never } });
    await expect(p.complete(req({ image: { mime: "image/tiff", bytes: new Uint8Array() } }))).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("gemini", () => {
  const okResponse = () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"ok":true}' }] } }], modelVersion: "gemini-x-001" }), {
      status: 200,
    });

  it("posts to the fixed Google host with the key in a header, JSON mode, and no thought parts", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const p = createGeminiProvider({
      apiKey: "k",
      model: "gemini-2.5-flash",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return okResponse();
      }) as typeof fetch,
    });
    const out = await p.complete(req({ image: { mime: "image/png", bytes: new Uint8Array([1, 2]) } }));
    expect(out).toEqual({ text: '{"ok":true}', modelVersion: "gemini-x-001" });
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(seen[0]!.url).not.toContain("k");
    expect((seen[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AQI=" } });
    expect(body.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 600, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } });
  });

  it.each([
    [429, "rate_limited"],
    [403, "not_configured"],
    [503, "unavailable"],
    [400, "bad_request"],
  ])("maps HTTP %i -> %s", async (status, code) => {
    const p = createGeminiProvider({ apiKey: "k", fetch: (async () => new Response("{}", { status })) as typeof fetch });
    await expect(p.complete(req())).rejects.toMatchObject({ code });
  });

  it("fails closed when the budget guard trips, without calling fetch", async () => {
    let calls = 0;
    const p = createGeminiProvider({
      apiKey: "k",
      budget: new BudgetGuard({ rpm: 1, rpd: 1 }),
      fetch: (async () => {
        calls++;
        return okResponse();
      }) as typeof fetch,
    });
    await p.complete(req());
    await expect(p.complete(req())).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(calls).toBe(1);
  });

  it("is not_configured without a key, and rejects unsafe model ids", async () => {
    const p = createGeminiProvider({ env: {} });
    expect(p.status().state).toBe("not_configured");
    await expect(p.complete(req())).rejects.toMatchObject({ code: "not_configured" });
    expect(() => createGeminiProvider({ apiKey: "k", model: "../../evil?x=" })).toThrow(ProviderError);
  });
});

describe("createProvider", () => {
  it.each(["kimi", "anthropic", "ollama"] as const)("%s is an interface-only NotConfigured stub", async (id) => {
    const p = createProvider(id, {});
    expect(p.status().state).toBe("not_configured");
    await expect(p.complete(req())).rejects.toMatchObject({ code: "not_configured", provider: id });
  });

  it("constructs every provider with no network and no credentials", () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network forbidden");
    }) as typeof fetch;
    try {
      for (const id of ["mock", "bedrock", "gemini", "kimi", "anthropic", "ollama"] as const) expect(createProvider(id, {}).id).toBe(id);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
