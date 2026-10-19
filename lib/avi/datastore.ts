/**
 * DataStore: the only thing the UI knows about persistence. The browser implementation keeps
 * metadata in localStorage (with a last-good backup) and files in IndexedDB. A backend
 * implementation can replace it without UI changes (see AGENTS.md "DataStore").
 */
import { migrate, MigrationError } from "./migrations";
import type { AppData } from "./types";

export type StorageErrorKind = "quota" | "unavailable" | "future-version";

export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface LoadResult {
  /** null = nothing stored yet (first visit). */
  data: AppData | null;
  migratedFrom?: number;
  /** The primary copy was unreadable and the backup was used (or neither was, and raw text was set aside). */
  recovered?: "backup" | "set-aside";
  warnings?: string[];
}

export interface DataStore {
  load(): Promise<LoadResult>;
  /** Throws StorageError("quota") when the browser refuses the write. Previous saved state is untouched. */
  save(data: AppData): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | undefined>;
  deleteBlob(id: string): Promise<void>;
  /** Fires when another tab saved. */
  subscribe?(onExternalChange: () => void): () => void;
}

export const KEY = "avi:data";
export const BACKUP_KEY = "avi:data:backup";

export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return false;
  const e = err as DOMException;
  return e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014;
}

function parseStored(text: string): LoadResult {
  const { data, from } = migrate(JSON.parse(text));
  return { data, migratedFrom: from !== data.schemaVersion ? from : undefined };
}

/* ---------------- IndexedDB blobs ---------------- */

const DB_NAME = "avi-files";
const STORE = "blobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new StorageError("unavailable", "IndexedDB is not available"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError("unavailable", req.error?.message ?? "IndexedDB failed to open"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    const fail = () => {
      const err = t.error ?? req.error;
      reject(isQuotaError(err) ? new StorageError("quota", "The browser is out of room for files.") : err);
    };
    t.onerror = fail;
    t.onabort = fail;
  });
}

/* ---------------- Browser implementation ---------------- */

export function createBrowserDataStore(storage: Storage = window.localStorage): DataStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());

  return {
    async load() {
      const primary = storage.getItem(KEY);
      if (primary === null) return { data: null };
      try {
        return parseStored(primary);
      } catch (err) {
        // Data from a newer AVI: don't touch it, and don't fall back to an older backup that would overwrite it.
        if (err instanceof MigrationError && err.future) {
          throw new StorageError("future-version", err.message);
        }
        const backup = storage.getItem(BACKUP_KEY);
        if (backup) {
          try {
            return { ...parseStored(backup), recovered: "backup" };
          } catch {
            /* fall through */
          }
        }
        // Never delete what we can't read: park it under a dated key for manual recovery.
        try {
          storage.setItem(`avi:data:unreadable:${Date.now()}`, primary);
        } catch {
          /* quota; leave the original in place */
        }
        return { data: null, recovered: "set-aside" };
      }
    },

    async save(data) {
      const text = JSON.stringify(data);
      const previous = storage.getItem(KEY);
      try {
        storage.setItem(KEY, text);
      } catch (err) {
        if (isQuotaError(err)) throw new StorageError("quota", "The browser is out of room for your sketchbook.");
        throw new StorageError("unavailable", (err as Error).message);
      }
      if (previous && previous !== text) {
        try {
          storage.setItem(BACKUP_KEY, previous);
        } catch {
          // Backup is best-effort. When space is tight, drop it rather than block saving.
          storage.removeItem(BACKUP_KEY);
        }
      }
    },

    async putBlob(id, blob) {
      await tx(await db(), "readwrite", (s) => s.put(blob, id));
    },
    async getBlob(id) {
      return (await tx(await db(), "readonly", (s) => s.get(id))) as Blob | undefined;
    },
    async deleteBlob(id) {
      await tx(await db(), "readwrite", (s) => s.delete(id));
    },

    subscribe(onExternalChange) {
      const handler = (e: StorageEvent) => {
        if (e.key === KEY && e.newValue !== null) onExternalChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}

/** In-memory DataStore for tests, and the fallback when the browser blocks storage entirely. */
export function createMemoryDataStore(initial?: string): DataStore & { raw(): string | null } {
  let text: string | null = initial ?? null;
  const blobs = new Map<string, Blob>();
  return {
    raw: () => text,
    async load() {
      if (text === null) return { data: null };
      return parseStored(text);
    },
    async save(data) {
      text = JSON.stringify(data);
    },
    async putBlob(id, blob) {
      blobs.set(id, blob);
    },
    async getBlob(id) {
      return blobs.get(id);
    },
    async deleteBlob(id) {
      blobs.delete(id);
    },
  };
}

let storeInstance: DataStore | null = null;

export function getDataStore(): DataStore {
  if (storeInstance) return storeInstance;

  const browserStore = typeof window !== "undefined" && typeof window.localStorage !== "undefined"
    ? createBrowserDataStore(window.localStorage)
    : createMemoryDataStore();

  storeInstance = {
    async load(): Promise<LoadResult> {
      if (typeof window !== "undefined") {
        try {
          const res = await fetch("/api/data");
          if (res.ok) {
            const json = await res.json();
            if (json && json.data) {
              void browserStore.save(json.data);
              return { data: json.data, warnings: [] };
            }
          }
        } catch {
          // Fall back to local store
        }
      }
      const localResult = await browserStore.load();
      return {
        ...localResult,
        warnings: localResult.warnings ?? [],
      };
    },

    async save(data: AppData): Promise<void> {
      await browserStore.save(data);
      if (typeof window !== "undefined") {
        try {
          await fetch("/api/data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data }),
          });
        } catch {
          // Local storage remains updated
        }
      }
    },

    putBlob(id: string, blob: Blob): Promise<void> {
      return browserStore.putBlob(id, blob);
    },

    getBlob(id: string): Promise<Blob | undefined> {
      return browserStore.getBlob(id);
    },

    deleteBlob(id: string): Promise<void> {
      return browserStore.deleteBlob(id);
    },

    subscribe(onExternalChange: () => void) {
      return browserStore.subscribe ? browserStore.subscribe(onExternalChange) : () => {};
    },
  };

  return storeInstance;
}
