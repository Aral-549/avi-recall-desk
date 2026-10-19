import { randomUUID } from "node:crypto";
import PQueue from "p-queue";
import { detect, type DetectResult } from "./detect/index.js";
import { extract, sidecarHealth, type ExtractDeps } from "./extract/index.js";
import type { Provider, ProviderStatus } from "./providers/index.js";
import { redact } from "./redact/index.js";
import { route, staleness, validateThresholds, type Thresholds } from "./route/index.js";
import {
  CategorisedItemSchema,
  CategoriserError,
  PIPELINE_VERSION,
  RawItemSchema,
  type CategorisedItem,
  type Extraction,
  type ExtractionStatus,
  type Field,
  type FieldName,
  type ItemType,
  type ProjectScore,
  type RawItem,
  type RawItemInput,
  type Redaction,
  type Route,
  type SimilarityResult,
  type Source,
} from "./schemas/index.js";
import { similarity, type Embedder } from "./similarity/index.js";
import type { AnyField, StorageAdapter, StorageHealth, StoredItem } from "./storage/types.js";
import { suggest, type SuggestDeps, type SuggestLogEvent, type SuggestResult } from "./suggest/index.js";
import { TaxonomyIndex } from "./taxonomy/index.js";

export const DEFAULT_CONCURRENCY = 2;
const MAX_CANDIDATE_PROJECTS = 4;
const MAX_PROJECT_RANKING = 3;

type RedactionCounts = Redaction["counts"];

/** Structured log events. Ids, statuses, counts and sizes only; never content or secrets. */
export type PipelineLogEvent =
  | { stage: "save"; itemId: string; status: "saved"; type: ItemType; source: Source }
  | { stage: "extract"; itemId: string; status: ExtractionStatus; bytes: number; code?: string }
  | { stage: "redact"; itemId: string; status: "ok"; counts: RedactionCounts }
  | { stage: "similarity"; itemId: string; status: "ok" | "error"; embeddingModel?: string; projects: number }
  | (SuggestLogEvent & { visionWithheld?: boolean })
  | { stage: "route"; itemId: string; status: Route; review: FieldName[]; keptUserFields: FieldName[] }
  | { stage: "pipeline"; itemId: string; status: "error"; code: string };

export type CategoriserDeps = {
  storage: StorageAdapter;
  embedder: Embedder;
  provider?: Provider | null;
  extract?: ExtractDeps;
  thresholds?: Thresholds;
  concurrency?: number;
  log?: (e: PipelineLogEvent) => void;
  now?: () => Date;
  suggest?: Pick<SuggestDeps, "sleep" | "random" | "retryDelaysMs">;
};

export type SaveInput = Omit<RawItemInput, "id" | "savedAt"> & { id?: string; savedAt?: string };

export type SaveResult = { itemId: string; type: ItemType; source: Source; queued: boolean };

export type ProcessResult = {
  itemId: string;
  route: Route;
  review: FieldName[];
  extraction: ExtractionStatus;
  suggest: SuggestResult["status"];
  keptUserFields: FieldName[];
};

export type ItemView = {
  item: StoredItem;
  extraction: Extraction | null;
  fields: Partial<Record<FieldName, AnyField>>;
  /** `pending` until stages 2-6 have run once; `categorised` is null while pending. */
  status: "pending" | "processed";
  categorised: CategorisedItem | null;
};

export type HealthReport = {
  ok: boolean;
  storage: StorageHealth;
  provider: { id: string; cloud: boolean } & ProviderStatus | { state: "none"; detail: string };
  sidecar: { state: "mock" | "ready" | "unavailable"; mode?: string };
  queue: { size: number; pending: number };
};

export type Categoriser = {
  save(input: SaveInput, opts?: { process?: boolean }): Promise<SaveResult>;
  /** Runs stages 2-6 now (bypassing the queue). Never throws for stage failures. */
  process(userId: string, itemId: string): Promise<ProcessResult>;
  /** Queues stages 2-6. A second call while the item is already queued or running is deduped. */
  enqueue(userId: string, itemId: string): Promise<ProcessResult | null>;
  get(userId: string, itemId: string): Promise<ItemView | null>;
  idle(): Promise<void>;
  health(): Promise<HealthReport>;
};

function issuePaths(err: { issues: Array<{ path: Array<string | number> }> }): string {
  return err.issues.map((i) => i.path.join(".") || "(root)").join(", ");
}

function errorCode(err: unknown): string {
  if (err instanceof CategoriserError) return err.code;
  if (err instanceof Error) return err.name;
  return "unknown";
}

function sumCounts(rs: Redaction[]): RedactionCounts {
  const out: RedactionCounts = { apiKey: 0, token: 0, email: 0, phone: 0, privateUrl: 0, ip: 0 };
  for (const r of rs) for (const k of Object.keys(out) as Array<keyof RedactionCounts>) out[k] += r.counts[k];
  return out;
}

const anyRedacted = (c: RedactionCounts) => Object.values(c).some((n) => n > 0);

const joinText = (...parts: Array<string | undefined>) =>
  parts.map((p) => p?.trim()).filter(Boolean).join("\n\n");

function decodeImage(item: RawItem): { mime: string; bytes: Uint8Array } | undefined {
  if (!item.file || !item.file.mime.toLowerCase().startsWith("image/")) return undefined;
  return { mime: item.file.mime, bytes: new Uint8Array(Buffer.from(item.file.bytes, "base64")) };
}

/**
 * Project field after stages 4-5. Caller's `currentProject` stays a rule field at the top;
 * a model pick only re-orders the similarity ranking (its own confidence is a ranking signal,
 * not truth, so the field carries the pick's similarity score).
 */
function projectField(
  item: RawItem,
  sim: SimilarityResult,
  pick: SuggestResult["projectPick"],
  at: string,
): Field<ProjectScore[]> {
  const others = sim.projects.filter((p) => p.project !== item.currentProject);
  if (item.currentProject) {
    const top = { project: item.currentProject, score: 0.9 };
    return {
      value: [top, ...others].slice(0, MAX_PROJECT_RANKING),
      state: "suggested",
      by: "rule",
      confidence: 0.9,
      at,
    };
  }
  const picked = pick ? sim.projects.find((p) => p.project === pick.project) : undefined;
  if (pick && picked) {
    const ranking = [picked, ...sim.projects.filter((p) => p !== picked)].slice(0, MAX_PROJECT_RANKING);
    return {
      value: ranking,
      state: "suggested",
      by: "model",
      model: pick.model,
      modelVersion: pick.modelVersion,
      confidence: picked.score,
      at,
    };
  }
  return {
    value: sim.projects.slice(0, MAX_PROJECT_RANKING),
    state: "suggested",
    by: "embedding",
    model: sim.embeddingModel,
    confidence: sim.projects[0]?.score ?? 0,
    at,
  };
}

export function createCategoriser(deps: CategoriserDeps): Categoriser {
  const { storage, embedder } = deps;
  const provider = deps.provider ?? null;
  const thresholds = validateThresholds(deps.thresholds ?? {});
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const queue = new PQueue({ concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY });
  const inflight = new Map<string, Promise<ProcessResult | null>>();

  async function process(userId: string, itemId: string): Promise<ProcessResult> {
    const item = await storage.getItem(userId, itemId);
    if (!item) throw new CategoriserError("not_found", "pipeline", "item not found", itemId);
    const detected = detect(item);
    const at = now().toISOString();

    // Stage 2. Misconfiguration is the only thing extract throws; the item still gets categorised.
    let extraction: Extraction;
    let extractCode: string | undefined;
    try {
      extraction = await extract(item, { type: detected.type.value, source: detected.source.value }, {
        ...deps.extract,
        now,
      });
    } catch (err) {
      extractCode = errorCode(err);
      extraction = { status: "error", fetchedAt: at, bytes: 0 };
    }
    await storage.saveExtraction(userId, itemId, extraction);
    log({ stage: "extract", itemId, status: extraction.status, bytes: extraction.bytes, code: extractCode });

    // Stage 3. Everything that can reach a provider or the embedder is redacted first.
    const isBareNote = !item.url && !item.file;
    const rTitle = redact(extraction.title ?? "");
    const rNote = redact(isBareNote ? "" : item.text ?? "");
    const rContent = redact(isBareNote ? item.text ?? "" : joinText(extraction.description, extraction.text));
    const counts = sumCounts([rTitle, rNote, rContent]);
    log({ stage: "redact", itemId, status: "ok", counts });

    // Stage 4.
    let sim: SimilarityResult = { projects: [], similarItems: [], embeddingModel: embedder.model };
    try {
      sim = await similarity({ userId, itemId, text: joinText(rTitle.text, rNote.text, rContent.text) }, { storage, embedder });
      log({ stage: "similarity", itemId, status: "ok", embeddingModel: sim.embeddingModel, projects: sim.projects.length });
    } catch {
      log({ stage: "similarity", itemId, status: "error", projects: 0 });
    }

    // Stage 5. Pixels can't be redacted, so an image whose OCR text contained secrets is never sent.
    const image = decodeImage(item);
    const visionWithheld = Boolean(image && item.visionOptIn && anyRedacted(counts));
    const candidates = [...new Set([...(item.currentProject ? [item.currentProject] : []), ...sim.projects.map((p) => p.project)])]
      .slice(0, MAX_CANDIDATE_PROJECTS);
    const taxonomy = new TaxonomyIndex(await storage.getTaxonomy(userId));
    const suggested = await suggest(
      {
        itemId,
        type: detected.type.value,
        source: detected.source.value,
        host: detected.host,
        userNote: rNote.text || undefined,
        title: rTitle.text || undefined,
        text: rContent.text,
        candidateProjects: candidates,
        project: item.currentProject ?? sim.projects[0]?.project,
        localOnly: item.localOnly,
        visionOptIn: item.visionOptIn,
        image: visionWithheld ? undefined : image,
      },
      {
        ...deps.suggest,
        taxonomy,
        provider,
        now: () => now().toISOString(),
        log: (e) => log(visionWithheld ? { ...e, visionWithheld } : e),
      },
    );

    // Stage 6 inputs. Anything the user has set or confirmed is never overwritten by a re-run.
    const proposed: Partial<Record<FieldName, AnyField>> = {
      project: projectField(item, sim, suggested.projectPick, at),
      tags: suggested.tags,
      oneLineSummary: suggested.oneLineSummary,
      draftWhySaved: suggested.draftWhySaved,
      staleness: staleness({ extraction, savedAt: item.savedAt, now: now() }, at),
    };
    const current = await storage.getFields(userId, itemId);
    const keptUserFields: FieldName[] = [];
    const changes: Array<{ itemId: string; name: FieldName; field: AnyField }> = [];
    for (const [name, field] of Object.entries(proposed) as Array<[FieldName, AnyField]>) {
      if (current[name]?.by === "user") keptUserFields.push(name);
      else changes.push({ itemId, name, field });
    }
    await storage.applyFieldChanges(userId, changes);

    if (suggested.by === "model" && suggested.model && suggested.tagProposals.length) {
      const seen = new Set((await storage.listTagProposals(userId, { itemId })).map((p) => p.tag));
      for (const p of suggested.tagProposals) {
        if (seen.has(p.tag)) continue;
        seen.add(p.tag);
        await storage.addTagProposal(userId, {
          id: randomUUID(),
          itemId,
          tag: p.tag,
          reason: p.reason,
          state: "pending",
          by: "model",
          model: suggested.model,
          modelVersion: suggested.modelVersion,
          at,
        });
      }
    }

    const merged = { ...current, ...Object.fromEntries(changes.map((c) => [c.name, c.field])) };
    const decision = route(merged, thresholds);
    // Written last: the presence of a route is what marks the item as processed.
    await storage.setItemMeta(userId, itemId, { route: decision.route, pipelineVersion: PIPELINE_VERSION });
    log({ stage: "route", itemId, status: decision.route, review: decision.review, keptUserFields });

    return {
      itemId,
      route: decision.route,
      review: decision.review,
      extraction: extraction.status,
      suggest: suggested.status,
      keptUserFields,
    };
  }

  function enqueue(userId: string, itemId: string): Promise<ProcessResult | null> {
    const key = `${userId}\u0000${itemId}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const job = queue
      .add(() => process(userId, itemId))
      .then((r) => r ?? null)
      .catch((err: unknown) => {
        log({ stage: "pipeline", itemId, status: "error", code: errorCode(err) });
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function save(input: SaveInput, opts: { process?: boolean } = {}): Promise<SaveResult> {
    const parsed = RawItemSchema.safeParse({ ...input, id: input.id ?? randomUUID(), savedAt: input.savedAt ?? now().toISOString() });
    if (!parsed.success) {
      throw new CategoriserError("validation", "save", `invalid item: ${issuePaths(parsed.error)}`, input.id);
    }
    const item = parsed.data;
    await storage.saveItem(item);
    const d: DetectResult = detect(item);
    await storage.applyFieldChanges(item.userId, [
      { itemId: item.id, name: "type", field: d.type },
      { itemId: item.id, name: "source", field: d.source },
      ...(d.project ? [{ itemId: item.id, name: "project" as const, field: d.project }] : []),
    ]);
    log({ stage: "save", itemId: item.id, status: "saved", type: d.type.value, source: d.source.value });
    const queued = opts.process !== false;
    if (queued) void enqueue(item.userId, item.id);
    return { itemId: item.id, type: d.type.value, source: d.source.value, queued };
  }

  async function get(userId: string, itemId: string): Promise<ItemView | null> {
    const item = await storage.getItem(userId, itemId);
    if (!item) return null;
    const [extraction, fields, proposals] = await Promise.all([
      storage.getExtraction(userId, itemId),
      storage.getFields(userId, itemId),
      storage.listTagProposals(userId, { itemId }),
    ]);
    if (!item.route) return { item, extraction, fields, status: "pending", categorised: null };
    const parsed = CategorisedItemSchema.safeParse({
      itemId,
      type: fields.type,
      source: fields.source,
      project: fields.project,
      tags: fields.tags,
      oneLineSummary: fields.oneLineSummary,
      draftWhySaved: fields.draftWhySaved,
      staleness: fields.staleness,
      tagProposals: proposals,
      route: item.route,
      pipelineVersion: item.pipelineVersion ?? PIPELINE_VERSION,
    });
    return { item, extraction, fields, status: "processed", categorised: parsed.success ? parsed.data : null };
  }

  async function health(): Promise<HealthReport> {
    const storageHealth = await storage.health().catch((): StorageHealth => ({ ok: false, kind: storage.kind, detail: "health check failed" }));
    let sidecar: HealthReport["sidecar"];
    if (deps.extract?.mock) {
      sidecar = { state: "mock" };
    } else {
      const s = await sidecarHealth({ sidecarUrl: deps.extract?.sidecarUrl, fetchImpl: deps.extract?.fetchImpl ?? fetch }).catch(() => ({ reachable: false as const }));
      sidecar = s.reachable ? { state: "ready", mode: "mode" in s ? s.mode : undefined } : { state: "unavailable" };
    }
    return {
      ok: storageHealth.ok,
      storage: storageHealth,
      provider: provider
        ? { id: provider.id, cloud: provider.cloud, ...provider.status() }
        : { state: "none", detail: "no provider; rule fallback only" },
      sidecar,
      queue: { size: queue.size, pending: queue.pending },
    };
  }

  return { save, process, enqueue, get, idle: () => queue.onIdle(), health };
}
