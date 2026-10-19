import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCli, UsageError } from "../src/cli/args.js";
import { parseAfter } from "../src/cli/commands.js";
import { clean } from "../src/cli/format.js";
import { run, type RunIO } from "../src/cli/run.js";
import { decideTagProposal } from "../src/proposals/index.js";
import { CategoriserError, type RawItem, type StoredTagProposal } from "../src/schemas/index.js";
import { SqliteStorage } from "../src/storage/index.js";

let dir: string;
let db: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "categoriser-cli-"));
  db = join(dir, "test.db");
  // --mock must never touch the network (SPEC redline 5).
  fetchSpy = vi.fn(() => Promise.reject(new Error("network disabled in tests")));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string };

async function cli(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Out> {
  let stdout = "";
  let stderr = "";
  const io: RunIO = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    stdin: (async function* () {
      if (opts.stdin !== undefined) yield opts.stdin;
    })(),
    cwd: dir,
    env: { CATEGORISER_DB: db, ...opts.env },
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

const mock = (...argv: string[]) => cli(["--mock", ...argv]);
const json = <T = any>(o: Out): T => JSON.parse(o.stdout) as T;

async function saveUrl(url = "https://example.com/post", ...extra: string[]): Promise<string> {
  const r = await mock("save", url, "--json", ...extra);
  expect(r.code, r.stderr).toBe(0);
  return json(r).itemId;
}

describe("cli: argument parsing", () => {
  it("resolves one- and two-word commands", () => {
    expect(parseCli(["bulk", "revert", "--model", "m", "--after", "2026-01-01"])).toMatchObject({
      kind: "command",
      command: "bulk revert",
      args: [],
    });
    expect(parseCli(["proposals"])).toMatchObject({ command: "proposals", args: [] });
    expect(parseCli(["proposals", "approve", "x"])).toMatchObject({ command: "proposals approve", args: ["x"] });
    expect(parseCli(["--mock", "save", "-"])).toMatchObject({ command: "save", args: ["-"], values: { mock: true } });
  });

  it("returns help with no args or -h", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["save", "-h"])).toEqual({ kind: "help", command: "save" });
  });

  it("rejects unknown commands, options from other commands, and wrong arity", () => {
    expect(() => parseCli(["nope"])).toThrow(UsageError);
    expect(() => parseCli(["show", "id", "--apply"])).toThrow(UsageError);
    expect(() => parseCli(["confirm", "id"])).toThrow(UsageError);
    expect(() => parseCli(["show"])).toThrow(UsageError);
  });

  it("expands bare dates to midnight UTC and passes ISO datetimes through", () => {
    expect(parseAfter("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(parseAfter("2026-10-01T05:00:00+02:00")).toBe("2026-10-01T05:00:00+02:00");
    expect(() => parseAfter("2026-13-45")).toThrow(UsageError);
  });

  it("strips terminal control and bidi characters from printed strings", () => {
    expect(clean("ok\u001b[31mred\u001b]0;title\u0007\u202eevil\u200b")).toBe("ok[31mred]0;titleevil");
  });
});

describe("cli: exit codes and errors", () => {
  it("prints help and exits 0", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("bulk unconfirm");
  });

  it("exits 2 on usage errors", async () => {
    expect((await cli(["nope"])).code).toBe(2);
    expect((await mock("bulk", "revert", "--after", "2026-01-01")).stderr).toContain("--model is required");
    expect((await mock("bulk", "accept", "--project", "p", "--min", "high")).code).toBe(2);
    expect((await mock("confirm", randomUUID(), "colour")).code).toBe(2);
  });

  it("refuses a real provider under --mock", async () => {
    const r = await mock("--provider", "bedrock", "health");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--mock only works");
  });

  it("reports eval and serve as not implemented", async () => {
    const r = await mock("eval", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error.code).toBe("not_implemented");
  });

  it("reports CategoriserError codes; validation errors name paths, not values", async () => {
    const r = await mock("bulk", "revert", "--model", "mock", "--after", "yesterday-ish");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error [validation]");
    expect(r.stderr).toContain("afterDate");
    expect(r.stderr).not.toContain("yesterday-ish");
  });
});

describe("cli: save and show (--mock, no network)", () => {
  it("saves and processes a URL without calling fetch", async () => {
    const r = await mock("save", "https://github.com/vercel/next.js", "--project", "webapp", "--json");
    expect(r.code, r.stderr).toBe(0);
    const out = json(r);
    expect(out).toMatchObject({ type: "github", source: "github", queued: false, processed: { extraction: "unavailable", suggest: "ok" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    const show = json((await mock("show", out.itemId, "--json")));
    expect(show.status).toBe("processed");
    expect(show.fields.project).toMatchObject({ by: "rule", value: [{ project: "webapp", score: 0.9 }] });
    expect(show.fields.oneLineSummary).toMatchObject({ state: "suggested", by: "model", model: "mock" });
  });

  it("human show lists every field with provenance", async () => {
    const id = await saveUrl();
    const r = await mock("show", id);
    expect(r.code).toBe(0);
    for (const name of ["type", "source", "project", "tags", "oneLineSummary", "draftWhySaved", "staleness"]) {
      expect(r.stdout).toMatch(new RegExp(`^${name}\\s`, "m"));
    }
    expect(r.stdout).toContain("[suggested · rule · 1.00]");
  });

  it("--no-process leaves the item pending until `process`", async () => {
    const id = await saveUrl("https://example.com/later", "--no-process");
    expect(json(await mock("show", id, "--json")).status).toBe("pending");
    expect((await mock("process", id)).code).toBe(0);
    expect(json(await mock("show", id, "--json")).status).toBe("processed");
  });

  it("saves a note from stdin and a text file as bare notes", async () => {
    const empty = await mock("save", "-");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("stdin was empty");

    const r = await cli(["--mock", "save", "-", "--json"], { stdin: "notes on react security tooling\n" });
    expect(r.code, r.stderr).toBe(0);
    expect(json(r)).toMatchObject({ type: "note", source: "manual" });

    writeFileSync(join(dir, "idea.md"), "# idea\nchess engine in rust");
    const f = await mock("save", "idea.md", "--json");
    expect(f.code, f.stderr).toBe(0);
    expect(json(f).type).toBe("note");
  });

  it("rejects missing files, unsupported types and non-http schemes", async () => {
    expect((await mock("save", "missing.pdf")).stderr).toContain("no such file");
    writeFileSync(join(dir, "x.exe"), "MZ");
    expect((await mock("save", "x.exe")).stderr).toContain("unsupported file type");
    expect((await mock("save", "ftp://example.com/x")).stderr).toContain("only http(s)");
  });

  it("--local-only is stored and still works offline", async () => {
    const id = await saveUrl("https://example.com/private", "--local-only");
    const show = json(await mock("show", id, "--json"));
    expect(show.item.localOnly).toBe(true);
    expect(show.extraction.status).toBe("skipped");
  });

  it("scopes items by --user", async () => {
    const id = await saveUrl();
    const r = await mock("--user", "someone-else", "show", id);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error [not_found]");
  });

  it("--verbose logs events without user content", async () => {
    const note = "remember the launch codes for project bluebird";
    const r = await cli(["--mock", "--verbose", "save", "-"], { stdin: note });
    expect(r.code).toBe(0);
    const events = r.stderr.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(["save", "extract", "redact", "suggest", "route"]));
    expect(r.stderr).not.toContain("bluebird");
  });
});

describe("cli: confirm and undo", () => {
  it("confirms via toConfirmed, narrows the project, and undo restores the suggestion", async () => {
    const id = await saveUrl("https://example.com/a", "--project", "webapp");
    const before = json(await mock("show", id, "--json")).fields.project;

    const c = await mock("confirm", id, "project", "--json");
    expect(c.code, c.stderr).toBe(0);
    const result = json(c);
    expect(result.undoable).toBe(true);
    const after = json(await mock("show", id, "--json")).fields.project;
    expect(after).toMatchObject({ state: "confirmed", by: "user", value: [{ project: "webapp" }] });
    expect(after.confidence).toBeUndefined();

    expect(json(await mock("confirm", id, "project", "--json")).affected).toEqual([]);
    expect((await mock("confirm", id, "project")).stdout).toContain("already confirmed");

    const u = await mock("undo", result.opId);
    expect(u.code, u.stderr).toBe(0);
    expect(json(await mock("show", id, "--json")).fields.project).toEqual(before);
    expect((await mock("undo", result.opId)).stderr).toContain("error [already_undone]");
  });

  it("keeps model provenance on a confirmed model suggestion", async () => {
    const id = await saveUrl();
    expect((await mock("confirm", id, "oneLineSummary")).code).toBe(0);
    expect(json(await mock("show", id, "--json")).fields.oneLineSummary).toMatchObject({
      state: "confirmed",
      by: "user",
      model: "mock",
      modelVersion: "mock-v1",
    });
  });

  it("refuses to confirm an empty value and unknown items", async () => {
    const id = await saveUrl("https://example.com/no-project");
    const r = await mock("confirm", id, "project");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error [invalid_state]");
    expect((await mock("confirm", randomUUID(), "tags")).stderr).toContain("error [not_found]");
  });

  it("a confirmed field survives `process`", async () => {
    const id = await saveUrl();
    await mock("confirm", id, "draftWhySaved");
    const p = json(await mock("process", id, "--json"));
    expect(p.keptUserFields).toContain("draftWhySaved");
  });
});

describe("cli: bulk ops", () => {
  it("unconfirm is a dry run unless --apply, then revert removes the suggestions", async () => {
    const id = await saveUrl();
    await mock("confirm", id, "oneLineSummary");

    const dry = await mock("bulk", "unconfirm", "--model", "mock", "--after", "2000-01-01");
    expect(dry.stdout).toContain("would change 1 field(s)");
    expect(dry.stdout).toContain("--apply");
    expect(json(await mock("show", id, "--json")).fields.oneLineSummary.state).toBe("confirmed");

    const applied = json(await mock("bulk", "unconfirm", "--model", "mock", "--after", "2000-01-01", "--apply", "--json"));
    expect(applied).toMatchObject({ dryRun: false, undoable: true });
    expect(json(await mock("show", id, "--json")).fields.oneLineSummary.state).toBe("suggested");

    const revert = json(await mock("bulk", "revert", "--model", "mock", "--after", "2000-01-01", "--fields", "oneLineSummary,draftWhySaved", "--json"));
    expect(revert.affected.map((a: { field: string }) => a.field).sort()).toEqual(["draftWhySaved", "oneLineSummary"]);
    const fields = json(await mock("show", id, "--json")).fields;
    expect(fields.oneLineSummary).toBeUndefined();
    expect(fields.type).toBeDefined();

    expect((await mock("undo", revert.opId)).code).toBe(0);
    expect(json(await mock("show", id, "--json")).fields.oneLineSummary).toBeDefined();
  });

  it("accept confirms confident fields on items whose top project matches", async () => {
    const a = await saveUrl("https://example.com/a", "--project", "webapp");
    const b = await saveUrl("https://example.com/b", "--project", "other");
    const r = json(await mock("bulk", "accept", "--project", "webapp", "--min", "0.9", "--json"));
    expect(r.affected.length).toBeGreaterThan(0);
    expect(new Set(r.affected.map((x: { itemId: string }) => x.itemId))).toEqual(new Set([a]));
    expect(json(await mock("show", b, "--json")).fields.project.state).toBe("suggested");
  });
});

async function seedProposal(tag: string, userId = "local"): Promise<{ id: string; itemId: string }> {
  const storage = new SqliteStorage(db);
  await storage.init();
  const item: RawItem = { id: randomUUID(), userId, url: "https://example.com/p", localOnly: false, visionOptIn: false, savedAt: "2026-10-01T00:00:00.000Z" };
  await storage.saveItem(item);
  const proposal: StoredTagProposal = {
    id: randomUUID(),
    itemId: item.id,
    tag,
    reason: "recurring topic",
    state: "pending",
    by: "model",
    model: "mock",
    modelVersion: "mock-v1",
    at: "2026-10-01T00:00:00.000Z",
  };
  await storage.addTagProposal(userId, proposal);
  await storage.close();
  return { id: proposal.id, itemId: item.id };
}

describe("tag proposals", () => {
  it("cli approve adds the tag and bumps the taxonomy; a second decision is rejected", async () => {
    const before = json(await mock("taxonomy", "--json")).version;
    const p = await seedProposal("rust-lang");
    expect((await mock("proposals")).stdout).toContain("rust-lang");

    const r = await mock("proposals", "approve", p.id);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`taxonomy is now v${before + 1}`);
    const tax = json(await mock("taxonomy", "--json"));
    expect(tax.tags.map((t: { id: string }) => t.id)).toContain("rust-lang");

    expect((await mock("proposals", "reject", p.id)).stderr).toContain("error [invalid_state]");
    expect((await mock("proposals")).stdout).toContain("no tag proposals");
    expect((await mock("proposals", "--state", "approved")).stdout).toContain("rust-lang");
  });

  it("approving a tag that already exists marks it approved without a new version", async () => {
    const storage = new SqliteStorage(db);
    await storage.init();
    const first = await seedProposal("rust-lang");
    const second = await seedProposal("rust-lang");
    const a = await decideTagProposal({ userId: "local", proposalId: first.id, decision: "approve" }, { storage });
    const b = await decideTagProposal({ userId: "local", proposalId: second.id, decision: "approve" }, { storage });
    expect(a.taxonomyChanged).toBe(true);
    expect(b).toMatchObject({ taxonomyChanged: false, taxonomyVersion: a.taxonomyVersion, proposal: { state: "approved" } });
    await storage.close();
  });

  it("reject leaves the taxonomy alone; other users' proposals are not found", async () => {
    const storage = new SqliteStorage(db);
    await storage.init();
    const p = await seedProposal("rust-lang");
    const version = (await storage.getTaxonomy("local")).version;
    await expect(decideTagProposal({ userId: "mallory", proposalId: p.id, decision: "approve" }, { storage })).rejects.toMatchObject({ code: "not_found" });
    const r = await decideTagProposal({ userId: "local", proposalId: p.id, decision: "reject" }, { storage });
    expect(r).toMatchObject({ taxonomyChanged: false, taxonomyVersion: version, proposal: { state: "rejected" } });
    await expect(decideTagProposal({ userId: "local", proposalId: "nope", decision: "reject" }, { storage })).rejects.toBeInstanceOf(CategoriserError);
    await storage.close();
  });
});

describe("cli: taxonomy import and health", () => {
  it("imports only a strictly newer, valid taxonomy", async () => {
    const current = json(await mock("taxonomy", "--json"));
    writeFileSync(join(dir, "same.yaml"), `version: ${current.version}\ntags:\n  - id: chess\n`);
    expect((await mock("taxonomy", "import", "same.yaml")).code).toBe(1);

    writeFileSync(join(dir, "bad.yaml"), `version: ${current.version + 1}\ntags:\n  - id: Not Kebab\n`);
    expect((await mock("taxonomy", "import", "bad.yaml")).stderr).toContain("error [validation]");

    writeFileSync(join(dir, "new.yaml"), `version: ${current.version + 1}\ntags:\n  - id: chess\n  - id: rust-lang\n`);
    const r = await mock("taxonomy", "import", "new.yaml");
    expect(r.code, r.stderr).toBe(0);
    expect(json(await mock("taxonomy", "--json")).tags).toHaveLength(2);
  });

  it("health in --mock is fully offline", async () => {
    const r = await mock("health", "--json");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, provider: { id: "mock" }, sidecar: { state: "mock" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
