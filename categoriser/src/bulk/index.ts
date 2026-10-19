import { randomUUID } from "node:crypto";
import type { ZodTypeAny } from "zod";
import {
  BulkAcceptSchema,
  BulkRevertSchema,
  BulkUnconfirmSchema,
  CategoriserError,
  ConfirmFieldSchema,
  FieldNameSchema,
  UndoSchema,
  type ConfirmField,
  type BulkAccept,
  type BulkResult,
  type BulkRevert,
  type BulkUnconfirm,
  type FieldName,
  type ProjectScore,
  type Undo,
} from "../schemas/index.js";
import {
  sameField,
  type AnyField,
  type CurrentFieldRow,
  type FieldChange,
  type FieldFilter,
  type FieldVersion,
  type StorageAdapter,
} from "../storage/index.js";

const STAGE = "bulk";
const ID_CHUNK = 500;

/** Staleness is recomputed on every run; confirming it would freeze it, so accept skips it unless asked. */
export const DEFAULT_ACCEPT_FIELDS: readonly FieldName[] = FieldNameSchema.options.filter((n) => n !== "staleness");

export type BulkDeps = {
  storage: StorageAdapter;
  now?: () => Date;
  newId?: () => string;
  log?: (event: Record<string, unknown>) => void;
};

type Affected = BulkResult["affected"][number];

function parse<T>(schema: ZodTypeAny, input: unknown, op: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new CategoriserError("validation", STAGE, `${op}: invalid input at ${paths}`);
  }
  return result.data as T;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function stripVersion(v: FieldVersion): AnyField {
  const { versionId: _versionId, current: _current, ...field } = v;
  return field;
}

/**
 * The confirmed form of a suggestion: `by:"user"`, origin `model`/`modelVersion` kept as provenance.
 * A project ranking narrows to its top entry, because similarity counts an item toward every
 * project listed in a confirmed project field. Every confirm path (bulk accept, CLI, HTTP) must use this.
 */
export function toConfirmed(field: AnyField, name: FieldName, at: string): AnyField {
  const value = name === "project" && Array.isArray(field.value) ? (field.value as ProjectScore[]).slice(0, 1) : field.value;
  const confirmed: AnyField = { value, state: "confirmed", by: "user", at };
  if (field.model) confirmed.model = field.model;
  if (field.modelVersion) confirmed.modelVersion = field.modelVersion;
  return confirmed;
}

async function listForItems(
  storage: StorageAdapter,
  userId: string,
  itemIds: string[],
  filter: Omit<FieldFilter, "itemIds">,
): Promise<CurrentFieldRow[]> {
  const rows: CurrentFieldRow[] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    rows.push(...(await storage.listCurrentFields(userId, { ...filter, itemIds: itemIds.slice(i, i + ID_CHUNK) })));
  }
  return rows;
}

async function commit(
  deps: BulkDeps,
  userId: string,
  op: string,
  changes: FieldChange[],
  affected: Affected[],
  dryRun: boolean,
): Promise<BulkResult> {
  const opId = (deps.newId ?? randomUUID)();
  if (!dryRun && changes.length > 0) await deps.storage.applyFieldChanges(userId, changes, { opId });
  deps.log?.({ stage: STAGE, op, opId, dryRun, affected: affected.length });
  return { opId, dryRun, affected, undoable: !dryRun && affected.length > 0 };
}

/** Removes current suggestions from `model` made after `afterDate`. Never touches confirmed or user values. */
export async function bulkRevert(input: BulkRevert, deps: BulkDeps): Promise<BulkResult> {
  const req = parse<BulkRevert>(BulkRevertSchema, input, "revert");
  const rows = await deps.storage.listCurrentFields(req.userId, {
    names: req.fields,
    state: "suggested",
    model: req.model,
    modelVersion: req.modelVersion,
    after: req.afterDate,
  });
  const changes: FieldChange[] = [];
  const affected: Affected[] = [];
  for (const row of rows) {
    if (row.field.by === "user") continue;
    changes.push({ itemId: row.itemId, name: row.name, field: null, expect: row.field });
    affected.push({ itemId: row.itemId, field: row.name, from: row.field, to: null });
  }
  return commit(deps, req.userId, "revert", changes, affected, false);
}

/**
 * Opt-in: turns user confirmations of `model` suggestions (suggested after `afterDate`) back into
 * the suggestion they were confirmed from. Dry run by default. Confirmations where the user changed
 * the value are the user's own data and are left alone.
 */
export async function bulkUnconfirm(input: BulkUnconfirm, deps: BulkDeps): Promise<BulkResult> {
  const req = parse<BulkUnconfirm>(BulkUnconfirmSchema, input, "unconfirm");
  const afterMs = Date.parse(req.afterDate);
  const rows = await deps.storage.listCurrentFields(req.userId, {
    names: req.fields,
    state: "confirmed",
    by: "user",
    model: req.model,
    modelVersion: req.modelVersion,
  });
  const changes: FieldChange[] = [];
  const affected: Affected[] = [];
  for (const row of rows) {
    const versions = await deps.storage.getFieldVersions(req.userId, row.itemId, row.name);
    const idx = versions.findIndex((v) => v.current);
    const origin = idx > 0 ? versions[idx - 1] : undefined;
    if (!origin) continue;
    if (origin.state !== "suggested" || origin.by === "user" || origin.model !== req.model) continue;
    if (req.modelVersion !== undefined && origin.modelVersion !== req.modelVersion) continue;
    if (!(Date.parse(origin.at) > afterMs)) continue;
    const restored = stripVersion(origin);
    if (!sameField(toConfirmed(restored, row.name, row.field.at).value, row.field.value)) continue;
    changes.push({ itemId: row.itemId, name: row.name, field: restored, expect: row.field });
    affected.push({ itemId: row.itemId, field: row.name, from: row.field, to: restored });
  }
  return commit(deps, req.userId, "unconfirm", changes, affected, req.dryRun);
}

/**
 * Confirms suggestions on items whose top project is `project`, where the project assignment is
 * already confirmed or meets `minConfidence`, and each field meets `minConfidence` (inclusive).
 */
export async function bulkAccept(input: BulkAccept, deps: BulkDeps): Promise<BulkResult> {
  const req = parse<BulkAccept>(BulkAcceptSchema, input, "accept");
  const target = req.project.trim();
  const projectRows = await deps.storage.listCurrentFields(req.userId, { names: ["project"] });
  const itemIds = projectRows
    .filter((row) => {
      const top = Array.isArray(row.field.value) ? (row.field.value as ProjectScore[])[0] : undefined;
      if (!top || top.project.trim() !== target) return false;
      return row.field.state === "confirmed" || (row.field.confidence ?? 0) >= req.minConfidence;
    })
    .map((row) => row.itemId);

  const names = [...(req.fields ?? DEFAULT_ACCEPT_FIELDS)];
  const rows = itemIds.length && names.length ? await listForItems(deps.storage, req.userId, itemIds, { names, state: "suggested" }) : [];
  const at = (deps.now?.() ?? new Date()).toISOString();
  const changes: FieldChange[] = [];
  const affected: Affected[] = [];
  for (const row of rows) {
    if (row.field.by === "user") continue;
    if ((row.field.confidence ?? 0) < req.minConfidence) continue;
    if (isEmptyValue(row.field.value)) continue;
    const confirmed = toConfirmed(row.field, row.name, at);
    changes.push({ itemId: row.itemId, name: row.name, field: confirmed, expect: row.field });
    affected.push({ itemId: row.itemId, field: row.name, from: row.field, to: confirmed });
  }
  return commit(deps, req.userId, "accept", changes, affected, false);
}

/**
 * Confirms one field as-is via `toConfirmed`. An op with an `opId`, so `undo` reverses it and
 * `bulk unconfirm` can find it. Already confirmed -> no-op (empty `affected`). Missing or empty
 * value -> `invalid_state`: there is nothing to confirm, and a confirmed empty project would
 * freeze the item out of re-ranking.
 */
export async function confirmField(input: ConfirmField, deps: BulkDeps): Promise<BulkResult> {
  const req = parse<ConfirmField>(ConfirmFieldSchema, input, "confirm");
  const item = await deps.storage.getItem(req.userId, req.itemId);
  if (!item) throw new CategoriserError("not_found", STAGE, "item not found", req.itemId);
  const current = (await deps.storage.getFields(req.userId, req.itemId))[req.field];
  if (!current || isEmptyValue(current.value)) {
    throw new CategoriserError("invalid_state", STAGE, `${req.field} has no value to confirm`, req.itemId);
  }
  if (current.state === "confirmed") return commit(deps, req.userId, "confirm", [], [], false);
  const at = (deps.now?.() ?? new Date()).toISOString();
  const confirmed = toConfirmed(current, req.field, at);
  return commit(
    deps,
    req.userId,
    "confirm",
    [{ itemId: req.itemId, name: req.field, field: confirmed, expect: current }],
    [{ itemId: req.itemId, field: req.field, from: current, to: confirmed }],
    false,
  );
}

/**
 * Restores every field an operation touched to its value before the operation, atomically.
 * Fails with `conflict` if any of those fields changed since, and `already_undone` if they are
 * all back at their pre-operation value. The undo is itself an operation and can be undone.
 */
export async function undo(input: Undo, deps: BulkDeps): Promise<BulkResult> {
  const req = parse<Undo>(UndoSchema, input, "undo");
  const entries = await deps.storage.getHistoryByOp(req.userId, req.opId);
  if (entries.length === 0) throw new CategoriserError("not_found", STAGE, "no recorded changes for this operation");

  const groups = new Map<string, { itemId: string; field: FieldName; from: AnyField | null; to: AnyField | null }>();
  for (const e of entries) {
    const key = `${e.itemId}\u0000${e.field}`;
    const group = groups.get(key);
    if (group) group.to = e.to;
    else groups.set(key, { itemId: e.itemId, field: e.field, from: e.from, to: e.to });
  }
  const touched = [...groups.values()].filter((g) => !sameField(g.from, g.to));

  const fieldsByItem = new Map<string, Partial<Record<FieldName, AnyField>>>();
  for (const g of touched) {
    if (!fieldsByItem.has(g.itemId)) fieldsByItem.set(g.itemId, await deps.storage.getFields(req.userId, g.itemId));
  }
  const current = (g: (typeof touched)[number]) => fieldsByItem.get(g.itemId)?.[g.field] ?? null;
  const changed = touched.filter((g) => !sameField(current(g), g.to));
  if (changed.length > 0) {
    if (changed.length === touched.length && touched.every((g) => sameField(current(g), g.from))) {
      throw new CategoriserError("already_undone", STAGE, "operation is already undone");
    }
    throw new CategoriserError("conflict", STAGE, `${changed.length} field(s) changed since the operation; nothing was undone`);
  }

  const changes: FieldChange[] = touched.map((g) => ({ itemId: g.itemId, name: g.field, field: g.from, expect: g.to }));
  const affected: Affected[] = touched.map((g) => ({ itemId: g.itemId, field: g.field, from: g.to, to: g.from }));
  return commit(deps, req.userId, "undo", changes, affected, false);
}
