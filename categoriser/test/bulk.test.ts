import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bulkAccept, bulkRevert, bulkUnconfirm, toConfirmed, undo, type BulkDeps } from "../src/bulk/index.js";
import { CategoriserError, type Field, type FieldName, type ProjectScore, type RawItem } from "../src/schemas/index.js";
import { SqliteStorage, type AnyField, type StorageAdapter } from "../src/storage/index.js";

const ALICE = "user-alice";
const BOB = "user-bob";
const BAD_MODEL = "bedrock";
const OTHER_MODEL = "gemini";
const BEFORE = "2026-10-01T00:00:00.000Z";
const CUTOFF = "2026-10-10T00:00:00.000Z";
const AFTER = "2026-10-15T00:00:00.000Z";
const NOW = new Date("2026-10-19T12:00:00.000Z");

let db: SqliteStorage;
let deps: BulkDeps;
let logs: Record<string, unknown>[];

beforeEach(async () => {
  db = new SqliteStorage();
  await db.init();
  logs = [];
  deps = { storage: db, now: () => NOW, log: (e) => logs.push(e) };
});
afterEach(async () => {
  await db.close();
});

async function newItem(userId = ALICE): Promise<string> {
  const item: RawItem = {
    id: randomUUID(),
    userId,
    url: "https://example.com/a",
    localOnly: false,
    visionOptIn: false,
    savedAt: "2026-09-01T00:00:00.000Z",
  };
  await db.saveItem(item);
  return item.id;
}

function suggested<T>(value: T, opts: { model?: string; modelVersion?: string; at?: string; confidence?: number; by?: "model" | "embedding" | "rule" } = {}): Field<T> {
  const by = opts.by ?? "model";
  const f: Field<T> = { value, state: "suggested", by, confidence: opts.confidence ?? 0.9, at: opts.at ?? AFTER };
  if (by !== "rule") f.model = opts.model ?? BAD_MODEL;
  if (opts.modelVersion) f.modelVersion = opts.modelVersion;
  return f;
}

const userValue = <T>(value: T): Field<T> => ({ value, state: "confirmed", by: "user", at: "2026-10-18T00:00:00.000Z" });
const ranking = (...names: string[]): ProjectScore[] => names.map((project, i) => ({ project, score: 0.9 - i * 0.1 }));

async function write(itemId: string, name: FieldName, field: AnyField, userId = ALICE) {
  await db.writeField(userId, itemId, name, field);
}
async function current(itemId: string, name: FieldName, userId = ALICE) {
  return (await db.getFields(userId, itemId))[name] ?? null;
}
async function confirmCurrent(itemId: string, name: FieldName) {
  const f = await current(itemId, name);
  if (!f) throw new Error("no field");
  await write(itemId, name, toConfirmed(f, name, "2026-10-18T00:00:00.000Z"));
}

describe("bulk revert", () => {
  it("removes only current suggestions from the model after the date", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["web-dev"]));
    await write(a, "oneLineSummary", suggested("bad summary"));
    await write(a, "type", suggested("link", { by: "rule" }));
    const old = await newItem();
    await write(old, "tags", suggested(["ai"], { at: BEFORE }));
    const other = await newItem();
    await write(other, "tags", suggested(["ai"], { model: OTHER_MODEL }));
    const confirmed = await newItem();
    await write(confirmed, "tags", suggested(["ai"]));
    await confirmCurrent(confirmed, "tags");
    const bob = await newItem(BOB);
    await write(bob, "tags", suggested(["ai"]), BOB);

    const res = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, deps);

    expect(res.dryRun).toBe(false);
    expect(res.undoable).toBe(true);
    expect(res.affected.map((x) => [x.itemId, x.field]).sort()).toEqual([[a, "oneLineSummary"], [a, "tags"]].sort());
    expect(res.affected.every((x) => x.to === null)).toBe(true);
    expect(await current(a, "tags")).toBeNull();
    expect(await current(a, "oneLineSummary")).toBeNull();
    expect((await current(a, "type"))?.value).toBe("link");
    expect((await current(old, "tags"))?.value).toEqual(["ai"]);
    expect((await current(other, "tags"))?.value).toEqual(["ai"]);
    expect((await current(confirmed, "tags"))?.state).toBe("confirmed");
    expect((await current(bob, "tags", BOB))?.value).toEqual(["ai"]);
    expect((await db.getHistoryByOp(ALICE, res.opId)).length).toBe(2);
  });

  it("honours modelVersion and the fields filter; an empty fields list touches nothing", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["ai"], { modelVersion: "v1" }));
    await write(a, "oneLineSummary", suggested("s", { modelVersion: "v2" }));
    await write(a, "draftWhySaved", suggested("w", { modelVersion: "v1" }));

    const none = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, fields: [] }, deps);
    expect(none.affected).toEqual([]);
    expect(none.undoable).toBe(false);

    const res = await bulkRevert({ userId: ALICE, model: BAD_MODEL, modelVersion: "v1", afterDate: CUTOFF, fields: ["tags"] }, deps);
    expect(res.affected.map((x) => x.field)).toEqual(["tags"]);
    expect(await current(a, "draftWhySaved")).not.toBeNull();
    expect(await current(a, "oneLineSummary")).not.toBeNull();
  });

  it("is strictly after the date", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["ai"], { at: CUTOFF }));
    const res = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, deps);
    expect(res.affected).toEqual([]);
  });

  it("rejects invalid input without echoing values", async () => {
    const err = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: "sk-live-secret-not-a-date" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(CategoriserError);
    expect((err as CategoriserError).code).toBe("validation");
    expect((err as Error).message).toContain("afterDate");
    expect((err as Error).message).not.toContain("sk-live");
    const extra = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, dryRun: true } as never, deps).catch((e) => e);
    expect((extra as CategoriserError).code).toBe("validation");
  });

  it("aborts the whole batch if a field changes between read and write", async () => {
    const a = await newItem();
    const b = await newItem();
    await write(a, "tags", suggested(["ai"]));
    await write(b, "tags", suggested(["ai"]));
    const racing: StorageAdapter = Object.create(db) as StorageAdapter;
    racing.listCurrentFields = async (...args) => {
      const rows = await db.listCurrentFields(...args);
      await db.writeField(ALICE, b, "tags", userValue(["user-picked"]));
      return rows;
    };
    const err = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, { ...deps, storage: racing }).catch((e) => e);
    expect((err as CategoriserError).code).toBe("conflict");
    expect((await current(a, "tags"))?.value).toEqual(["ai"]);
    expect((await current(b, "tags"))?.value).toEqual(["user-picked"]);
  });
});

describe("undo", () => {
  it("restores a revert exactly, refuses to run twice, and can itself be undone", async () => {
    const a = await newItem();
    const original = suggested(["web-dev"], { modelVersion: "v1" });
    await write(a, "tags", original);
    const reverted = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, deps);

    const restored = await undo({ userId: ALICE, opId: reverted.opId }, deps);
    expect(restored.affected).toEqual([{ itemId: a, field: "tags", from: null, to: original }]);
    expect(await current(a, "tags")).toEqual(original);

    const again = await undo({ userId: ALICE, opId: reverted.opId }, deps).catch((e) => e);
    expect((again as CategoriserError).code).toBe("already_undone");

    await undo({ userId: ALICE, opId: restored.opId }, deps);
    expect(await current(a, "tags")).toBeNull();
  });

  it("refuses with conflict and changes nothing if any touched field moved on", async () => {
    const a = await newItem();
    const b = await newItem();
    await write(a, "tags", suggested(["ai"]));
    await write(b, "tags", suggested(["ai"]));
    const reverted = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, deps);
    await write(b, "tags", userValue(["mine"]));

    const err = await undo({ userId: ALICE, opId: reverted.opId }, deps).catch((e) => e);
    expect((err as CategoriserError).code).toBe("conflict");
    expect(await current(a, "tags")).toBeNull();
    expect((await current(b, "tags"))?.value).toEqual(["mine"]);
  });

  it("is scoped to the user and reports unknown ops", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["ai"]));
    const reverted = await bulkRevert({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF }, deps);
    const bob = await undo({ userId: BOB, opId: reverted.opId }, deps).catch((e) => e);
    expect((bob as CategoriserError).code).toBe("not_found");
    expect(await current(a, "tags")).toBeNull();
    const bad = await undo({ userId: ALICE, opId: "not-a-uuid" }, deps).catch((e) => e);
    expect((bad as CategoriserError).code).toBe("validation");
  });
});

describe("bulk unconfirm", () => {
  it("is a dry run by default and writes nothing", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["ai"]));
    await confirmCurrent(a, "tags");
    const before = await db.getFieldVersions(ALICE, a, "tags");

    const res = await bulkUnconfirm({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF } as never, deps);
    expect(res.dryRun).toBe(true);
    expect(res.undoable).toBe(false);
    expect(res.affected).toHaveLength(1);
    expect(await db.getFieldVersions(ALICE, a, "tags")).toEqual(before);
    expect(await db.getHistoryByOp(ALICE, res.opId)).toEqual([]);
  });

  it("restores the suggestion a confirmation came from, and undo re-confirms it", async () => {
    const a = await newItem();
    const suggestion = suggested(ranking("alpha", "beta", "gamma"), { by: "embedding", model: BAD_MODEL });
    await write(a, "project", suggestion);
    await confirmCurrent(a, "project");
    const confirmed = await current(a, "project");
    expect(confirmed?.value).toEqual(ranking("alpha"));

    const res = await bulkUnconfirm({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, dryRun: false }, deps);
    expect(res.affected).toEqual([{ itemId: a, field: "project", from: confirmed, to: suggestion }]);
    expect(await current(a, "project")).toEqual(suggestion);

    await undo({ userId: ALICE, opId: res.opId }, deps);
    expect(await current(a, "project")).toEqual(confirmed);
  });

  it("leaves user-edited values, older suggestions, other models and plain user values alone", async () => {
    const edited = await newItem();
    await write(edited, "tags", suggested(["ai"]));
    await write(edited, "tags", { ...userValue(["ai", "rust"]), model: BAD_MODEL });
    const old = await newItem();
    await write(old, "tags", suggested(["ai"], { at: BEFORE }));
    await confirmCurrent(old, "tags");
    const other = await newItem();
    await write(other, "tags", suggested(["ai"], { model: OTHER_MODEL }));
    await confirmCurrent(other, "tags");
    const typed = await newItem();
    await write(typed, "tags", userValue(["typed"]));

    const res = await bulkUnconfirm({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, dryRun: false }, deps);
    expect(res.affected).toEqual([]);
    expect((await current(old, "tags"))?.state).toBe("confirmed");
  });

  it("never writes a confirmed value that is not by:user", async () => {
    const a = await newItem();
    await write(a, "tags", suggested(["ai"]));
    await confirmCurrent(a, "tags");
    await bulkUnconfirm({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, dryRun: false }, deps);
    const rows = await db.listCurrentFields(ALICE, { state: "confirmed" });
    expect(rows.every((r) => r.field.by === "user")).toBe(true);
  });
});

describe("bulk accept", () => {
  it("confirms confident suggestions on items in the project, keeping provenance", async () => {
    const a = await newItem();
    await write(a, "project", suggested(ranking("alpha", "beta"), { by: "embedding", model: "minilm", confidence: 0.92 }));
    await write(a, "tags", suggested(["ai"], { modelVersion: "v1", confidence: 0.95 }));
    await write(a, "oneLineSummary", suggested("summary", { confidence: 0.5 }));
    await write(a, "staleness", suggested("fresh", { by: "rule", confidence: 0.9 }));
    await write(a, "draftWhySaved", suggested("", { confidence: 0.99 }));

    const res = await bulkAccept({ userId: ALICE, project: " alpha ", minConfidence: 0.9 }, deps);

    expect(res.affected.map((x) => x.field).sort()).toEqual(["project", "tags"]);
    expect(await current(a, "project")).toEqual({
      value: ranking("alpha"), state: "confirmed", by: "user", model: "minilm", at: NOW.toISOString(),
    });
    expect(await current(a, "tags")).toEqual({
      value: ["ai"], state: "confirmed", by: "user", model: BAD_MODEL, modelVersion: "v1", at: NOW.toISOString(),
    });
    expect((await current(a, "oneLineSummary"))?.state).toBe("suggested");
    expect((await current(a, "staleness"))?.state).toBe("suggested");
  });

  it("skips items in other projects or with an unconfident project, but uses already-confirmed projects", async () => {
    const elsewhere = await newItem();
    await write(elsewhere, "project", suggested(ranking("beta", "alpha"), { confidence: 0.99 }));
    await write(elsewhere, "tags", suggested(["ai"]));
    const unsure = await newItem();
    await write(unsure, "project", suggested(ranking("alpha"), { confidence: 0.6 }));
    await write(unsure, "tags", suggested(["ai"]));
    const sure = await newItem();
    await write(sure, "project", userValue(ranking("alpha")));
    await write(sure, "tags", suggested(["ai"]));
    const bob = await newItem(BOB);
    await write(bob, "project", userValue(ranking("alpha")), BOB);
    await write(bob, "tags", suggested(["ai"]), BOB);

    const res = await bulkAccept({ userId: ALICE, project: "alpha", minConfidence: 0.8 }, deps);
    expect(res.affected.map((x) => [x.itemId, x.field])).toEqual([[sure, "tags"]]);
    expect((await current(bob, "tags", BOB))?.state).toBe("suggested");
  });

  it("can be undone, and unconfirm reverses it back to the full ranking", async () => {
    const a = await newItem();
    const suggestion = suggested(ranking("alpha", "beta"), { confidence: 0.95 });
    await write(a, "project", suggestion);
    const accepted = await bulkAccept({ userId: ALICE, project: "alpha", minConfidence: 0.9, fields: ["project"] }, deps);
    await undo({ userId: ALICE, opId: accepted.opId }, deps);
    expect(await current(a, "project")).toEqual(suggestion);

    await bulkAccept({ userId: ALICE, project: "alpha", minConfidence: 0.9, fields: ["project"] }, deps);
    await bulkUnconfirm({ userId: ALICE, model: BAD_MODEL, afterDate: CUTOFF, dryRun: false }, deps);
    expect(await current(a, "project")).toEqual(suggestion);
  });

  it("logs counts only", async () => {
    const a = await newItem();
    await write(a, "project", suggested(ranking("alpha"), { confidence: 0.95 }));
    await write(a, "oneLineSummary", suggested("private summary text", { confidence: 0.95 }));
    await bulkAccept({ userId: ALICE, project: "alpha", minConfidence: 0.9 }, deps);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("private summary");
    expect(logs[0]).toMatchObject({ stage: "bulk", op: "accept", affected: 2, dryRun: false });
  });
});

describe("storage compare-and-set", () => {
  it("rolls back earlier changes in the batch when a later guard fails", async () => {
    const a = await newItem();
    const b = await newItem();
    await write(a, "tags", suggested(["ai"]));
    await write(b, "tags", suggested(["ai"]));
    const err = await db
      .applyFieldChanges(ALICE, [
        { itemId: a, name: "tags", field: null, expect: suggested(["ai"]) },
        { itemId: b, name: "tags", field: null, expect: suggested(["different"]) },
      ])
      .catch((e) => e);
    expect((err as CategoriserError).code).toBe("conflict");
    expect(await current(a, "tags")).not.toBeNull();
    expect(await current(b, "tags")).not.toBeNull();
  });

  it("treats key order as irrelevant and null as 'no current value'", async () => {
    const a = await newItem();
    const f = suggested(["ai"]);
    await write(a, "tags", f);
    const reordered = Object.fromEntries(Object.entries(f).reverse()) as AnyField;
    await db.applyFieldChanges(ALICE, [{ itemId: a, name: "tags", field: null, expect: reordered }]);
    await db.applyFieldChanges(ALICE, [{ itemId: a, name: "tags", field: f, expect: null }]);
    expect(await current(a, "tags")).toEqual(f);
  });
});
