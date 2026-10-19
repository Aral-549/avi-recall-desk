import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { bulkAccept, bulkRevert, bulkUnconfirm, confirmField, undo } from "../bulk/index.js";
import type { SaveInput } from "../pipeline.js";
import { decideTagProposal } from "../proposals/index.js";
import {
  CategoriserError,
  FieldNameSchema,
  MAX_FILE_BYTES,
  type BulkResult,
  type FieldName,
  type StoredTagProposal,
} from "../schemas/index.js";
import { parseTaxonomy, serializeTaxonomy } from "../taxonomy/index.js";
import { UsageError, type CommandName, type OptionValues } from "./args.js";
import { formatBulk, formatHealth, formatItem, formatProcess, formatProposals, itemJson } from "./format.js";
import type { Runtime } from "./runtime.js";

export type CliIO = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: AsyncIterable<string | Uint8Array>;
  cwd: string;
};

export type CommandContext = { rt: Runtime; args: string[]; values: OptionValues; io: CliIO; json: boolean };

type Handler = (ctx: CommandContext) => Promise<number>;

const FILE_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT_EXT = new Set([".txt", ".md", ".markdown"]);

function print(ctx: CommandContext, human: string, data: unknown): void {
  ctx.io.stdout(ctx.json ? JSON.stringify(data, null, 2) + "\n" : human + "\n");
}

const str = (v: OptionValues[string]): string | undefined => (typeof v === "string" ? v : undefined);

function requireOpt(values: OptionValues, name: string, command: string): string {
  const v = str(values[name]);
  if (!v) throw new UsageError(`${command}: --${name} is required`);
  return v;
}

function parseFields(raw: string | undefined): FieldName[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!FieldNameSchema.safeParse(n).success) throw new UsageError(`unknown field: ${n} (expected ${FieldNameSchema.options.join(", ")})`);
  }
  return names as FieldName[];
}

function parseField(raw: string): FieldName {
  const r = FieldNameSchema.safeParse(raw);
  if (!r.success) throw new UsageError(`unknown field: ${raw} (expected ${FieldNameSchema.options.join(", ")})`);
  return r.data;
}

/** Accepts a full ISO datetime with offset, or a bare YYYY-MM-DD meaning midnight UTC. */
export function parseAfter(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new UsageError(`invalid date: ${raw}`);
    return d.toISOString();
  }
  return raw;
}

async function readStdin(stdin: CliIO["stdin"]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function buildSaveInput(ctx: CommandContext): Promise<SaveInput> {
  const { rt, values, io } = ctx;
  const target = ctx.args[0]!;
  const note = str(values.note);
  const input: SaveInput = {
    userId: rt.userId,
    currentProject: str(values.project),
    localOnly: values["local-only"] === true,
    visionOptIn: values.vision === true,
  };

  if (target === "-") {
    if (note !== undefined) throw new UsageError("save -: the note is read from stdin; drop --note");
    const text = (await readStdin(io.stdin)).trim();
    if (!text) throw new UsageError("save -: stdin was empty");
    return { ...input, text };
  }
  if (/^https?:\/\//i.test(target)) return { ...input, url: target, text: note };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new UsageError("save: only http(s) URLs are supported");

  const path = resolve(io.cwd, target);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new UsageError(`save: no such file: ${target}`);
  if (info.size > MAX_FILE_BYTES) throw new UsageError(`save: file is larger than ${MAX_FILE_BYTES} bytes`);
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    if (note !== undefined) throw new UsageError("save: a text file is the note; drop --note");
    return { ...input, text: await readFile(path, "utf8") };
  }
  const mime = FILE_MIME[ext];
  if (!mime) throw new UsageError(`save: unsupported file type ${ext || "(none)"}; use ${[...Object.keys(FILE_MIME), ...TEXT_EXT].join(" ")}`);
  const bytes = (await readFile(path)).toString("base64");
  return { ...input, file: { mime, bytes, name: basename(path) }, text: note };
}

function bulkHandler(op: string, call: (ctx: CommandContext) => Promise<BulkResult>): Handler {
  return async (ctx) => {
    const result = await call(ctx);
    print(ctx, formatBulk(op, result), result);
    return 0;
  };
}

async function proposalsFor(ctx: CommandContext, itemId: string): Promise<StoredTagProposal[]> {
  return ctx.rt.storage.listTagProposals(ctx.rt.userId, { itemId });
}

function decide(decision: "approve" | "reject"): Handler {
  return async (ctx) => {
    const r = await decideTagProposal({ userId: ctx.rt.userId, proposalId: ctx.args[0]!, decision }, { storage: ctx.rt.storage });
    const tail = r.taxonomyChanged ? `; taxonomy is now v${r.taxonomyVersion}` : decision === "approve" ? "; tag already in taxonomy" : "";
    print(ctx, `${r.proposal.tag}: ${r.proposal.state}${tail}`, r);
    return 0;
  };
}

const PROPOSAL_STATES = new Set(["pending", "approved", "rejected", "all"]);

export const HANDLERS: Record<Exclude<CommandName, "eval" | "serve">, Handler> = {
  async save(ctx) {
    const input = await buildSaveInput(ctx);
    const saved = await ctx.rt.categoriser.save(input, { process: false });
    // A CLI process exits when the command returns, so run stages 2-6 now instead of queueing.
    const processed = ctx.values["no-process"] ? null : await ctx.rt.categoriser.process(ctx.rt.userId, saved.itemId);
    const human = [`saved ${saved.itemId} (${saved.type}/${saved.source})`, processed ? formatProcess(processed) : "not processed; run: categoriser process " + saved.itemId];
    print(ctx, human.join("\n"), { ...saved, queued: false, processed });
    return 0;
  },

  async process(ctx) {
    const r = await ctx.rt.categoriser.process(ctx.rt.userId, ctx.args[0]!);
    print(ctx, formatProcess(r), r);
    return 0;
  },

  async show(ctx) {
    const id = ctx.args[0]!;
    const view = await ctx.rt.categoriser.get(ctx.rt.userId, id);
    if (!view) throw new CategoriserError("not_found", "cli", "item not found", id);
    const proposals = await proposalsFor(ctx, id);
    print(ctx, formatItem(view, proposals), itemJson(view, proposals));
    return 0;
  },

  async confirm(ctx) {
    const [itemId, raw] = ctx.args as [string, string];
    const field = parseField(raw);
    const r = await confirmField({ userId: ctx.rt.userId, itemId, field }, ctx.rt.bulk);
    const human = r.affected.length ? formatBulk("confirm", r) : `${field} is already confirmed.`;
    print(ctx, human, r);
    return 0;
  },

  "bulk revert": bulkHandler("revert", ({ rt, values }) =>
    bulkRevert(
      {
        userId: rt.userId,
        model: requireOpt(values, "model", "bulk revert"),
        modelVersion: str(values["model-version"]),
        afterDate: parseAfter(requireOpt(values, "after", "bulk revert")),
        fields: parseFields(str(values.fields)),
      },
      rt.bulk,
    ),
  ),

  "bulk unconfirm": bulkHandler("unconfirm", ({ rt, values }) =>
    bulkUnconfirm(
      {
        userId: rt.userId,
        model: requireOpt(values, "model", "bulk unconfirm"),
        modelVersion: str(values["model-version"]),
        afterDate: parseAfter(requireOpt(values, "after", "bulk unconfirm")),
        fields: parseFields(str(values.fields)),
        dryRun: values.apply !== true,
      },
      rt.bulk,
    ),
  ),

  "bulk accept": bulkHandler("accept", ({ rt, values }) => {
    const rawMin = requireOpt(values, "min", "bulk accept");
    const min = Number(rawMin);
    if (!Number.isFinite(min)) throw new UsageError(`bulk accept: --min must be a number, got ${rawMin}`);
    return bulkAccept(
      { userId: rt.userId, project: requireOpt(values, "project", "bulk accept"), minConfidence: min, fields: parseFields(str(values.fields)) },
      rt.bulk,
    );
  }),

  undo: bulkHandler("undo", ({ rt, args }) => undo({ userId: rt.userId, opId: args[0]! }, rt.bulk)),

  async proposals(ctx) {
    const state = str(ctx.values.state) ?? "pending";
    if (!PROPOSAL_STATES.has(state)) throw new UsageError(`proposals: --state must be one of ${[...PROPOSAL_STATES].join(", ")}`);
    const list = await ctx.rt.storage.listTagProposals(ctx.rt.userId, {
      itemId: str(ctx.values.item),
      state: state === "all" ? undefined : (state as StoredTagProposal["state"]),
    });
    print(ctx, formatProposals(list), list);
    return 0;
  },

  "proposals approve": decide("approve"),
  "proposals reject": decide("reject"),

  async taxonomy(ctx) {
    const t = await ctx.rt.storage.getTaxonomy(ctx.rt.userId);
    print(ctx, serializeTaxonomy(t).trimEnd(), t);
    return 0;
  },

  async "taxonomy import"(ctx) {
    const path = resolve(ctx.io.cwd, ctx.args[0]!);
    const text = await readFile(path, "utf8").catch(() => {
      throw new UsageError(`taxonomy import: cannot read ${ctx.args[0]}`);
    });
    let taxonomy;
    try {
      taxonomy = parseTaxonomy(text);
    } catch {
      throw new CategoriserError("validation", "taxonomy", "file is not a valid taxonomy (check version, tag ids, duplicates)");
    }
    await ctx.rt.storage.putTaxonomy(ctx.rt.userId, taxonomy);
    print(ctx, `taxonomy is now v${taxonomy.version} (${taxonomy.tags.length} tags)`, { version: taxonomy.version, tags: taxonomy.tags.length });
    return 0;
  },

  async health(ctx) {
    const h = await ctx.rt.categoriser.health();
    print(ctx, formatHealth(h), h);
    return h.ok ? 0 : 1;
  },
};
