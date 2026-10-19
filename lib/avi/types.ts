/**
 * AVI front-end data contract. Mirrors `categoriser/src/schemas` (Field<T>, ItemType, Source,
 * FieldBy, FieldState) so the real backend can replace the mock adapter without UI changes.
 * Differences from the backend are listed in AGENTS.md ("Schema deltas").
 */
import type { TagId } from "./taxonomy";

/** Storage schema version (localStorage). Bump + add a migration in `migrations.ts`. */
export const STORAGE_SCHEMA_VERSION = 2;
/** Export file schema version (JSON / CSV / Markdown). Independent of storage. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Backend ItemType plus the app-only `file` (generic upload the backend can't type yet). */
export type ItemType = "link" | "github" | "social" | "image" | "note" | "video" | "pdf" | "file";
export const ITEM_TYPES: readonly ItemType[] = ["link", "github", "social", "image", "note", "video", "pdf", "file"];

export type Source = "web" | "github" | "reddit" | "x" | "slack" | "youtube" | "upload" | "manual";
export const SOURCES: readonly Source[] = ["web", "github", "reddit", "x", "slack", "youtube", "upload", "manual"];

/** `embedding` is kept for backend parity; the mock only writes `rule` and `model`. */
export type FieldBy = "rule" | "embedding" | "model" | "user";
export type FieldState = "suggested" | "confirmed";

export interface Field<T> {
  value: T;
  state: FieldState;
  by: FieldBy;
  /** Required when by == "model" (backend rule). */
  model?: string;
  /** 0..1. Required when by != "user" (backend rule). */
  confidence?: number;
  at: string;
}

export interface ItemFields {
  type: Field<ItemType>;
  source: Field<Source>;
  tags: Field<TagId[]>;
  oneLineSummary: Field<string>;
  /** Collection id, or null = Unfiled. Backend name: `project`. */
  collection: Field<string | null>;
}
export type FieldName = keyof ItemFields;
export const FIELD_NAMES: readonly FieldName[] = ["type", "source", "tags", "oneLineSummary", "collection"];
/** Fields a person can reject (type/source are facts derived by rules; they can only be edited). */
export const REJECTABLE_FIELDS: readonly FieldName[] = ["tags", "oneLineSummary", "collection"];

export interface Attachment {
  /** IndexedDB key. */
  blobId: string;
  name: string;
  mime: string;
  bytes: number;
}

export type ItemStatus = "pending" | "processing" | "ready" | "error";
export type ItemOrigin = "capture" | "seed" | "idea-lab" | "import";

export interface Point {
  x: number;
  y: number;
}

export interface Item {
  id: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
  title?: string;
  rawContent: string;
  /** The user's own words. Never written by AI. */
  whyISavedThis?: string;
  attachment?: Attachment;
  fields: Partial<ItemFields>;
  status: ItemStatus;
  error?: string;
  origin: ItemOrigin;
  /** Manually placed board positions per page ("all" | collection id | "unfiled"). Missing = auto-layout. */
  positions?: Record<string, Point>;
  /** Soft delete so undo can restore; purged on next load after PURGE_AFTER_MS. */
  deletedAt?: string;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
  origin: "user" | "seed" | "import";
}

export type ConnectorId = "claude-code" | "gpt" | "codex" | "gemini";
export type ConnectorState = "not-connected" | "connecting" | "connected";

export interface Settings {
  /** null = follow prefers-reduced-motion (Tidy when reduced). */
  tidy: boolean | null;
  theme: "light" | "dark" | "system";
  connectors: Partial<Record<ConnectorId, ConnectorState>>;
}

export type JobStage = "queued" | "searching" | "drafting" | "done";

export interface IdeaCard {
  id: string;
  title: string;
  body: string;
  tags: TagId[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Present on assistant messages that are long-running jobs. */
  jobId?: string;
  ideas?: IdeaCard[];
}

export interface Job {
  id: string;
  prompt: string;
  startedAt: string;
  /** Stage boundaries in ms from start; status is a pure function of elapsed time, so reloads resume. */
  plan: { queued: number; searching: number; drafting: number };
  ideas: IdeaCard[];
  notified: boolean;
  pinned: string[];
}

export interface AppData {
  schemaVersion: number;
  items: Record<string, Item>;
  collections: Collection[];
  settings: Settings;
  chat: ChatMessage[];
  jobs: Record<string, Job>;
  sampleCleared: boolean;
}

export const MAX_TEXT_CHARS = 50_000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PURGE_AFTER_MS = 60 * 60 * 1000;
