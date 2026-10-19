import type { HealthReport, ItemView, ProcessResult } from "../pipeline.js";
import { FieldNameSchema, type BulkResult, type ProjectScore, type StoredTagProposal } from "../schemas/index.js";
import type { AnyField } from "../storage/index.js";

// Page-derived strings reach the terminal here. Strip anything that could drive it (ANSI escapes,
// other C0/C1 controls) or visually reorder text (bidi overrides, zero-width).
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
export const clean = (s: string): string => s.replace(UNSAFE, "");

const isProjectList = (v: unknown): v is ProjectScore[] =>
  Array.isArray(v) && v.every((p) => typeof p === "object" && p !== null && "project" in p && "score" in p);

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (isProjectList(value)) {
    return value.length ? value.map((p) => `${clean(p.project)} (${p.score.toFixed(2)})`).join(", ") : "(none)";
  }
  if (Array.isArray(value)) return value.length ? value.map((v) => clean(String(v))).join(", ") : "(none)";
  return clean(String(value));
}

export function formatProvenance(f: AnyField): string {
  const parts: string[] = [f.state, f.by];
  if (f.model) parts.push(f.modelVersion ? `${f.model}/${f.modelVersion}` : f.model);
  if (f.confidence !== undefined) parts.push(f.confidence.toFixed(2));
  return parts.map(clean).join(" · ");
}

export function formatField(f: AnyField | null | undefined): string {
  return f ? `${formatValue(f.value)}  [${formatProvenance(f)}]` : "(none)";
}

function table(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

export function formatItem(view: ItemView, proposals: StoredTagProposal[]): string {
  const { item, extraction, fields } = view;
  const input = item.url ? clean(item.url) : item.file ? `${item.file.mime} file${item.file.name ? ` ${clean(item.file.name)}` : ""}` : "note";
  const rows: Array<[string, string]> = [
    ["id", item.id],
    ["input", input],
    ["saved", item.savedAt],
    ["status", view.status === "processed" ? `processed, route ${item.route}` : "pending"],
  ];
  if (item.localOnly) rows.push(["local-only", "yes"]);
  if (extraction) {
    const title = extraction.title ? `, "${clean(extraction.title)}"` : "";
    rows.push(["extraction", `${extraction.status}, ${extraction.bytes} bytes${title}`]);
  }
  for (const name of FieldNameSchema.options) rows.push([name, formatField(fields[name])]);
  let out = table(rows);
  if (proposals.length) {
    out += "\n\ntag proposals:\n" + proposals.map((p) => `  ${p.id}  ${p.tag} (${p.state}) ${clean(p.reason)}`).join("\n");
  }
  return out;
}

/** JSON view of an item without the base64 file payload. */
export function itemJson(view: ItemView, proposals: StoredTagProposal[]) {
  const { file, ...item } = view.item;
  return {
    ...view,
    item: file ? { ...item, file: { mime: file.mime, name: file.name, bytes: Math.floor((file.bytes.length * 3) / 4) } } : item,
    tagProposals: proposals,
  };
}

export function formatProcess(r: ProcessResult): string {
  const review = r.review.length ? ` (review: ${r.review.join(", ")})` : "";
  const kept = r.keptUserFields.length ? `, kept your ${r.keptUserFields.join(", ")}` : "";
  return `route ${r.route}${review}; extraction ${r.extraction}; suggestions ${r.suggest}${kept}`;
}

export function formatBulk(op: string, r: BulkResult): string {
  const items = new Set(r.affected.map((a) => a.itemId)).size;
  const verb = r.dryRun ? "would change" : "changed";
  const head = `${op}: ${verb} ${r.affected.length} field(s) on ${items} item(s)`;
  const lines = r.affected.map(
    (a) => `  ${a.itemId}  ${a.field}: ${formatField(a.from as AnyField | null)}  ->  ${formatField(a.to as AnyField | null)}`,
  );
  const tail = r.dryRun
    ? r.affected.length ? "dry run; nothing written. Re-run with --apply to write." : "dry run; nothing to do."
    : r.undoable ? `op ${r.opId}; undo with: categoriser undo ${r.opId}` : "nothing to undo.";
  return [head, ...lines, tail].join("\n");
}

export function formatHealth(h: HealthReport): string {
  const provider = "id" in h.provider ? `${h.provider.id} ${h.provider.state} (${clean(h.provider.detail)})` : `none (${h.provider.detail})`;
  return table([
    ["ok", String(h.ok)],
    ["storage", `${h.storage.kind} ${h.storage.ok ? "ok" : "down"}${h.storage.detail ? ` (${clean(h.storage.detail)})` : ""}`],
    ["provider", provider],
    ["sidecar", h.sidecar.state + (h.sidecar.mode ? ` (${h.sidecar.mode})` : "")],
  ]);
}

export function formatProposals(ps: StoredTagProposal[]): string {
  if (!ps.length) return "no tag proposals.";
  return ps.map((p) => `${p.id}  ${p.tag.padEnd(20)}  ${p.state.padEnd(8)}  item ${p.itemId}  ${clean(p.reason)}`).join("\n");
}
