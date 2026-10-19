import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BulkDeps } from "../bulk/index.js";
import { createCategoriser, type Categoriser, type PipelineLogEvent } from "../pipeline.js";
import { createProvider, isProviderId, type Provider } from "../providers/index.js";
import { createMiniLmEmbedder, hashEmbedder } from "../similarity/index.js";
import { NeonStorage, SqliteStorage, type StorageAdapter } from "../storage/index.js";
import { UsageError } from "./args.js";

export type CliEnv = Record<string, string | undefined>;

export type RuntimeOptions = {
  mock: boolean;
  db?: string;
  user?: string;
  provider?: string;
  env: CliEnv;
  log?: (e: PipelineLogEvent) => void;
};

export type Runtime = {
  userId: string;
  mock: boolean;
  storage: StorageAdapter;
  categoriser: Categoriser;
  bulk: BulkDeps;
  close(): Promise<void>;
};

export type RuntimeFactory = (opts: RuntimeOptions) => Promise<Runtime>;

export const DEFAULT_USER = "local";

export function defaultDbPath(mock: boolean, env: CliEnv): string {
  return env.CATEGORISER_DB || join(homedir(), ".local", "share", "avi-categoriser", mock ? "mock.db" : "live.db");
}

function resolveProvider(name: string, mock: boolean, env: CliEnv): Provider | null {
  if (name === "none") return null;
  if (!isProviderId(name)) throw new UsageError(`unknown provider: ${name}`);
  // --mock promises no network and no AWS; a real provider would break that.
  if (mock && name !== "mock") throw new UsageError("--mock only works with --provider mock or none");
  return createProvider(name, env as NodeJS.ProcessEnv);
}

export const createRuntime: RuntimeFactory = async (opts) => {
  const { mock, env } = opts;
  const provider = resolveProvider(opts.provider ?? env.CATEGORISER_PROVIDER ?? (mock ? "mock" : "bedrock"), mock, env);
  const dbPath = opts.db ?? defaultDbPath(mock, env);
  const useNeon = !mock && !opts.db && !env.CATEGORISER_DB && Boolean(env.DATABASE_URL);
  if (!useNeon && dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const storage = useNeon ? new NeonStorage(env.DATABASE_URL) : new SqliteStorage(dbPath);
  await storage.init();
  const categoriser = createCategoriser({
    storage,
    provider,
    embedder: mock ? hashEmbedder : createMiniLmEmbedder({ allowDownload: true }),
    extract: mock ? { mock: true } : { sidecarUrl: env.CATEGORISER_SIDECAR_URL, githubToken: env.GITHUB_TOKEN },
    log: opts.log,
  });

  return {
    userId: opts.user ?? env.CATEGORISER_USER ?? DEFAULT_USER,
    mock,
    storage,
    categoriser,
    bulk: { storage },
    async close() {
      await categoriser.idle();
      await storage.close();
    },
  };
};
