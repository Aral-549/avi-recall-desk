"use client";

/**
 * App state. `data` is the persisted AppData (autosaved through the DataStore on every change);
 * everything else is session UI. Every user mutation goes through `commit`, which records an inverse
 * patch so undo can restore exactly what changed, without clobbering unrelated background updates.
 */
import { create } from "zustand";
import { categoriser, CategoriseError, titleFromUrl } from "./categoriser";
import { mapBackendFields, submitToCategoriser, syncReview } from "./backend";
import { getDataStore, StorageError } from "./datastore";
import { draftIdeas, isLongAsk, jobStage, planFor, quickReply } from "./idea-lab";
import { freeSpot, layoutPage, sizeOf, type Rect } from "./layout";
import { buildSeed, emptyData } from "./seed";
import { uuid } from "./seeded";
import type { TagId } from "./taxonomy";
import {
  FIELD_NAMES,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  REJECTABLE_FIELDS,
  type AppData,
  type Collection,
  type ConnectorId,
  type ConnectorState,
  type Field,
  type FieldName,
  type Item,
  type ItemFields,
  type Point,
  type Settings,
} from "./types";

export type Panel = "export" | "review" | "lab" | "connectors" | "command" | "shortcuts" | null;

export interface Toast {
  id: string;
  message: string;
  tone: "info" | "success" | "error";
  action?: { label: string; run: () => void };
  ttl: number;
}

interface Patch {
  items?: Record<string, Item | null>;
  collections?: Collection[];
  sampleCleared?: boolean;
}

interface UndoEntry {
  id: string;
  label: string;
  inverse: Patch;
}

export interface CaptureInput {
  text?: string;
  files?: File[];
  why?: string;
  origin?: Item["origin"];
  /** For pinned ideas: preset title. */
  title?: string;
}

interface State {
  hydrated: boolean;
  data: AppData;
  page: string;
  selectedId: string | null;
  detailId: string | null;
  panel: Panel;
  justCleaned: Record<string, true>;
  toasts: Toast[];
  undoStack: UndoEntry[];
  storageIssue: { kind: StorageError["kind"]; message: string } | null;
  reducedMotion: boolean;
  view: Rect;
  boardCols: number;
  captureFocusNonce: number;

  hydrate(): Promise<void>;
  capture(input: CaptureInput): Promise<string[]>;
  process(id: string): Promise<void>;
  setWhy(id: string, text: string): void;
  editField<K extends FieldName>(id: string, name: K, value: ItemFields[K]["value"]): void;
  acceptField(id: string, name: FieldName): void;
  rejectField(id: string, name: FieldName): void;
  acceptItems(ids: string[]): void;
  rejectItems(ids: string[]): void;
  fileItems(ids: string[], collectionId: string | null): void;
  deleteItems(ids: string[]): void;
  setPositions(page: string, positions: Map<string, Point>, label?: string): void;
  createCollection(name: string): string | null;
  renameCollection(id: string, name: string): void;
  deleteCollection(id: string): void;
  clearSample(): void;
  importItems(items: Item[], collections: Collection[]): { added: number; updated: number; skipped: number };
  setSettings(patch: Partial<Settings>): void;
  setConnector(id: ConnectorId, state: ConnectorState): void;
  sendChat(text: string): void;
  pinIdea(jobId: string, ideaId: string): void;
  tickJobs(): void;
  undo(): void;
  toast(t: Omit<Toast, "id" | "ttl"> & { ttl?: number }): string;
  dismissToast(id: string): void;
  setPage(page: string): void;
  select(id: string | null): void;
  openDetail(id: string | null): void;
  openPanel(p: Panel): void;
  setView(v: Rect, cols: number): void;
  setReducedMotion(v: boolean): void;
  focusCapture(): void;
  clearCleaned(id: string): void;
}

const store = getDataStore;
const nowIso = () => new Date().toISOString();
const inFlight = new Map<string, AbortController>();
let applyingExternal = false;

export const liveItems = (d: AppData) => Object.values(d.items).filter((i) => !i.deletedAt);
export const itemsOnPage = (d: AppData, page: string) =>
  liveItems(d).filter((i) => page === "all" || (page === "unfiled" ? !i.fields.collection?.value : i.fields.collection?.value === page));
export const hasSuggestions = (i: Item) => !i.deletedAt && i.status === "ready" && FIELD_NAMES.some((n) => i.fields[n]?.state === "suggested");
export const isFullyConfirmed = (i: Item) => FIELD_NAMES.every((n) => i.fields[n]?.state === "confirmed");

function applyPatch(data: AppData, patch: Patch): { data: AppData; inverse: Patch } {
  const inverse: Patch = {};
  let items = data.items;
  if (patch.items) {
    items = { ...data.items };
    inverse.items = {};
    for (const [id, next] of Object.entries(patch.items)) {
      inverse.items[id] = data.items[id] ?? null;
      if (next) items[id] = next;
      else delete items[id];
    }
  }
  if (patch.collections) inverse.collections = data.collections;
  if (patch.sampleCleared !== undefined) inverse.sampleCleared = data.sampleCleared;
  return {
    data: {
      ...data,
      items,
      collections: patch.collections ?? data.collections,
      sampleCleared: patch.sampleCleared ?? data.sampleCleared,
    },
    inverse,
  };
}

function userField<T>(value: T): Field<T> {
  return { value, state: "confirmed", by: "user", at: nowIso() };
}

const REJECTED_VALUE: Partial<Record<FieldName, unknown>> = { tags: [], oneLineSummary: "", collection: null };

function looksLikeUrl(s: string): string | null {
  const t = s.trim();
  if (/\s/.test(t)) return null;
  const candidate = /^www\./i.test(t) ? `https://${t}` : t;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const useAvi = create<State>()((set, get) => {
  function commit(label: string, patch: Patch, opts: { toast?: string | false } = {}) {
    const { data, inverse } = applyPatch(get().data, patch);
    const entry: UndoEntry = { id: uuid(), label, inverse };
    set((s) => ({ data, undoStack: [...s.undoStack.slice(-49), entry] }));
    if (opts.toast !== false) {
      get().toast({ message: opts.toast ?? label, tone: "info", action: { label: "Undo", run: () => undoEntry(entry.id) } });
    }
    return entry.id;
  }

  function undoEntry(id: string) {
    const stack = get().undoStack;
    const idx = stack.findIndex((e) => e.id === id);
    if (idx < 0) return;
    // Undo everything after it too, newest first, so patches never apply out of order.
    let data = get().data;
    for (let i = stack.length - 1; i >= idx; i--) data = applyPatch(data, stack[i].inverse).data;
    set({ data, undoStack: stack.slice(0, idx) });
    get().toast({ message: idx === stack.length - 1 ? `Undone: ${stack[idx].label.toLowerCase()}` : "Undone, plus what came after it.", tone: "success" });
    for (const it of liveItems(data)) if (it.status === "pending") void get().process(it.id);
  }

  function mapItems(ids: string[], fn: (it: Item) => Item | null): Record<string, Item> {
    const out: Record<string, Item> = {};
    for (const id of ids) {
      const it = get().data.items[id];
      if (!it || it.deletedAt) continue;
      const next = fn(it);
      if (next && next !== it) out[id] = { ...next, updatedAt: nowIso() };
    }
    return out;
  }

  function placeNew(item: Item, page: string): Item {
    const s = get();
    if (s.data.settings.tidy === true || (s.data.settings.tidy === null && s.reducedMotion) || s.view.w < 640) return item;
    const pageItems = itemsOnPage(s.data, page);
    const rects = [...layoutPage(pageItems, page, s.boardCols).values()];
    const pos = freeSpot(rects, sizeOf(item), s.view);
    return { ...item, positions: { ...item.positions, [page]: pos } };
  }

  return {
    hydrated: false,
    data: emptyData(),
    page: "all",
    selectedId: null,
    detailId: null,
    panel: null,
    justCleaned: {},
    toasts: [],
    undoStack: [],
    storageIssue: null,
    reducedMotion: false,
    view: { x: 0, y: 0, w: 1200, h: 800 },
    boardCols: 4,
    captureFocusNonce: 0,

    async hydrate() {
      if (get().hydrated) return;
      const { data, warnings = [] } = await store().load();
      let next = data ?? buildSeed();
      // Soft-deleted items can't be undone after a reload, so purge them and their files.
      const purged: string[] = [];
      for (const it of Object.values(next.items)) {
        if (it.deletedAt) {
          purged.push(it.id);
          if (it.attachment && !it.attachment.blobId.startsWith("seed:")) void store().deleteBlob(it.attachment.blobId);
        }
      }
      if (purged.length) {
        const items = { ...next.items };
        for (const id of purged) delete items[id];
        next = { ...next, items };
      }
      set({ data: next, hydrated: true });
      for (const w of warnings) get().toast({ message: w, tone: "error", ttl: 12000 });
      for (const it of liveItems(next)) if (it.status === "pending") void get().process(it.id);

      store().subscribe?.(async () => {
        const { data: ext } = await store().load();
        if (!ext) return;
        applyingExternal = true;
        set({ data: ext, undoStack: [] });
        applyingExternal = false;
      });
    },

    async capture(input) {
      const created: Item[] = [];
      const page = get().page;
      const collection = page !== "all" && page !== "unfiled" ? page : null;
      const base = (): Omit<Item, "id" | "rawContent"> => {
        const at = nowIso();
        return {
          createdAt: at,
          updatedAt: at,
          fields: collection ? { collection: userField(collection) } : {},
          status: "pending",
          origin: input.origin ?? "capture",
          whyISavedThis: input.why?.trim() || undefined,
          title: input.title,
        };
      };
      const text = input.text?.trim() ?? "";
      if (text) {
        if (text.length > MAX_TEXT_CHARS) {
          get().toast({ message: `That's ${text.length.toLocaleString()} characters. The page holds ${MAX_TEXT_CHARS.toLocaleString()}. Trim it or save it as a file.`, tone: "error" });
          return [];
        }
        const url = looksLikeUrl(text);
        if (!url && /^(https?:|www\.)/i.test(text) && !/\s/.test(text)) {
          get().toast({ message: "That link looked off, so I kept it as a note.", tone: "info" });
        }
        created.push({ ...base(), id: uuid(), url: url ?? undefined, rawContent: url ? "" : text, title: input.title ?? (url ? titleFromUrl(url) : undefined) });
      }
      for (const file of input.files ?? []) {
        if (file.size > MAX_FILE_BYTES) {
          get().toast({ message: `${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is 10 MB, so it stayed off the page.`, tone: "error" });
          continue;
        }
        if (file.size === 0) {
          get().toast({ message: `${file.name} is empty. Nothing to stick down.`, tone: "error" });
          continue;
        }
        const blobId = uuid();
        try {
          await store().putBlob(blobId, file);
        } catch (e) {
          const quota = e instanceof StorageError && e.kind === "quota";
          get().toast({
            message: quota ? "File storage is full. Export, then clear some files." : `Couldn't keep ${file.name}.`,
            tone: "error",
            action: quota ? { label: "Export", run: () => get().openPanel("export") } : undefined,
          });
          continue;
        }
        created.push({
          ...base(),
          id: uuid(),
          rawContent: "",
          title: file.name,
          attachment: { blobId, name: file.name.slice(0, 255), mime: file.type || "application/octet-stream", bytes: file.size },
        });
      }
      if (!created.length) return [];
      const placed: Record<string, Item> = {};
      for (const it of created) {
        // Place sequentially so a multi-file drop doesn't stack in one spot.
        const withPos = placeNew(it, page);
        placed[it.id] = withPos;
        set((s) => ({ data: { ...s.data, items: { ...s.data.items, [it.id]: withPos } } }));
      }
      // Re-apply as one undoable patch (items already present, so inverse must be "didn't exist").
      const inverse: Patch = { items: Object.fromEntries(created.map((c) => [c.id, null])) };
      const entry: UndoEntry = { id: uuid(), label: created.length === 1 ? "Dumped a scrap" : `Dumped ${created.length} scraps`, inverse };
      set((s) => ({ undoStack: [...s.undoStack.slice(-49), entry] }));
      get().toast({ message: entry.label, tone: "info", action: { label: "Undo", run: () => undoEntry(entry.id) } });
      for (const it of created) void get().process(it.id);
      return created.map((c) => c.id);
    },

    async process(id) {
      const it = get().data.items[id];
      if (!it || it.deletedAt || inFlight.has(id)) return;
      const ctrl = new AbortController();
      inFlight.set(id, ctrl);
      const mark = (patch: Partial<Item>) =>
        set((s) => {
          const cur = s.data.items[id];
          if (!cur) return s;
          return { data: { ...s.data, items: { ...s.data.items, [id]: { ...cur, ...patch } } } };
        });
      mark({ status: "processing", error: undefined });
      const d = get().data;
      const collections = d.collections.map((c) => ({
        collection: c,
        tags: [...new Set(liveItems(d).filter((i) => i.fields.collection?.value === c.id && i.fields.tags?.state === "confirmed").flatMap((i) => i.fields.tags!.value))] as TagId[],
      }));
      try {
        let suggestedFields: Partial<ItemFields>;
        let suggestedTitle: string | undefined;
        if (it.origin === "capture" || it.origin === "idea-lab") {
          const collectionName = it.fields.collection?.value
            ? d.collections.find((c) => c.id === it.fields.collection?.value)?.name
            : undefined;
          const blob = it.attachment ? await store().getBlob(it.attachment.blobId) : undefined;
          const view = await submitToCategoriser(it, collectionName, blob);
          suggestedFields = mapBackendFields(view, d.collections) as Partial<ItemFields>;
          suggestedTitle = view.item.title ?? view.extraction?.title;
        } else {
          const sug = await categoriser.categorise(
            {
              id,
              url: it.url,
              title: it.title,
              rawContent: [it.rawContent, it.whyISavedThis].filter(Boolean).join("\n\n"),
              ...(it.attachment ? { attachment: { name: it.attachment.name, mime: it.attachment.mime } } : {}),
            },
            {
              collections: collections.map(({ collection, tags }) => ({
                id: collection.id,
                name: collection.name,
                tags: Object.fromEntries(tags.map((tag) => [tag, 1])),
              })),
            },
          );
          suggestedFields = sug.fields;
          suggestedTitle = sug.title;
        }
        const cur = get().data.items[id];
        if (!cur || cur.deletedAt) return;
        const fields: Partial<ItemFields> = { ...cur.fields };
        for (const name of FIELD_NAMES) {
          // AI never overwrites a person's decision.
          if (cur.fields[name]?.state === "confirmed") continue;
          (fields as Record<string, unknown>)[name] = suggestedFields[name];
        }
        mark({ fields, title: cur.title ?? suggestedTitle, status: "ready", updatedAt: nowIso() });
        if (cur.origin === "capture" || cur.origin === "idea-lab") set((s) => ({ justCleaned: { ...s.justCleaned, [id]: true } }));
      } catch (e) {
        if (ctrl.signal.aborted) return;
        mark({ status: "error", error: e instanceof CategoriseError ? e.message : "The cleaner tripped. Try again." });
      } finally {
        inFlight.delete(id);
      }
    },

    setWhy(id, text) {
      const items = mapItems([id], (it) => ({ ...it, whyISavedThis: text.trim().slice(0, 280) || undefined }));
      if (Object.keys(items).length) commit("Noted why", { items }, { toast: false });
    },

    editField(id, name, value) {
      const items = mapItems([id], (it) => ({ ...it, fields: { ...it.fields, [name]: userField(value) } }));
      commit("Edited " + labelFor(name), { items });
    },

    acceptField(id, name) {
      const target = get().data.items[id];
      const apply = () => {
        const items = mapItems([id], (it) => {
          const f = it.fields[name];
          if (!f || f.state === "confirmed") return null;
          return { ...it, fields: { ...it.fields, [name]: { ...f, state: "confirmed", by: "user" } } };
        });
        if (Object.keys(items).length) commit("Accepted " + labelFor(name), { items });
      };
      if (target && (target.origin === "capture" || target.origin === "idea-lab") && target.fields[name]?.state === "suggested") {
        void syncReview(id, name, "confirm").then(apply).catch((error: unknown) => {
          get().toast({ message: error instanceof Error ? `Couldn't sync this decision: ${error.message}` : "Couldn't sync this decision.", tone: "error" });
        });
        return;
      }
      apply();
    },

    rejectField(id, name) {
      if (!REJECTABLE_FIELDS.includes(name)) return;
      const target = get().data.items[id];
      const apply = () => {
        const items = mapItems([id], (it) => ({ ...it, fields: { ...it.fields, [name]: userField(REJECTED_VALUE[name]) } }));
        commit("Rejected " + labelFor(name), { items });
      };
      if (target && (target.origin === "capture" || target.origin === "idea-lab") && target.fields[name]?.state === "suggested") {
        void syncReview(id, name, "reject").then(apply).catch((error: unknown) => {
          get().toast({ message: error instanceof Error ? `Couldn't sync this decision: ${error.message}` : "Couldn't sync this decision.", tone: "error" });
        });
        return;
      }
      apply();
    },

    acceptItems(ids) {
      const apply = () => {
        const items = mapItems(ids, (it) => {
          if (!hasSuggestions(it)) return null;
          const fields = { ...it.fields };
          for (const n of FIELD_NAMES) {
            const f = fields[n];
            if (f?.state === "suggested") (fields as Record<string, unknown>)[n] = { ...f, state: "confirmed", by: "user" };
          }
          return { ...it, fields };
        });
        const n = Object.keys(items).length;
        if (n) commit(n === 1 ? "Accepted the suggestions" : `Accepted ${n} scraps`, { items });
      };
      const remote = ids.flatMap((id) => {
        const it = get().data.items[id];
        if (!it || (it.origin !== "capture" && it.origin !== "idea-lab")) return [];
        return FIELD_NAMES.filter((name) => it.fields[name]?.state === "suggested").map((name) => [id, name] as const);
      });
      if (remote.length) {
        void Promise.all(remote.map(([id, name]) => syncReview(id, name, "confirm"))).then(apply).catch((error: unknown) => {
          get().toast({ message: error instanceof Error ? `Couldn't sync these decisions: ${error.message}` : "Couldn't sync these decisions.", tone: "error" });
        });
      } else apply();
    },

    rejectItems(ids) {
      const apply = () => {
        const items = mapItems(ids, (it) => {
          if (!hasSuggestions(it)) return null;
          const fields = { ...it.fields };
          for (const n of FIELD_NAMES) {
            const f = fields[n];
            if (f?.state !== "suggested") continue;
            (fields as Record<string, unknown>)[n] = REJECTABLE_FIELDS.includes(n) ? userField(REJECTED_VALUE[n]) : { ...f, state: "confirmed", by: "user" };
          }
          return { ...it, fields };
        });
        const n = Object.keys(items).length;
        if (n) commit(n === 1 ? "Rejected the suggestions" : `Rejected ${n} scraps`, { items });
      };
      const remote = ids.flatMap((id) => {
        const it = get().data.items[id];
        if (!it || (it.origin !== "capture" && it.origin !== "idea-lab")) return [];
        return FIELD_NAMES.filter((name) => it.fields[name]?.state === "suggested").map((name) => [id, name] as const);
      });
      if (remote.length) {
        void Promise.all(remote.map(([id, name]) => syncReview(id, name, REJECTABLE_FIELDS.includes(name) ? "reject" : "confirm"))).then(apply).catch((error: unknown) => {
          get().toast({ message: error instanceof Error ? `Couldn't sync these decisions: ${error.message}` : "Couldn't sync these decisions.", tone: "error" });
        });
      } else apply();
    },

    fileItems(ids, collectionId) {
      const items = mapItems(ids, (it) => (it.fields.collection?.value === collectionId && it.fields.collection.state === "confirmed" ? null : { ...it, fields: { ...it.fields, collection: userField(collectionId) } }));
      const name = collectionId ? get().data.collections.find((c) => c.id === collectionId)?.name : "Unfiled";
      if (Object.keys(items).length) commit(`Filed under ${name}`, { items });
    },

    deleteItems(ids) {
      const at = nowIso();
      const items = mapItems(ids, (it) => ({ ...it, deletedAt: at }));
      for (const id of Object.keys(items)) {
        inFlight.get(id)?.abort();
        inFlight.delete(id);
      }
      const n = Object.keys(items).length;
      if (!n) return;
      commit(n === 1 ? "Peeled it off" : `Peeled off ${n} scraps`, { items });
      if (get().selectedId && items[get().selectedId!]) set({ selectedId: null });
      if (get().detailId && items[get().detailId!]) set({ detailId: null });
    },

    setPositions(page, positions, label = "Moved a scrap") {
      const items = mapItems([...positions.keys()], (it) => ({ ...it, positions: { ...it.positions, [page]: positions.get(it.id)! } }));
      if (Object.keys(items).length) commit(label, { items }, { toast: false });
    },

    createCollection(name) {
      const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
      if (!clean) return null;
      if (get().data.collections.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
        get().toast({ message: `"${clean}" already exists.`, tone: "error" });
        return null;
      }
      const c: Collection = { id: uuid(), name: clean, createdAt: nowIso(), origin: "user" };
      commit(`Made "${clean}"`, { collections: [...get().data.collections, c] });
      return c.id;
    },

    renameCollection(id, name) {
      const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
      if (!clean) return;
      commit("Renamed a collection", { collections: get().data.collections.map((c) => (c.id === id ? { ...c, name: clean } : c)) });
    },

    deleteCollection(id) {
      const c = get().data.collections.find((x) => x.id === id);
      if (!c) return;
      const members = liveItems(get().data).filter((i) => i.fields.collection?.value === id).map((i) => i.id);
      const items = mapItems(members, (it) => ({ ...it, fields: { ...it.fields, collection: userField<string | null>(null) } }));
      commit(`Tore out "${c.name}"`, { items, collections: get().data.collections.filter((x) => x.id !== id) }, { toast: `Tore out "${c.name}". Its ${members.length} scraps are Unfiled.` });
      if (get().page === id) set({ page: "all" });
    },

    clearSample() {
      const d = get().data;
      const seedItems = Object.values(d.items).filter((i) => i.origin === "seed" && !i.deletedAt);
      const at = nowIso();
      const items: Record<string, Item> = {};
      for (const it of seedItems) items[it.id] = { ...it, deletedAt: at };
      const usedByOthers = new Set(liveItems(d).filter((i) => i.origin !== "seed").map((i) => i.fields.collection?.value));
      const collections = d.collections.filter((c) => c.origin !== "seed" || usedByOthers.has(c.id));
      commit("Cleared the sample data", { items, collections, sampleCleared: true }, { toast: `Cleared ${seedItems.length} sample scraps. Fresh page.` });
      if (!collections.some((c) => c.id === get().page)) set({ page: "all" });
    },

    importItems(incoming, collections) {
      const d = get().data;
      const items: Record<string, Item> = {};
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const it of incoming) {
        const cur = d.items[it.id];
        if (!cur || cur.deletedAt) {
          items[it.id] = it;
          added++;
        } else if (it.updatedAt > cur.updatedAt) {
          items[it.id] = { ...it, positions: cur.positions };
          updated++;
        } else skipped++;
      }
      const known = new Set(d.collections.map((c) => c.id));
      const mergedCollections = [...d.collections, ...collections.filter((c) => !known.has(c.id))];
      if (added + updated > 0 || mergedCollections.length !== d.collections.length) {
        commit("Imported", { items, collections: mergedCollections }, { toast: `Imported ${added} new, ${updated} updated, ${skipped} unchanged.` });
      }
      for (const id of Object.keys(items)) if (items[id].status === "pending") void get().process(id);
      return { added, updated, skipped };
    },

    setSettings(patch) {
      set((s) => ({ data: { ...s.data, settings: { ...s.data.settings, ...patch } } }));
      if (patch.theme) {
        try {
          localStorage.setItem("avi:theme", patch.theme);
        } catch {
          // Theme still applies this session.
        }
      }
    },

    setConnector(id, state) {
      set((s) => ({ data: { ...s.data, settings: { ...s.data.settings, connectors: { ...s.data.settings.connectors, [id]: state } } } }));
    },

    sendChat(text) {
      const prompt = text.trim().slice(0, 500);
      if (!prompt) return;
      const at = nowIso();
      const userMsg = { id: uuid(), role: "user" as const, text: prompt, at };
      if (isLongAsk(prompt)) {
        const jobId = uuid();
        const boardTags = liveItems(get().data).flatMap((i) => (i.fields.tags?.state === "confirmed" ? i.fields.tags.value : []));
        const freq = new Map<TagId, number>();
        for (const t of boardTags) freq.set(t, (freq.get(t) ?? 0) + 1);
        const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
        const job = { id: jobId, prompt, startedAt: at, plan: planFor(prompt), ideas: draftIdeas(prompt, top, jobId), notified: false, pinned: [] };
        set((s) => ({
          data: {
            ...s.data,
            chat: [...s.data.chat, userMsg, { id: uuid(), role: "assistant", text: "On it. This one takes a minute, so it's running as a job.", at, jobId }],
            jobs: { ...s.data.jobs, [jobId]: job },
          },
        }));
      } else {
        set((s) => ({ data: { ...s.data, chat: [...s.data.chat, userMsg] } }));
        setTimeout(() => {
          set((s) => ({ data: { ...s.data, chat: [...s.data.chat, { id: uuid(), role: "assistant", text: quickReply(prompt), at: nowIso() }] } }));
        }, 700);
      }
    },

    pinIdea(jobId, ideaId) {
      const job = get().data.jobs[jobId];
      const idea = job?.ideas.find((i) => i.id === ideaId);
      if (!job || !idea || job.pinned.includes(ideaId)) return;
      set((s) => ({ data: { ...s.data, jobs: { ...s.data.jobs, [jobId]: { ...job, pinned: [...job.pinned, ideaId] } } } }));
      void get().capture({ text: `${idea.title}. ${idea.body}`, origin: "idea-lab", title: idea.title });
    },

    tickJobs() {
      const jobs = get().data.jobs;
      const now = Date.now();
      for (const job of Object.values(jobs)) {
        if (job.notified || jobStage(job, now) !== "done") continue;
        set((s) => ({ data: { ...s.data, jobs: { ...s.data.jobs, [job.id]: { ...job, notified: true } } } }));
        if (get().panel !== "lab") {
          get().toast({ message: `Ready: "${job.prompt.slice(0, 40)}"`, tone: "success", action: { label: "Open", run: () => get().openPanel("lab") }, ttl: 10000 });
        }
      }
    },

    undo() {
      const last = get().undoStack.at(-1);
      if (last) undoEntry(last.id);
      else get().toast({ message: "Nothing to undo. Clean slate.", tone: "info" });
    },

    toast(t) {
      const id = uuid();
      const toast: Toast = { ttl: t.action ? 8000 : 5000, ...t, id };
      set((s) => ({ toasts: [...s.toasts.slice(-3), toast] }));
      return id;
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    setPage(page) {
      set({ page, selectedId: null });
    },
    select(id) {
      set({ selectedId: id });
    },
    openDetail(id) {
      set({ detailId: id });
    },
    openPanel(p) {
      set({ panel: p });
    },
    setView(v, cols) {
      const s = get();
      if (s.view.x === v.x && s.view.y === v.y && s.view.w === v.w && s.view.h === v.h && s.boardCols === cols) return;
      set({ view: v, boardCols: cols });
    },
    setReducedMotion(v) {
      set({ reducedMotion: v });
    },
    focusCapture() {
      set((s) => ({ captureFocusNonce: s.captureFocusNonce + 1 }));
    },
    clearCleaned(id) {
      set((s) => {
        const next = { ...s.justCleaned };
        delete next[id];
        return { justCleaned: next };
      });
    },
  };
});

export function labelFor(name: FieldName) {
  return { type: "type", source: "source", tags: "tags", oneLineSummary: "summary", collection: "collection" }[name];
}

/** Autosave: every data change is written immediately. Quota errors surface once with an export offer. */
if (typeof window !== "undefined") {
  let lastSaved: AppData | null = null;
  useAvi.subscribe((s) => {
    if (!s.hydrated || s.data === lastSaved) return;
    lastSaved = s.data;
    if (applyingExternal) return;
    try {
      getDataStore().save(s.data);
      if (s.storageIssue) useAvi.setState({ storageIssue: null });
    } catch (e) {
      if (e instanceof StorageError && !s.storageIssue) {
        const message = e.kind === "quota" ? "Storage is full, so the last change isn't saved yet. Export a copy, then delete a few big files." : "This browser won't let AVI save. Export before you close the tab.";
        useAvi.setState({ storageIssue: { kind: e.kind, message } });
      }
    }
  });
}

export const effectiveTidy = (s: Pick<State, "data" | "reducedMotion">) => s.data.settings.tidy ?? s.reducedMotion;
