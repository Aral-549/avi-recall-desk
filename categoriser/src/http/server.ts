import { createServer, type Server } from "node:http";
import { parseArgs } from "node:util";
import { createRuntime, DEFAULT_USER, type Runtime } from "../cli/runtime.js";
import { CategoriserError } from "../schemas/index.js";
import { bearerAuthenticator, createHttpHandler, mockAuthenticator, type Authenticator, type HttpLogEvent } from "./app.js";

export const DEFAULT_PORT = 8788;
/** Loopback only (SPEC section 8). Exposing this needs real auth first. */
export const HOST = "127.0.0.1";

export function startServer(
  rt: Runtime,
  opts: { port?: number; authenticate: Authenticator; log?: (e: HttpLogEvent) => void },
): Promise<Server> {
  const handler = createHttpHandler({
    storage: rt.storage,
    categoriser: rt.categoriser,
    bulk: rt.bulk,
    authenticate: opts.authenticate,
    log: opts.log,
  });
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => resolve(server));
  });
}

/** Mock mode uses a fixed dev user; live mode needs a bearer token until Better Auth lands. */
export function resolveAuthenticator(mock: boolean, userId: string, env: Record<string, string | undefined>): Authenticator {
  if (mock) return mockAuthenticator(userId);
  const token = env.CATEGORISER_HTTP_TOKEN;
  if (!token) throw new CategoriserError("config", "http", "live mode requires CATEGORISER_HTTP_TOKEN (min 16 chars)");
  return bearerAuthenticator(token, userId);
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      mock: { type: "boolean", default: false },
      port: { type: "string" },
      db: { type: "string" },
      user: { type: "string" },
      provider: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
  });
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CategoriserError("config", "http", "invalid --port");

  const mock = values.mock === true;
  const userId = values.user ?? env.CATEGORISER_USER ?? DEFAULT_USER;
  const authenticate = resolveAuthenticator(mock, userId, env);
  const log = values.verbose ? (e: unknown) => process.stderr.write(JSON.stringify(e) + "\n") : undefined;
  const rt = await createRuntime({ mock, db: values.db, user: values.user, provider: values.provider, env, log });
  const server = await startServer(rt, { port, authenticate, log });

  process.stderr.write(`categoriser http listening on http://${HOST}:${port} (${mock ? "mock" : "live"})\n`);
  const stop = () => {
    server.close(() => void rt.close().finally(() => process.exit(0)));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`error [${err instanceof CategoriserError ? err.code : "unexpected"}]: ${err instanceof CategoriserError ? err.message : "failed to start"}\n`);
    process.exit(1);
  });
}
