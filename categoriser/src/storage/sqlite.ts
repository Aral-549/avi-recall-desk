import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  CategoriserError,
  ExtractionSchema,
  FieldNameSchema,
  RawItemSchema,
  RouteSchema,
  StoredTagProposalSchema,
  fieldSchema,
  nowIso,
  type Extraction,
  type FieldName,
  type RawItem,
  type StoredTagProposal,
} from "../schemas/index.js";
import { TaxonomySchema, loadSeedTaxonomy, parseTaxonomy, serializeTaxonomy, type Taxonomy } from "../taxonomy/index.js";
import type {
  AnyField,
  CurrentFieldRow,
  EmbeddingRow,
  FieldChange,
  FieldFilter,
  FieldVersion,
  HistoryEntry,
  ItemMeta,
  StorageAdapter,
  StorageHealth,
  StoredItem,
  WriteOptions,
} from "./types.js";
import { sameField } from "./stable.js";

// Vite (vitest 2) strips the `node:` prefix from `node:sqlite`, which has no un-prefixed alias.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncType;

const STAGE = "storage";
const AnyFieldSchema = fieldSchema(z.unknown());

/** Portable subset (TEXT/INTEGER/REAL, JSON in TEXT) so the Postgres adapter can share it. */
const DDL = `
CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL, id TEXT NOT NULL, raw_json TEXT NOT NULL, saved_at TEXT NOT NULL,
  route TEXT, pipeline_version TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS extractions (
  user_id TEXT NOT NULL, item_id TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL,
  json TEXT NOT NULL, state TEXT NOT NULL, by_ TEXT NOT NULL,
  model TEXT, model_version TEXT, confidence REAL,
  at TEXT NOT NULL, at_ms INTEGER NOT NULL, current INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fields_current ON fields (user_id, item_id, name, current);
CREATE INDEX IF NOT EXISTS fields_model ON fields (user_id, model, current, at_ms);
CREATE TABLE IF NOT EXISTS field_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, item_id TEXT NOT NULL, field TEXT NOT NULL,
  from_json TEXT, to_json TEXT, op_id TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS field_history_op ON field_history (user_id, op_id);
CREATE TABLE IF NOT EXISTS taxonomies (
  user_id TEXT NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (user_id, version)
);
CREATE TABLE IF NOT EXISTS tag_proposals (
  user_id TEXT NOT NULL, id TEXT NOT NULL, item_id TEXT NOT NULL, json TEXT NOT NULL, state TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS embeddings (
  user_id TEXT NOT NULL, item_id TEXT NOT NULL, model TEXT NOT NULL, vector_json TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id, model)
);
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

function validateField(name: FieldName, field: AnyField, itemId: string): AnyField {
  FieldNameSchema.parse(name);
  const parsed = AnyFieldSchema.safeParse(field);
  if (!parsed.success) {
    throw new CategoriserError("invalid_field", STAGE, `field ${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`, itemId);
  }
  if (field.state === "confirmed" && field.by !== "user") {
    throw new CategoriserError("confirm_forbidden", STAGE, `only by:"user" may confirm ${name}`, itemId);
  }
  return parsed.data as AnyField;
}

export class SqliteStorage implements StorageAdapter {
  readonly kind = "sqlite";
  private db: DatabaseSync | null = null;

  constructor(private readonly path = ":memory:") {}

  async init(): Promise<void> {
    if (this.db) return;
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(DDL);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async health(): Promise<StorageHealth> {
    try {
      this.conn.prepare("SELECT 1").get();
      return { ok: true, kind: this.kind };
    } catch (e) {
      return { ok: false, kind: this.kind, detail: (e as Error).message };
    }
  }

  private get conn(): DatabaseSync {
    if (!this.db) throw new CategoriserError("not_initialised", STAGE, "call init() first");
    return this.db;
  }

  private tx<T>(fn: () => T): T {
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.conn.exec("COMMIT");
      return out;
    } catch (e) {
      this.conn.exec("ROLLBACK");
      throw e;
    }
  }

  private assertItem(userId: string, itemId: string): void {
    const row = this.conn.prepare("SELECT 1 FROM items WHERE user_id = ? AND id = ?").get(userId, itemId);
    if (!row) throw new CategoriserError("not_found", STAGE, "item not found", itemId);
  }

  // ---- items ----

  async saveItem(item: RawItem): Promise<void> {
    const valid = RawItemSchema.parse(item);
    try {
      this.conn
        .prepare("INSERT INTO items (user_id, id, raw_json, saved_at) VALUES (?, ?, ?, ?)")
        .run(valid.userId, valid.id, JSON.stringify(valid), valid.savedAt);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) {
        throw new CategoriserError("duplicate", STAGE, "item already exists", valid.id);
      }
      throw e;
    }
  }

  async getItem(userId: string, itemId: string): Promise<StoredItem | null> {
    const row = this.conn
      .prepare("SELECT raw_json, route, pipeline_version FROM items WHERE user_id = ? AND id = ?")
      .get(userId, itemId) as Row | undefined;
    if (!row) return null;
    const raw = JSON.parse(String(row.raw_json)) as RawItem;
    return {
      ...raw,
      ...(row.route ? { route: RouteSchema.parse(row.route) } : {}),
      ...(row.pipeline_version ? { pipelineVersion: String(row.pipeline_version) } : {}),
    };
  }

  async listItemIds(userId: string): Promise<string[]> {
    const rows = this.conn.prepare("SELECT id FROM items WHERE user_id = ? ORDER BY saved_at").all(userId) as Row[];
    return rows.map((r) => String(r.id));
  }

  async setItemMeta(userId: string, itemId: string, meta: ItemMeta): Promise<void> {
    const route = RouteSchema.parse(meta.route);
    const res = this.conn
      .prepare("UPDATE items SET route = ?, pipeline_version = ? WHERE user_id = ? AND id = ?")
      .run(route, meta.pipelineVersion, userId, itemId);
    if (Number(res.changes) === 0) throw new CategoriserError("not_found", STAGE, "item not found", itemId);
  }

  // ---- extractions ----

  async saveExtraction(userId: string, itemId: string, extraction: Extraction): Promise<void> {
    const valid = ExtractionSchema.parse(extraction);
    this.assertItem(userId, itemId);
    this.conn
      .prepare(
        `INSERT INTO extractions (user_id, item_id, json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, item_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
      )
      .run(userId, itemId, JSON.stringify(valid), valid.fetchedAt);
  }

  async getExtraction(userId: string, itemId: string): Promise<Extraction | null> {
    const row = this.conn
      .prepare("SELECT json FROM extractions WHERE user_id = ? AND item_id = ?")
      .get(userId, itemId) as Row | undefined;
    return row ? ExtractionSchema.parse(JSON.parse(String(row.json))) : null;
  }

  // ---- fields ----

  private currentField(userId: string, itemId: string, name: FieldName): AnyField | null {
    const row = this.conn
      .prepare("SELECT json FROM fields WHERE user_id = ? AND item_id = ? AND name = ? AND current = 1")
      .get(userId, itemId, name) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as AnyField) : null;
  }

  private audit(userId: string, itemId: string, name: FieldName, from: AnyField | null, to: AnyField | null, opId?: string): void {
    this.conn
      .prepare("INSERT INTO field_history (user_id, item_id, field, from_json, to_json, op_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, itemId, name, from ? JSON.stringify(from) : null, to ? JSON.stringify(to) : null, opId ?? null, nowIso());
  }

  private writeFieldSync(userId: string, itemId: string, name: FieldName, field: AnyField, opId?: string): number {
    const valid = validateField(name, field, itemId);
    this.assertItem(userId, itemId);
    const prev = this.currentField(userId, itemId, name);
    this.conn.prepare("UPDATE fields SET current = 0 WHERE user_id = ? AND item_id = ? AND name = ? AND current = 1").run(userId, itemId, name);
    const res = this.conn
      .prepare(
        `INSERT INTO fields (user_id, item_id, name, json, state, by_, model, model_version, confidence, at, at_ms, current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        userId, itemId, name, JSON.stringify(valid), valid.state, valid.by,
        valid.model ?? null, valid.modelVersion ?? null, valid.confidence ?? null,
        valid.at, Date.parse(valid.at),
      );
    this.audit(userId, itemId, name, prev, valid, opId);
    return Number(res.lastInsertRowid);
  }

  private clearFieldSync(userId: string, itemId: string, name: FieldName, opId?: string): void {
    FieldNameSchema.parse(name);
    this.assertItem(userId, itemId);
    const prev = this.currentField(userId, itemId, name);
    if (!prev) return;
    this.conn.prepare("UPDATE fields SET current = 0 WHERE user_id = ? AND item_id = ? AND name = ? AND current = 1").run(userId, itemId, name);
    this.audit(userId, itemId, name, prev, null, opId);
  }

  async writeField(userId: string, itemId: string, name: FieldName, field: AnyField, opts: WriteOptions = {}): Promise<number> {
    return this.tx(() => this.writeFieldSync(userId, itemId, name, field, opts.opId));
  }

  async clearField(userId: string, itemId: string, name: FieldName, opts: WriteOptions = {}): Promise<void> {
    this.tx(() => this.clearFieldSync(userId, itemId, name, opts.opId));
  }

  async applyFieldChanges(userId: string, changes: FieldChange[], opts: WriteOptions = {}): Promise<void> {
    this.tx(() => {
      for (const c of changes) {
        if (c.expect !== undefined && !sameField(this.currentField(userId, c.itemId, c.name), c.expect)) {
          throw new CategoriserError("conflict", STAGE, `field ${c.name} changed since it was read`, c.itemId);
        }
        if (c.field) this.writeFieldSync(userId, c.itemId, c.name, c.field, opts.opId);
        else this.clearFieldSync(userId, c.itemId, c.name, opts.opId);
      }
    });
  }

  async getFields(userId: string, itemId: string): Promise<Partial<Record<FieldName, AnyField>>> {
    const rows = this.conn
      .prepare("SELECT name, json FROM fields WHERE user_id = ? AND item_id = ? AND current = 1")
      .all(userId, itemId) as Row[];
    const out: Partial<Record<FieldName, AnyField>> = {};
    for (const r of rows) out[FieldNameSchema.parse(r.name)] = JSON.parse(String(r.json)) as AnyField;
    return out;
  }

  async getFieldVersions(userId: string, itemId: string, name: FieldName): Promise<FieldVersion[]> {
    const rows = this.conn
      .prepare("SELECT id, json, current FROM fields WHERE user_id = ? AND item_id = ? AND name = ? ORDER BY id")
      .all(userId, itemId, name) as Row[];
    return rows.map((r) => ({ ...(JSON.parse(String(r.json)) as AnyField), versionId: Number(r.id), current: Number(r.current) === 1 }));
  }

  async listCurrentFields(userId: string, filter: FieldFilter = {}): Promise<CurrentFieldRow[]> {
    const where = ["user_id = ?", "current = 1"];
    const params: SQLInputValue[] = [userId];
    const inList = (col: string, values: string[]) => {
      where.push(`${col} IN (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    };
    if (filter.names) {
      if (filter.names.length === 0) return [];
      inList("name", filter.names.map((n) => FieldNameSchema.parse(n)));
    }
    if (filter.itemIds) {
      if (filter.itemIds.length === 0) return [];
      inList("item_id", filter.itemIds);
    }
    if (filter.by) { where.push("by_ = ?"); params.push(filter.by); }
    if (filter.state) { where.push("state = ?"); params.push(filter.state); }
    if (filter.model) { where.push("model = ?"); params.push(filter.model); }
    if (filter.modelVersion) { where.push("model_version = ?"); params.push(filter.modelVersion); }
    if (filter.after) {
      const ms = Date.parse(filter.after);
      if (Number.isNaN(ms)) throw new CategoriserError("invalid_filter", STAGE, "after must be an ISO datetime");
      where.push("at_ms > ?");
      params.push(ms);
    }
    const rows = this.conn
      .prepare(`SELECT item_id, name, json FROM fields WHERE ${where.join(" AND ")} ORDER BY item_id, name`)
      .all(...params) as Row[];
    return rows.map((r) => ({
      itemId: String(r.item_id),
      name: FieldNameSchema.parse(r.name),
      field: JSON.parse(String(r.json)) as AnyField,
    }));
  }

  async getHistoryByOp(userId: string, opId: string): Promise<HistoryEntry[]> {
    const rows = this.conn
      .prepare("SELECT id, item_id, field, from_json, to_json, op_id, at FROM field_history WHERE user_id = ? AND op_id = ? ORDER BY id")
      .all(userId, opId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      itemId: String(r.item_id),
      field: FieldNameSchema.parse(r.field),
      from: r.from_json ? (JSON.parse(String(r.from_json)) as AnyField) : null,
      to: r.to_json ? (JSON.parse(String(r.to_json)) as AnyField) : null,
      ...(r.op_id ? { opId: String(r.op_id) } : {}),
      at: String(r.at),
    }));
  }

  // ---- taxonomy ----

  async getTaxonomy(userId: string): Promise<Taxonomy> {
    const row = this.conn
      .prepare("SELECT yaml FROM taxonomies WHERE user_id = ? ORDER BY version DESC LIMIT 1")
      .get(userId) as Row | undefined;
    if (row) return parseTaxonomy(String(row.yaml));
    const seed = loadSeedTaxonomy();
    this.conn
      .prepare("INSERT OR IGNORE INTO taxonomies (user_id, version, yaml, at) VALUES (?, ?, ?, ?)")
      .run(userId, seed.version, serializeTaxonomy(seed), nowIso());
    return seed;
  }

  async putTaxonomy(userId: string, taxonomy: Taxonomy): Promise<void> {
    const valid = TaxonomySchema.parse(taxonomy);
    this.tx(() => {
      const row = this.conn.prepare("SELECT MAX(version) AS v FROM taxonomies WHERE user_id = ?").get(userId) as Row | undefined;
      const current = row?.v == null ? 0 : Number(row.v);
      if (valid.version <= current) {
        throw new CategoriserError("stale_taxonomy", STAGE, `version ${valid.version} must be greater than ${current}`);
      }
      this.conn
        .prepare("INSERT INTO taxonomies (user_id, version, yaml, at) VALUES (?, ?, ?, ?)")
        .run(userId, valid.version, serializeTaxonomy(valid), nowIso());
    });
  }

  // ---- tag proposals ----

  async addTagProposal(userId: string, proposal: StoredTagProposal): Promise<void> {
    const valid = StoredTagProposalSchema.parse(proposal);
    this.assertItem(userId, valid.itemId);
    this.conn
      .prepare("INSERT INTO tag_proposals (user_id, id, item_id, json, state) VALUES (?, ?, ?, ?, ?)")
      .run(userId, valid.id, valid.itemId, JSON.stringify(valid), valid.state);
  }

  async listTagProposals(userId: string, filter: { itemId?: string; state?: StoredTagProposal["state"] } = {}): Promise<StoredTagProposal[]> {
    const where = ["user_id = ?"];
    const params: SQLInputValue[] = [userId];
    if (filter.itemId) { where.push("item_id = ?"); params.push(filter.itemId); }
    if (filter.state) { where.push("state = ?"); params.push(filter.state); }
    const rows = this.conn.prepare(`SELECT json FROM tag_proposals WHERE ${where.join(" AND ")} ORDER BY rowid`).all(...params) as Row[];
    return rows.map((r) => StoredTagProposalSchema.parse(JSON.parse(String(r.json))));
  }

  async getTagProposal(userId: string, id: string): Promise<StoredTagProposal | null> {
    const row = this.conn.prepare("SELECT json FROM tag_proposals WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return row ? StoredTagProposalSchema.parse(JSON.parse(String(row.json))) : null;
  }

  async setTagProposalState(userId: string, id: string, state: "approved" | "rejected"): Promise<void> {
    this.tx(() => {
      const row = this.conn.prepare("SELECT json, state FROM tag_proposals WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
      if (!row) throw new CategoriserError("not_found", STAGE, "tag proposal not found");
      if (row.state !== "pending") throw new CategoriserError("invalid_state", STAGE, `proposal already ${String(row.state)}`);
      const next = StoredTagProposalSchema.parse({ ...JSON.parse(String(row.json)), state });
      this.conn.prepare("UPDATE tag_proposals SET json = ?, state = ? WHERE user_id = ? AND id = ?").run(JSON.stringify(next), state, userId, id);
    });
  }

  // ---- embeddings ----

  async putEmbedding(userId: string, itemId: string, model: string, vector: number[]): Promise<void> {
    if (vector.length === 0 || vector.some((v) => !Number.isFinite(v))) {
      throw new CategoriserError("invalid_embedding", STAGE, "vector must be non-empty and finite", itemId);
    }
    this.assertItem(userId, itemId);
    this.conn
      .prepare(
        `INSERT INTO embeddings (user_id, item_id, model, vector_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, item_id, model) DO UPDATE SET vector_json = excluded.vector_json`,
      )
      .run(userId, itemId, model, JSON.stringify(vector));
  }

  async listEmbeddings(userId: string, model: string): Promise<EmbeddingRow[]> {
    const rows = this.conn
      .prepare("SELECT item_id, model, vector_json FROM embeddings WHERE user_id = ? AND model = ? ORDER BY item_id")
      .all(userId, model) as Row[];
    return rows.map((r) => ({ itemId: String(r.item_id), model: String(r.model), vector: JSON.parse(String(r.vector_json)) as number[] }));
  }
}
