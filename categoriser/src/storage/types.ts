import type {
  Extraction,
  Field,
  FieldBy,
  FieldName,
  FieldState,
  RawItem,
  Route,
  StoredTagProposal,
} from "../schemas/index.js";
import type { Taxonomy } from "../taxonomy/index.js";

export type AnyField = Field<unknown>;

export type ItemMeta = { route: Route; pipelineVersion: string };

export type StoredItem = RawItem & { route?: Route; pipelineVersion?: string };

export type FieldVersion = AnyField & { versionId: number; current: boolean };

export type CurrentFieldRow = { itemId: string; name: FieldName; field: AnyField };

export type FieldFilter = {
  names?: FieldName[];
  by?: FieldBy;
  state?: FieldState;
  model?: string;
  modelVersion?: string;
  /** Strictly after this ISO datetime, compared on the field's `at`. */
  after?: string;
  itemIds?: string[];
};

export type HistoryEntry = {
  id: number;
  itemId: string;
  field: FieldName;
  from: AnyField | null;
  to: AnyField | null;
  opId?: string;
  at: string;
};

export type WriteOptions = { opId?: string };

export type FieldChange = {
  itemId: string;
  name: FieldName;
  /** `null` clears the field. */
  field: AnyField | null;
  /**
   * Compare-and-set guard. When present, the whole batch aborts with `conflict` unless the
   * current field equals this value (`null` = no current value) at write time.
   */
  expect?: AnyField | null;
};

export type EmbeddingRow = { itemId: string; model: string; vector: number[] };

export type StorageHealth = { ok: boolean; kind: string; detail?: string };

/**
 * Persistence contract. Every method takes `userId` and every query filters by it.
 * Implementations must reject `state:"confirmed"` unless `by:"user"` (AGENTS.md invariant 1)
 * and must never partially apply a multi-row write.
 */
export interface StorageAdapter {
  readonly kind: string;
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<StorageHealth>;

  saveItem(item: RawItem): Promise<void>;
  getItem(userId: string, itemId: string): Promise<StoredItem | null>;
  listItemIds(userId: string): Promise<string[]>;
  setItemMeta(userId: string, itemId: string, meta: ItemMeta): Promise<void>;

  saveExtraction(userId: string, itemId: string, extraction: Extraction): Promise<void>;
  getExtraction(userId: string, itemId: string): Promise<Extraction | null>;

  /** Appends a new current version and an audit row. Returns the version id. */
  writeField(userId: string, itemId: string, name: FieldName, field: AnyField, opts?: WriteOptions): Promise<number>;
  /** Marks the field as having no current value and audits it. No-op if already empty. */
  clearField(userId: string, itemId: string, name: FieldName, opts?: WriteOptions): Promise<void>;
  /** Atomically applies several writes/clears; all succeed or none do (including `expect` guards). */
  applyFieldChanges(userId: string, changes: FieldChange[], opts?: WriteOptions): Promise<void>;
  getFields(userId: string, itemId: string): Promise<Partial<Record<FieldName, AnyField>>>;
  getFieldVersions(userId: string, itemId: string, name: FieldName): Promise<FieldVersion[]>;
  listCurrentFields(userId: string, filter?: FieldFilter): Promise<CurrentFieldRow[]>;
  getHistoryByOp(userId: string, opId: string): Promise<HistoryEntry[]>;

  getTaxonomy(userId: string): Promise<Taxonomy>;
  /** Rejects unless `taxonomy.version` is greater than the stored version. */
  putTaxonomy(userId: string, taxonomy: Taxonomy): Promise<void>;

  addTagProposal(userId: string, proposal: StoredTagProposal): Promise<void>;
  listTagProposals(userId: string, filter?: { itemId?: string; state?: StoredTagProposal["state"] }): Promise<StoredTagProposal[]>;
  getTagProposal(userId: string, id: string): Promise<StoredTagProposal | null>;
  setTagProposalState(userId: string, id: string, state: "approved" | "rejected"): Promise<void>;

  putEmbedding(userId: string, itemId: string, model: string, vector: number[]): Promise<void>;
  listEmbeddings(userId: string, model: string): Promise<EmbeddingRow[]>;
}
