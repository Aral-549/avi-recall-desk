import { CategoriserError } from "../schemas/index.js";
import { helpText, parseCli, UsageError, type ParsedCli } from "./args.js";
import { HANDLERS, type CliIO } from "./commands.js";
import { createRuntime, type CliEnv, type Runtime, type RuntimeFactory } from "./runtime.js";

export type RunIO = CliIO & { env: CliEnv };

export const EXIT = { ok: 0, error: 1, usage: 2 } as const;

const NOT_IMPLEMENTED: Record<string, string> = {
  eval: "eval is build stage 12 (fixtures + eval) and is not implemented yet",
  serve: "serve is build stage 11 (HTTP + Better Auth) and is not implemented yet",
};

function report(err: unknown, io: RunIO, json: boolean): number {
  if (err instanceof UsageError) {
    io.stderr(`${err.message}\nRun 'categoriser --help' for usage.\n`);
    return EXIT.usage;
  }
  const code = err instanceof CategoriserError ? err.code : err instanceof Error ? err.name : "unknown";
  // CategoriserError messages are content-free by construction; other errors report their name only.
  const message = err instanceof CategoriserError ? err.message : "unexpected failure";
  io.stderr(json ? JSON.stringify({ error: { code, message } }) + "\n" : `error [${code}]: ${message}\n`);
  return EXIT.error;
}

/** Runs one CLI invocation. Never throws; returns the process exit code. */
export async function run(argv: string[], io: RunIO, factory: RuntimeFactory = createRuntime): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    return report(err, io, false);
  }
  if (parsed.kind === "help") {
    io.stdout(helpText(parsed.command) + "\n");
    return EXIT.ok;
  }

  const { command, args, values } = parsed;
  const json = values.json === true;
  const notImplemented = NOT_IMPLEMENTED[command];
  if (notImplemented) return report(new CategoriserError("not_implemented", "cli", notImplemented), io, json);

  let rt: Runtime | undefined;
  try {
    rt = await factory({
      mock: values.mock === true,
      db: typeof values.db === "string" ? values.db : undefined,
      user: typeof values.user === "string" ? values.user : undefined,
      provider: typeof values.provider === "string" ? values.provider : undefined,
      env: io.env,
      log: values.verbose ? (e) => io.stderr(JSON.stringify(e) + "\n") : undefined,
    });
    const handler = HANDLERS[command as keyof typeof HANDLERS];
    return await handler({ rt, args, values, io, json });
  } catch (err) {
    return report(err, io, json);
  } finally {
    await rt?.close().catch(() => {});
  }
}
