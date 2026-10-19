import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput, type ImageFormat } from "@aws-sdk/client-bedrock-runtime";
import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from "./types.js";

export const BEDROCK_DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_DEFAULT_REGION = "us-east-1";
const REQUEST_TIMEOUT_MS = 30_000;

/** Minimal surface of BedrockRuntimeClient we use, so tests can inject a fake. */
export type ConverseClient = { send(cmd: ConverseCommand, opts?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> };

export type BedrockOptions = {
  region?: string;
  modelId?: string;
  client?: ConverseClient;
  env?: NodeJS.ProcessEnv;
};

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const RATE_LIMIT_ERRORS = new Set(["ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException"]);
const UNAVAILABLE_ERRORS = new Set(["ServiceUnavailableException", "ModelNotReadyException", "InternalServerException", "ModelTimeoutException", "TimeoutError", "AbortError"]);
const CONFIG_ERRORS = new Set(["AccessDeniedException", "UnrecognizedClientException", "CredentialsProviderError", "ExpiredTokenException", "ResourceNotFoundException"]);

export function mapBedrockError(err: unknown): ProviderError {
  const name = (err as { name?: string })?.name ?? "Error";
  if (RATE_LIMIT_ERRORS.has(name)) return new ProviderError("rate_limited", "bedrock", name);
  if (CONFIG_ERRORS.has(name)) return new ProviderError("not_configured", "bedrock", name);
  if (UNAVAILABLE_ERRORS.has(name)) return new ProviderError("unavailable", "bedrock", name);
  if (name === "ValidationException" || name === "ModelErrorException") return new ProviderError("bad_request", "bedrock", name);
  return new ProviderError("unavailable", "bedrock", name);
}

const hasAwsCredentialHints = (env: NodeJS.ProcessEnv) =>
  Boolean(
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
      env.AWS_PROFILE ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  );

export function createBedrockProvider(opts: BedrockOptions = {}): Provider {
  const env = opts.env ?? process.env;
  const region = opts.region ?? env.AWS_REGION ?? BEDROCK_DEFAULT_REGION;
  const modelId = opts.modelId ?? env.BEDROCK_MODEL_ID ?? BEDROCK_DEFAULT_MODEL;
  let client = opts.client;
  const getClient = () => (client ??= new BedrockRuntimeClient({ region, maxAttempts: 1 }));

  return {
    id: "bedrock",
    modelVersion: modelId,
    supportsVision: true,
    cloud: true,
    status: () =>
      opts.client || hasAwsCredentialHints(env)
        ? { state: "ready", detail: `region ${region}, model ${modelId}` }
        : { state: "not_configured", detail: "no AWS credentials in environment" },
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const content: NonNullable<ConstructorParameters<typeof ConverseCommand>[0]["messages"]>[number]["content"] = [];
      if (req.image) {
        const format = IMAGE_FORMATS[req.image.mime.toLowerCase()];
        if (!format) throw new ProviderError("bad_request", "bedrock", `unsupported image type`);
        content.push({ image: { format, source: { bytes: req.image.bytes } } });
      }
      content.push({ text: req.user });

      const cmd = new ConverseCommand({
        modelId,
        system: [{ text: req.system }],
        messages: [{ role: "user", content }],
        inferenceConfig: { maxTokens: req.maxOutputTokens, temperature: req.temperature },
      });
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      let out: ConverseCommandOutput;
      try {
        out = await getClient().send(cmd, { abortSignal: signal });
      } catch (err) {
        throw mapBedrockError(err);
      }
      const text = (out.output?.message?.content ?? []).map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");
      return { text, modelVersion: modelId };
    },
  };
}
