/**
 * Export / import. JSON is canonical (full provenance, round-trips); CSV is flat; Markdown ZIP is one .md per
 * item with YAML frontmatter in a folder per collection (Obsidian/Notion-ready). Every format carries
 * schemaVersion + exportedAt. Tags are always taxonomy ids; every item has exactly one collection (or "Unfiled").
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import { categoriseSync } from "./categoriser";
import { sanitize } from "./migrations";
import { TAXONOMY_VERSION } from "./taxonomy";
import {
  EXPORT_SCHEMA_VERSION,
  FIELD_NAMES,
  STORAGE_SCHEMA_VERSION,
  type AppData,
  type Collection,
  type FieldBy,
  type Item,
  type ItemFields,
} from "./types";

export interface ExportOptions {
  /** "all" | collection id | "unfiled" */
  collection: string;
  includeSuggested: boolean;
}

export interface ExportRow {
  id: string;
  type: string;
  source: string;
  url: string;
  title: string;
  rawContent: string;
  oneLineSummary: string;
  tags: string[];
  collection: string;
  whyISavedThis: string;
  status: "suggested" | "confirmed";
  by: FieldBy;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportItem extends ExportRow {
  collectionId: string | null;
  origin: Item["origin"];
  fields: ItemFields;
  positions?: Item["positions"];
  attachment?: { name: string; mime: string; bytes: number; data?: string; missing?: true };
}

export interface ExportDoc {
  app: "avi";
  schemaVersion: number;
  exportedAt: string;
  storageSchemaVersion: number;
  taxonomyVersion: number;
  filters: ExportOptions;
  collections: Pick<Collection, "id" | "name" | "createdAt">[];
  items: ExportItem[];
}

export const CSV_COLUMNS: (keyof ExportRow)[] = [
  "id", "type", "source", "url", "title", "rawContent", "oneLineSummary", "tags", "collection", "whyISavedThis", "status", "by", "confidence", "createdAt", "updatedAt",
];

/** Fills fields the cleaner hasn't written yet (pending/error items) with the rule categoriser's suggestion, so no row is blank. */
function completeFields(item: Item, data: AppData): ItemFields {
  if (FIELD_NAMES.every((n) => item.fields[n])) return item.fields as ItemFields;
  let fallback: ItemFields;
  try {
    const suggestion = categoriseSync(
      {
        id: item.id,
        url: item.url,
        title: item.title,
        rawContent: [item.rawContent, item.whyISavedThis].filter(Boolean).join("\n\n"),
        ...(item.attachment ? { attachment: { name: item.attachment.name, mime: item.attachment.mime } } : {}),
      },
      { collections: [] },
      item.updatedAt,
    ).fields;
    fallback = {
      type: { value: "note", state: "suggested", by: "rule", confidence: 0.3, at: item.updatedAt },
      source: { value: "manual", state: "suggested", by: "rule", confidence: 0.3, at: item.updatedAt },
      tags: { value: [], state: "suggested", by: "rule", confidence: 0.3, at: item.updatedAt },
      oneLineSummary: { value: "Empty scrap.", state: "suggested", by: "rule", confidence: 0.3, at: item.updatedAt },
      collection: { value: null, state: "suggested", by: "rule", confidence: 0.3, at: item.updatedAt },
      ...suggestion,
    } as ItemFields;
  } catch {
    const at = item.updatedAt;
    fallback = {
      type: { value: "note", state: "suggested", by: "rule", confidence: 0.3, at },
      source: { value: "manual", state: "suggested", by: "rule", confidence: 0.3, at },
      tags: { value: [], state: "suggested", by: "rule", confidence: 0.3, at },
      oneLineSummary: { value: "Empty scrap.", state: "suggested", by: "rule", confidence: 0.3, at },
      collection: { value: null, state: "suggested", by: "rule", confidence: 0.3, at },
    };
  }
  void data;
  return { ...fallback, ...item.fields } as ItemFields;
}

export function selectItems(data: AppData, opts: ExportOptions): Item[] {
  return Object.values(data.items)
    .filter((i) => !i.deletedAt)
    .filter((i) => {
      const c = i.fields.collection?.value ?? null;
      if (opts.collection === "all") return true;
      if (opts.collection === "unfiled") return !c;
      return c === opts.collection;
    })
    .filter((i) => opts.includeSuggested || FIELD_NAMES.every((n) => i.fields[n]?.state === "confirmed"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function buildExport(data: AppData, opts: ExportOptions, now = new Date()): ExportDoc {
  const names = new Map(data.collections.map((c) => [c.id, c.name]));
  const items = selectItems(data, opts).map((item): ExportItem => {
    const f = completeFields(item, data);
    const collectionId = f.collection.value && names.has(f.collection.value) ? f.collection.value : null;
    const confirmed = FIELD_NAMES.every((n) => f[n].state === "confirmed");
    return {
      id: item.id,
      type: f.type.value,
      source: f.source.value,
      url: item.url ?? "",
      title: item.title ?? "",
      rawContent: item.rawContent,
      oneLineSummary: f.oneLineSummary.value,
      tags: [...f.tags.value].sort(),
      collection: collectionId ? names.get(collectionId)! : "Unfiled",
      whyISavedThis: item.whyISavedThis ?? "",
      status: confirmed ? "confirmed" : "suggested",
      by: f.oneLineSummary.by,
      confidence: f.oneLineSummary.confidence ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      collectionId,
      origin: item.origin,
      fields: f,
      positions: item.positions,
      attachment: item.attachment ? { name: item.attachment.name, mime: item.attachment.mime, bytes: item.attachment.bytes } : undefined,
    };
  });
  const usedIds = new Set(items.map((i) => i.collectionId));
  return {
    app: "avi",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    filters: opts,
    collections: data.collections.filter((c) => opts.collection === "all" || usedIds.has(c.id)).map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    items,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export type BlobGetter = (blobId: string) => Promise<Blob | null>;

export async function toJSON(doc: ExportDoc, data: AppData, getBlob?: BlobGetter): Promise<string> {
  if (!getBlob) return JSON.stringify(doc, null, 2);
  const items = await Promise.all(
    doc.items.map(async (it) => {
      const att = data.items[it.id]?.attachment;
      if (!it.attachment || !att) return it;
      const blob = att.blobId.startsWith("seed:") ? null : await getBlob(att.blobId);
      return { ...it, attachment: blob ? { ...it.attachment, data: await blobToBase64(blob) } : { ...it.attachment, missing: true as const } };
    }),
  );
  return JSON.stringify({ ...doc, items }, null, 2);
}

/** CSV-injection safe: cells starting with = + - @ tab or CR get a leading apostrophe. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("|") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCSV(doc: ExportDoc): string {
  const meta = `# avi export, schemaVersion=${doc.schemaVersion}, exportedAt=${doc.exportedAt}, taxonomyVersion=${doc.taxonomyVersion}`;
  const lines = [meta, CSV_COLUMNS.join(",")];
  for (const it of doc.items) lines.push(CSV_COLUMNS.map((c) => csvCell(c === "confidence" && it.confidence !== null ? it.confidence.toFixed(2) : it[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function slug(s: string, max = 48) {
  const out = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return out || "untitled";
}

const yamlStr = (s: string) => JSON.stringify(s);

export function toMarkdown(it: ExportItem, attachmentPath?: string): string {
  const fm = [
    "---",
    `id: ${yamlStr(it.id)}`,
    `type: ${it.type}`,
    `source: ${it.source}`,
    `url: ${yamlStr(it.url)}`,
    `title: ${yamlStr(it.title)}`,
    `oneLineSummary: ${yamlStr(it.oneLineSummary)}`,
    `tags: [${it.tags.map(yamlStr).join(", ")}]`,
    `collection: ${yamlStr(it.collection)}`,
    `whyISavedThis: ${yamlStr(it.whyISavedThis)}`,
    `status: ${it.status}`,
    `by: ${it.by}`,
    `confidence: ${it.confidence === null ? "null" : it.confidence.toFixed(2)}`,
    `createdAt: ${yamlStr(it.createdAt)}`,
    `updatedAt: ${yamlStr(it.updatedAt)}`,
    "---",
  ];
  const body = [`# ${it.title || it.oneLineSummary || "Untitled scrap"}`, ""];
  if (it.oneLineSummary) body.push(`> ${it.oneLineSummary}${it.status === "suggested" ? " _(AI-suggested)_" : ""}`, "");
  if (it.whyISavedThis) body.push(`**Why I saved this:** ${it.whyISavedThis}`, "");
  if (it.url) body.push(`<${it.url}>`, "");
  if (it.rawContent) body.push(it.rawContent, "");
  if (attachmentPath) body.push(it.attachment?.mime.startsWith("image/") ? `![${it.attachment.name}](${attachmentPath})` : `[${it.attachment?.name}](${attachmentPath})`, "");
  return [...fm, "", ...body].join("\n");
}

export async function toMarkdownZip(doc: ExportDoc, data: AppData, getBlob: BlobGetter): Promise<Uint8Array> {
  const files: Zippable = {};
  const root = `avi-export-${doc.exportedAt.slice(0, 10)}`;
  const used = new Set<string>();
  const missing: string[] = [];
  for (const it of doc.items) {
    const folder = it.collection === "Unfiled" ? "Unfiled" : slug(it.collection, 60) || "collection";
    let name = `${slug(it.title || it.oneLineSummary)}-${it.id.slice(-6)}`;
    while (used.has(`${folder}/${name}`)) name += "-x";
    used.add(`${folder}/${name}`);
    let attPath: string | undefined;
    const att = data.items[it.id]?.attachment;
    if (att) {
      const blob = att.blobId.startsWith("seed:") ? null : await getBlob(att.blobId);
      if (blob) {
        const fname = `${it.id.slice(-6)}-${att.name.replace(/[^\w.-]+/g, "_")}`;
        files[`${root}/_attachments/${fname}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
        attPath = `../_attachments/${fname}`;
      } else missing.push(att.name);
    }
    files[`${root}/${folder}/${name}.md`] = strToU8(toMarkdown(it, attPath));
  }
  const readme = [
    "# AVI export",
    "",
    `- schemaVersion: ${doc.schemaVersion}`,
    `- exportedAt: ${doc.exportedAt}`,
    `- taxonomyVersion: ${doc.taxonomyVersion}`,
    `- items: ${doc.items.length}`,
    `- filters: collection=${doc.filters.collection}, includeSuggested=${doc.filters.includeSuggested}`,
    "",
    "One folder per collection; items without one are in Unfiled/. Frontmatter fields match the CSV columns.",
    missing.length ? `\nSample screenshots have no image file: ${missing.join(", ")}` : "",
  ].join("\n");
  files[`${root}/README.md`] = strToU8(readme);
  return zipSync(files, { level: 6 });
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ParsedImport {
  items: Item[];
  collections: Collection[];
  blobs: { blobId: string; data: string; mime: string }[];
  warnings: string[];
}

const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

export function parseImport(text: string, existing: Collection[] = []): ParsedImport {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError("That file is over 60 MB. Split it up and try again.");
  let doc: Partial<ExportDoc>;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ImportError("That isn't valid JSON. Only AVI JSON exports can be imported.");
  }
  if (!doc || doc.app !== "avi" || !Array.isArray(doc.items)) throw new ImportError("This JSON isn't an AVI export.");
  if (typeof doc.schemaVersion !== "number" || doc.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new ImportError(`Export schema v${doc.schemaVersion} is newer than this app understands (v${EXPORT_SCHEMA_VERSION}).`);
  }
  const warnings: string[] = [];
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  const idMap = new Map<string, string>();
  const collections: Collection[] = [];
  for (const c of Array.isArray(doc.collections) ? doc.collections : []) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string") continue;
    const same = existing.find((e) => e.id === c.id);
    const dupName = byName.get(c.name.toLowerCase());
    if (same) idMap.set(c.id, same.id);
    else if (dupName) idMap.set(c.id, dupName);
    else {
      idMap.set(c.id, c.id);
      collections.push({ id: c.id, name: c.name.slice(0, 60), createdAt: c.createdAt ?? new Date().toISOString(), origin: "import" });
    }
  }
  const blobs: ParsedImport["blobs"] = [];
  const rawItems: Record<string, unknown> = {};
  for (const it of doc.items as Partial<ExportItem>[]) {
    if (!it || typeof it.id !== "string") continue;
    const fields = { ...(it.fields ?? {}) } as Record<string, { value: unknown }>;
    if (fields.collection && typeof fields.collection.value === "string") fields.collection = { ...fields.collection, value: idMap.get(fields.collection.value) ?? null };
    let attachment: Item["attachment"];
    if (it.attachment?.data) {
      const blobId = `import-${it.id}`;
      blobs.push({ blobId, data: it.attachment.data, mime: it.attachment.mime });
      attachment = { blobId, name: it.attachment.name, mime: it.attachment.mime, bytes: it.attachment.bytes };
    } else if (it.attachment) {
      warnings.push(`${it.attachment.name}: no file inside the export, kept the text only.`);
    }
    rawItems[it.id] = {
      id: it.id,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      url: it.url || undefined,
      title: it.title || undefined,
      rawContent: it.rawContent ?? "",
      whyISavedThis: it.whyISavedThis || undefined,
      attachment,
      fields,
      status: FIELD_NAMES.every((n) => fields[n]) ? "ready" : "pending",
      origin: it.origin,
      positions: it.positions,
    };
  }
  const allCollections = [...existing, ...collections];
  const clean = sanitize({ schemaVersion: STORAGE_SCHEMA_VERSION, items: rawItems, collections: allCollections });
  const items = Object.values(clean.items);
  const dropped = doc.items.length - items.length;
  if (dropped > 0) warnings.push(`${dropped} entr${dropped === 1 ? "y" : "ies"} couldn't be read and were skipped.`);
  return { items, collections, blobs, warnings };
}

export function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function download(name: string, content: BlobPart, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
