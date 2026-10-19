import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSeed } from "../avi/seed";
import type { AppData, Collection, Field, FieldName, Item, ItemFields, Settings } from "../avi/types";

const DB_DIR = resolve(process.cwd(), "data");
const DB_PATH = resolve(DB_DIR, "avi.db");

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  initSchema(db);
  dbInstance = db;
  return dbInstance;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      url TEXT,
      title TEXT,
      raw_content TEXT NOT NULL DEFAULT '',
      why_i_saved_this TEXT,
      attachment_json TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      origin TEXT NOT NULL DEFAULT 'capture',
      positions_json TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      state TEXT NOT NULL,
      by_ TEXT NOT NULL,
      model TEXT,
      confidence REAL,
      at TEXT NOT NULL,
      current INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_fields_item ON fields (item_id, name, current);

    CREATE TABLE IF NOT EXISTS field_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'local',
      item_id TEXT NOT NULL,
      field TEXT NOT NULL,
      from_json TEXT,
      to_json TEXT,
      op_id TEXT,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);

  const countRow = db.prepare("SELECT COUNT(*) AS total FROM items").get() as { total: number } | undefined;
  if (!countRow || countRow.total === 0) {
    seedDatabase(db);
  }
}

function seedDatabase(db: DatabaseSync): void {
  const seed = buildSeed();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertColl = db.prepare("INSERT OR REPLACE INTO collections (id, name, created_at, origin) VALUES (?, ?, ?, ?)");
    for (const c of seed.collections) {
      insertColl.run(c.id, c.name, c.createdAt, c.origin);
    }

    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO items (
        id, user_id, created_at, updated_at, url, title, raw_content,
        why_i_saved_this, attachment_json, status, error, origin, positions_json, deleted_at
      ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertField = db.prepare(`
      INSERT INTO fields (
        user_id, item_id, name, value_json, state, by_, model, confidence, at, current
      ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const item of Object.values(seed.items)) {
      insertItem.run(
        item.id,
        item.createdAt,
        item.updatedAt,
        item.url ?? null,
        item.title ?? null,
        item.rawContent,
        item.whyISavedThis ?? null,
        item.attachment ? JSON.stringify(item.attachment) : null,
        item.status,
        item.error ?? null,
        item.origin,
        item.positions ? JSON.stringify(item.positions) : null,
        item.deletedAt ?? null,
      );

      for (const [fieldName, f] of Object.entries(item.fields)) {
        if (!f) continue;
        insertField.run(
          item.id,
          fieldName,
          JSON.stringify(f.value),
          f.state,
          f.by,
          f.model ?? null,
          f.confidence ?? null,
          f.at,
        );
      }
    }

    const insertSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)");
    insertSetting.run("settings", JSON.stringify(seed.settings));
    insertSetting.run("sampleCleared", JSON.stringify(seed.sampleCleared));

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getAppData(): AppData {
  const db = getDb();
  const collRows = db.prepare("SELECT id, name, created_at, origin FROM collections ORDER BY created_at").all() as Array<{
    id: string;
    name: string;
    created_at: string;
    origin: Collection["origin"];
  }>;
  const collections: Collection[] = collRows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    origin: r.origin,
  }));

  const itemRows = db.prepare("SELECT * FROM items WHERE deleted_at IS NULL").all() as Array<{
    id: string;
    created_at: string;
    updated_at: string;
    url: string | null;
    title: string | null;
    raw_content: string;
    why_i_saved_this: string | null;
    attachment_json: string | null;
    status: Item["status"];
    error: string | null;
    origin: Item["origin"];
    positions_json: string | null;
    deleted_at: string | null;
  }>;

  const fieldRows = db.prepare("SELECT item_id, name, value_json, state, by_, model, confidence, at FROM fields WHERE current = 1").all() as Array<{
    item_id: string;
    name: string;
    value_json: string;
    state: Field["state"];
    by_: Field["by"];
    model: string | null;
    confidence: number | null;
    at: string;
  }>;

  const fieldsByItem = new Map<string, Partial<ItemFields>>();
  for (const f of fieldRows) {
    let itemFields = fieldsByItem.get(f.item_id);
    if (!itemFields) {
      itemFields = {};
      fieldsByItem.set(f.item_id, itemFields);
    }
    const parsedValue = JSON.parse(f.value_json);
    const fieldObj: Field<unknown> = {
      value: parsedValue,
      state: f.state,
      by: f.by_,
      at: f.at,
      ...(f.model ? { model: f.model } : {}),
      ...(f.confidence !== null ? { confidence: f.confidence } : {}),
    };
    (itemFields as Record<string, unknown>)[f.name] = fieldObj;
  }

  const items: Record<string, Item> = {};
  for (const r of itemRows) {
    items[r.id] = {
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      url: r.url ?? undefined,
      title: r.title ?? undefined,
      rawContent: r.raw_content,
      whyISavedThis: r.why_i_saved_this ?? undefined,
      attachment: r.attachment_json ? JSON.parse(r.attachment_json) : undefined,
      status: r.status,
      error: r.error ?? undefined,
      origin: r.origin,
      positions: r.positions_json ? JSON.parse(r.positions_json) : undefined,
      deletedAt: r.deleted_at ?? undefined,
      fields: fieldsByItem.get(r.id) ?? {},
    };
  }

  const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key = 'settings'").get() as { value_json: string } | undefined;
  const settings: Settings = settingsRow ? JSON.parse(settingsRow.value_json) : { tidy: null, theme: "system", connectors: {} };

  const sampleClearedRow = db.prepare("SELECT value_json FROM settings WHERE key = 'sampleCleared'").get() as { value_json: string } | undefined;
  const sampleCleared = sampleClearedRow ? JSON.parse(sampleClearedRow.value_json) === true : false;

  return {
    schemaVersion: 2,
    items,
    collections,
    settings,
    chat: [],
    jobs: {},
    sampleCleared,
  };
}

export function saveAppData(data: AppData): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertColl = db.prepare("INSERT OR REPLACE INTO collections (id, name, created_at, origin) VALUES (?, ?, ?, ?)");
    for (const c of data.collections) {
      insertColl.run(c.id, c.name, c.createdAt, c.origin);
    }

    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO items (
        id, user_id, created_at, updated_at, url, title, raw_content,
        why_i_saved_this, attachment_json, status, error, origin, positions_json, deleted_at
      ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const clearCurrentFields = db.prepare("UPDATE fields SET current = 0 WHERE item_id = ? AND name = ? AND current = 1");
    const insertField = db.prepare(`
      INSERT INTO fields (
        user_id, item_id, name, value_json, state, by_, model, confidence, at, current
      ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const item of Object.values(data.items)) {
      insertItem.run(
        item.id,
        item.createdAt,
        item.updatedAt,
        item.url ?? null,
        item.title ?? null,
        item.rawContent,
        item.whyISavedThis ?? null,
        item.attachment ? JSON.stringify(item.attachment) : null,
        item.status,
        item.error ?? null,
        item.origin,
        item.positions ? JSON.stringify(item.positions) : null,
        item.deletedAt ?? null,
      );

      for (const [name, f] of Object.entries(item.fields)) {
        if (!f) continue;
        clearCurrentFields.run(item.id, name);
        insertField.run(
          item.id,
          name,
          JSON.stringify(f.value),
          f.state,
          f.by,
          f.model ?? null,
          f.confidence ?? null,
          f.at,
        );
      }
    }

    const insertSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)");
    insertSetting.run("settings", JSON.stringify(data.settings));
    insertSetting.run("sampleCleared", JSON.stringify(data.sampleCleared));

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function saveItem(item: Item): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT OR REPLACE INTO items (
        id, user_id, created_at, updated_at, url, title, raw_content,
        why_i_saved_this, attachment_json, status, error, origin, positions_json, deleted_at
      ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.createdAt,
      item.updatedAt,
      item.url ?? null,
      item.title ?? null,
      item.rawContent,
      item.whyISavedThis ?? null,
      item.attachment ? JSON.stringify(item.attachment) : null,
      item.status,
      item.error ?? null,
      item.origin,
      item.positions ? JSON.stringify(item.positions) : null,
      item.deletedAt ?? null,
    );

    const clearCurrent = db.prepare("UPDATE fields SET current = 0 WHERE item_id = ? AND name = ? AND current = 1");
    const insertField = db.prepare(`
      INSERT INTO fields (
        user_id, item_id, name, value_json, state, by_, model, confidence, at, current
      ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const [name, f] of Object.entries(item.fields)) {
      if (!f) continue;
      clearCurrent.run(item.id, name);
      insertField.run(
        item.id,
        name,
        JSON.stringify(f.value),
        f.state,
        f.by,
        f.model ?? null,
        f.confidence ?? null,
        f.at,
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function updateItemField(itemId: string, name: FieldName, field: Field<unknown>): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const prev = db.prepare("SELECT json FROM fields WHERE item_id = ? AND name = ? AND current = 1").get(itemId, name) as { json: string } | undefined;
    db.prepare("UPDATE fields SET current = 0 WHERE item_id = ? AND name = ? AND current = 1").run(itemId, name);
    db.prepare(`
      INSERT INTO fields (
        user_id, item_id, name, value_json, state, by_, model, confidence, at, current
      ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      itemId,
      name,
      JSON.stringify(field.value),
      field.state,
      field.by,
      field.model ?? null,
      field.confidence ?? null,
      field.at,
    );

    db.prepare(`
      INSERT INTO field_history (user_id, item_id, field, from_json, to_json, op_id, at)
      VALUES ('local', ?, ?, ?, ?, NULL, ?)
    `).run(
      itemId,
      name,
      prev ? prev.json : null,
      JSON.stringify(field),
      new Date().toISOString(),
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getHealth(): { ok: boolean; database: string; itemCount: number; collectionCount: number; path: string } {
  const db = getDb();
  const items = (db.prepare("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL").get() as { c: number }).c;
  const collections = (db.prepare("SELECT COUNT(*) AS c FROM collections").get() as { c: number }).c;
  return {
    ok: true,
    database: "sqlite",
    itemCount: items,
    collectionCount: collections,
    path: DB_PATH,
  };
}
