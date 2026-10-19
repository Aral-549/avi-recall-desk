import { parseArgs, type ParseArgsConfig } from "node:util";

type OptionSpec = NonNullable<ParseArgsConfig["options"]>;
export type OptionValues = Record<string, string | boolean | undefined>;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const GLOBAL_OPTIONS = {
  mock: { type: "boolean" },
  db: { type: "string" },
  user: { type: "string" },
  provider: { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies OptionSpec;

const OP_FILTER = {
  model: { type: "string" },
  "model-version": { type: "string" },
  after: { type: "string" },
  fields: { type: "string" },
} satisfies OptionSpec;

type CommandSpec = { usage: string; summary: string; args: [min: number, max: number]; options: OptionSpec };

export const COMMANDS = {
  save: {
    usage: "save <url|file|-> [--project P] [--local-only] [--vision] [--note TEXT] [--no-process]",
    summary: "Save a URL, an image/PDF/text file, or a note from stdin (-), then categorise it",
    args: [1, 1],
    options: {
      project: { type: "string" },
      "local-only": { type: "boolean" },
      vision: { type: "boolean" },
      note: { type: "string" },
      "no-process": { type: "boolean" },
    },
  },
  process: { usage: "process <id>", summary: "Re-run stages 2-6 for an item (user fields are kept)", args: [1, 1], options: {} },
  show: { usage: "show <id>", summary: "Show an item with per-field provenance", args: [1, 1], options: {} },
  confirm: { usage: "confirm <id> <field>", summary: "Confirm one suggested field (undoable)", args: [2, 2], options: {} },
  "bulk revert": {
    usage: "bulk revert --model M --after DATE [--model-version V] [--fields a,b]",
    summary: "Remove a model's suggestions made after DATE (never touches confirmed values)",
    args: [0, 0],
    options: OP_FILTER,
  },
  "bulk unconfirm": {
    usage: "bulk unconfirm --model M --after DATE [--model-version V] [--fields a,b] [--apply]",
    summary: "Turn confirmations of a model's suggestions back into suggestions (dry run unless --apply)",
    args: [0, 0],
    options: { ...OP_FILTER, apply: { type: "boolean" } },
  },
  "bulk accept": {
    usage: "bulk accept --project P --min 0.9 [--fields a,b]",
    summary: "Confirm confident suggestions on items whose top project is P",
    args: [0, 0],
    options: { project: { type: "string" }, min: { type: "string" }, fields: { type: "string" } },
  },
  undo: { usage: "undo <opId>", summary: "Undo a confirm or bulk operation (an undo can be undone)", args: [1, 1], options: {} },
  proposals: {
    usage: "proposals [--item ID] [--state pending|approved|rejected|all]",
    summary: "List tag proposals (pending by default)",
    args: [0, 0],
    options: { item: { type: "string" }, state: { type: "string" } },
  },
  "proposals approve": { usage: "proposals approve <proposalId>", summary: "Add a proposed tag to your taxonomy", args: [1, 1], options: {} },
  "proposals reject": { usage: "proposals reject <proposalId>", summary: "Reject a proposed tag", args: [1, 1], options: {} },
  taxonomy: { usage: "taxonomy", summary: "Print your taxonomy as YAML", args: [0, 0], options: {} },
  "taxonomy import": {
    usage: "taxonomy import <file.yaml>",
    summary: "Replace your taxonomy (version must be greater than the current one)",
    args: [1, 1],
    options: {},
  },
  health: { usage: "health", summary: "Storage, provider and sidecar status", args: [0, 0], options: {} },
  eval: { usage: "eval [--provider P]", summary: "Run the eval harness (stage 12, not implemented yet)", args: [0, 0], options: {} },
  serve: { usage: "serve", summary: "Start the HTTP wrapper (stage 11, not implemented yet)", args: [0, 0], options: {} },
} satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

export type ParsedCli =
  | { kind: "help"; command?: CommandName }
  | { kind: "command"; command: CommandName; args: string[]; values: OptionValues };

const ALL_OPTIONS: OptionSpec = Object.assign({}, GLOBAL_OPTIONS, ...Object.values(COMMANDS).map((c) => c.options));

const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

function resolveCommand(positionals: string[]): CommandName | undefined {
  const [first, second] = positionals;
  if (!first) return undefined;
  if (second && isCommand(`${first} ${second}`)) return `${first} ${second}` as CommandName;
  return isCommand(first) ? first : undefined;
}

export function parseCli(argv: string[]): ParsedCli {
  // A loose pass that knows every option, only to find the command words among the positionals.
  const loose = parseArgs({ args: argv, options: ALL_OPTIONS, allowPositionals: true, strict: false });
  const command = resolveCommand(loose.positionals);
  if (!command) {
    if (loose.positionals.length === 0) return { kind: "help" };
    throw new UsageError(`unknown command: ${loose.positionals.slice(0, 2).join(" ")}`);
  }

  const spec: CommandSpec = COMMANDS[command];
  let strict: { values: OptionValues; positionals: string[] };
  try {
    strict = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...spec.options }, allowPositionals: true, strict: true }) as typeof strict;
  } catch (err) {
    throw new UsageError(`${command}: ${err instanceof Error ? err.message : "invalid arguments"}`);
  }
  if (strict.values.help) return { kind: "help", command };

  const args = strict.positionals.slice(command.split(" ").length);
  const [min, max] = spec.args;
  if (args.length < min || args.length > max) throw new UsageError(`usage: categoriser ${spec.usage}`);
  return { kind: "command", command, args, values: strict.values };
}

export function helpText(command?: CommandName): string {
  if (command) {
    const spec: CommandSpec = COMMANDS[command];
    return `${spec.summary}\n\nusage: categoriser ${spec.usage}\n\n${GLOBAL_HELP}`;
  }
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`);
  return `AVI CATEGORISER: models suggest, you confirm.\n\nusage: categoriser <command> [options]\n\ncommands:\n${lines.join("\n")}\n\n${GLOBAL_HELP}`;
}

const GLOBAL_HELP = `global options:
  --mock            no network, no AWS: mock provider, hash embeddings, mock extraction
  --db PATH         SQLite file (default $CATEGORISER_DB or ~/.local/share/avi-categoriser/{mock,live}.db)
  --user ID         user id (default $CATEGORISER_USER or "local")
  --provider P      mock|bedrock|gemini|kimi|anthropic|ollama|none (default $CATEGORISER_PROVIDER, else bedrock; mock with --mock)
  --json            machine-readable output
  --verbose         pipeline log events (ids, statuses, counts; never content) on stderr
  -h, --help        show help`;
