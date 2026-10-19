/**
 * Versioned storage schema. `migrate()` walks raw stored JSON from any known version up to
 * STORAGE_SCHEMA_VERSION, then `normalizeAppData()` repairs anything malformed instead of throwing,
 * so a bad field never costs the user their whole sketchbook.
 *
 * History
 *  v1 (pre-release): `projects` instead of `collections`, `fields.project`, `settings.tidy: boolean`.
 *  v2: `collections`, `fields.collection`, `settings.tidy: boolean | null` (null = follow reduced motion).
 */
import {
  FIELD_NAMES,
  ITEM_TYPES,
  SOURCES,
  STORAGE_SCHEMA_VERSION,
  type AppData,
  type Collection,
  type Field,
  type FieldName,
  type Item,
  type ItemFields,
  type Settings,
} from "./types";
import { isTagId } from "./taxonomy";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly version?: number,
    readonly future = false,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

const MIGRATIONS: Record<number, (d: Raw) => Raw> = {
  1: (d) => {
    const items = isObj(d.items) ? d.items : {};
    const nextItems: Raw = {};
    for (const [id, it] of Object.entries(items)) {
      if (!isObj(it)) continue;
      const fields = isObj(it.fields) ? { ...it.fields } : {};
      if ("project" in fields) {
        fields.collection = fields.project;
        delete fields.project;
      }
      nextItems[id] = { ...it, fields };
    }
    const settings = isObj(d.settings) ? { ...d.settings } : {};
    if (settings.tidy === false) settings.tidy = null;
    const { projects, ...rest } = d;
    return { ...rest, items: nextItems, collections: Array.isArray(projects) ? projects : [], settings, schemaVersion: 2 };
  },
};

export function emptyAppData(): AppData {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    items: {},
    collections: [],
    settings: { tidy: null, theme: "system", connectors: {} },
    chat: [],
    jobs: {},
    sampleCleared: false,
  };
}

/** Raw parsed JSON (any version) -> current AppData. Throws MigrationError only for data from the future. */
export function migrate(raw: unknown): { data: AppData; from: number } {
  if (!isObj(raw)) throw new MigrationError("stored data is not an object");
  const from = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
  if (from > STORAGE_SCHEMA_VERSION) {
    throw new MigrationError(`stored data is schema ${from}, this app understands up to ${STORAGE_SCHEMA_VERSION}`, from, true);
  }
  let d: Raw = raw;
  for (let v = from; v < STORAGE_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new MigrationError(`no migration from schema ${v}`, v);
    d = step(d);
  }
  return { data: normalizeAppData(d), from };
}

function normalizeField(name: FieldName, raw: unknown): Field<unknown> | undefined {
  if (!isObj(raw)) return undefined;
  const state = raw.state === "confirmed" ? "confirmed" : "suggested";
  const by = raw.by === "rule" || raw.by === "embedding" || raw.by === "model" || raw.by === "user" ? raw.by : "model";
  const at = str(raw.at) ?? new Date(0).toISOString();
  let value: unknown = raw.value;
  switch (name) {
    case "type":
      if (!ITEM_TYPES.includes(value as never)) return undefined;
      break;
    case "source":
      if (!SOURCES.includes(value as never)) return undefined;
      break;
    case "tags":
      value = Array.isArray(value) ? [...new Set(value.filter(isTagId))].slice(0, 5) : [];
      break;
    case "oneLineSummary":
      if (typeof value !== "string") return undefined;
      value = value.trim().slice(0, 240);
      break;
    case "collection":
      value = typeof value === "string" && value ? value : null;
      break;
  }
  const field: Field<unknown> = { value, state, by, at };
  if (by !== "user") field.confidence = typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;
  if (by === "model") field.model = str(raw.model) ?? "mock-categoriser-v1";
  return field;
}

export function normalizeItem(raw: unknown, collectionIds: Set<string>): Item | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  if (!id) return undefined;
  const createdAt = str(raw.createdAt) ?? new Date().toISOString();
  const fields: Partial<ItemFields> = {};
  const rawFields = isObj(raw.fields) ? raw.fields : {};
  for (const name of FIELD_NAMES) {
    const f = normalizeField(name, rawFields[name]);
    if (!f) continue;
    if (name === "collection" && f.value !== null && !collectionIds.has(f.value as string)) continue;
    (fields as Raw)[name] = f;
  }
  const att = isObj(raw.attachment) ? raw.attachment : undefined;
  const status = raw.status === "ready" || raw.status === "error" || raw.status === "processing" ? raw.status : "pending";
  const origin = raw.origin === "seed" || raw.origin === "idea-lab" || raw.origin === "import" ? raw.origin : "capture";
  const positions: Record<string, { x: number; y: number }> = {};
  if (isObj(raw.positions)) {
    for (const [k, p] of Object.entries(raw.positions)) {
      if (isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y)) positions[k] = { x: p.x as number, y: p.y as number };
    }
  }
  return {
    id,
    createdAt,
    updatedAt: str(raw.updatedAt) ?? createdAt,
    url: str(raw.url),
    title: str(raw.title),
    rawContent: str(raw.rawContent) ?? "",
    whyISavedThis: str(raw.whyISavedThis)?.slice(0, 280) || undefined,
    attachment:
      att && str(att.blobId) && str(att.name)
        ? { blobId: att.blobId as string, name: att.name as string, mime: str(att.mime) ?? "application/octet-stream", bytes: Number(att.bytes) || 0 }
        : undefined,
    fields,
    // A reload mid-categorise leaves items "processing"; reset so the queue picks them up again.
    status: status === "processing" ? "pending" : status,
    error: str(raw.error),
    origin,
    positions: Object.keys(positions).length ? positions : undefined,
    deletedAt: str(raw.deletedAt),
  };
}

export function normalizeAppData(d: Raw): AppData {
  const base = emptyAppData();
  const collections: Collection[] = [];
  const seen = new Set<string>();
  if (Array.isArray(d.collections)) {
    for (const c of d.collections) {
      if (!isObj(c) || !str(c.id) || !str(c.name) || seen.has(c.id as string)) continue;
      seen.add(c.id as string);
      collections.push({
        id: c.id as string,
        name: (c.name as string).slice(0, 60),
        createdAt: str(c.createdAt) ?? new Date().toISOString(),
        origin: c.origin === "seed" || c.origin === "import" ? c.origin : "user",
      });
    }
  }
  const items: Record<string, Item> = {};
  if (isObj(d.items)) {
    for (const raw of Object.values(d.items)) {
      const item = normalizeItem(raw, seen);
      if (item) items[item.id] = item;
    }
  }
  const s = isObj(d.settings) ? d.settings : {};
  const settings: Settings = {
    tidy: typeof s.tidy === "boolean" ? s.tidy : null,
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : "system",
    connectors: {},
  };
  if (isObj(s.connectors)) {
    for (const [k, v] of Object.entries(s.connectors)) {
      if (v === "connected" || v === "not-connected") (settings.connectors as Raw)[k] = v;
    }
  }
  return {
    ...base,
    items,
    collections,
    settings,
    chat: Array.isArray(d.chat) ? (d.chat.filter((m) => isObj(m) && str(m.id) && str(m.text)) as AppData["chat"]) : [],
    jobs: isObj(d.jobs) ? (d.jobs as AppData["jobs"]) : {},
    sampleCleared: d.sampleCleared === true,
  };
}

export const sanitize = normalizeAppData;

