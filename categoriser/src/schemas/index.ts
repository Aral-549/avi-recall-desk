import { z } from "zod";

export const PIPELINE_VERSION = "1.1.0";

export const ItemTypeSchema = z.enum(["link", "github", "social", "image", "note", "video", "pdf"]);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const SourceSchema = z.enum(["web", "github", "reddit", "x", "slack", "youtube", "upload", "manual"]);
export type Source = z.infer<typeof SourceSchema>;

export const FieldBySchema = z.enum(["rule", "embedding", "model", "user"]);
export type FieldBy = z.infer<typeof FieldBySchema>;

export const FieldStateSchema = z.enum(["suggested", "confirmed"]);
export type FieldState = z.infer<typeof FieldStateSchema>;

export const RouteSchema = z.enum(["suggest", "review"]);
export type Route = z.infer<typeof RouteSchema>;

export const StalenessSchema = z.enum(["fresh", "aging", "stale", "dead"]);
export type Staleness = z.infer<typeof StalenessSchema>;

export const IsoDate = z.string().datetime({ offset: true });

export function fieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value,
      state: FieldStateSchema,
      by: FieldBySchema,
      model: z.string().optional(),
      modelVersion: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      at: IsoDate,
    })
    .strict()
    .superRefine((f, ctx) => {
      if (f.by !== "user" && f.confidence === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "confidence required when by != user" });
      }
      if (f.by === "model" && !f.model) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "model required when by == model" });
      }
    });
}

export type Field<T> = {
  value: T;
  state: FieldState;
  by: FieldBy;
  model?: string;
  modelVersion?: string;
  confidence?: number;
  at: string;
};

export const MAX_TEXT_CHARS = 50_000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const FileInputSchema = z
  .object({
    mime: z.string().regex(/^(image\/[a-z0-9.+-]+|application\/pdf)$/i, "only image/* or application/pdf"),
    bytes: z.string().min(1),
    name: z.string().max(255).optional(),
  })
  .strict();

export const RawItemSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().min(1),
    url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "http(s) only").optional(),
    text: z.string().max(MAX_TEXT_CHARS).optional(),
    file: FileInputSchema.optional(),
    currentProject: z.string().min(1).max(120).optional(),
    localOnly: z.boolean().default(false),
    visionOptIn: z.boolean().default(false),
    savedAt: IsoDate,
  })
  .strict()
  .refine((i) => i.url || i.text || i.file, { message: "item needs at least one of url, text, file" });
export type RawItem = z.infer<typeof RawItemSchema>;
export type RawItemInput = z.input<typeof RawItemSchema>;

export const ExtractionStatusSchema = z.enum(["ok", "blocked", "timeout", "error", "not_found", "skipped", "unavailable"]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const MAX_STORED_TEXT = 20_000;

export const ExtractionSchema = z
  .object({
    status: ExtractionStatusSchema,
    title: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    text: z.string().max(MAX_STORED_TEXT).optional(),
    image: z.string().url().optional(),
    language: z.string().max(16).optional(),
    publishedAt: IsoDate.optional(),
    meta: z.record(z.union([z.string(), z.number(), z.array(z.string())])).optional(),
    fetchedAt: IsoDate,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;

export const RedactionSchema = z
  .object({
    text: z.string(),
    counts: z
      .object({
        apiKey: z.number().int().nonnegative(),
        token: z.number().int().nonnegative(),
        email: z.number().int().nonnegative(),
        phone: z.number().int().nonnegative(),
        privateUrl: z.number().int().nonnegative(),
        ip: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type Redaction = z.infer<typeof RedactionSchema>;

export const ProjectScoreSchema = z.object({ project: z.string(), score: z.number().min(0).max(1) }).strict();
export type ProjectScore = z.infer<typeof ProjectScoreSchema>;

export const SimilarityResultSchema = z
  .object({
    projects: z.array(ProjectScoreSchema).max(3),
    similarItems: z.array(z.object({ itemId: z.string().uuid(), score: z.number().min(0).max(1) }).strict()).max(5),
    embeddingModel: z.string(),
  })
  .strict();
export type SimilarityResult = z.infer<typeof SimilarityResultSchema>;

export const TagIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/, "kebab-case 2-30 chars");

export const TagProposalSchema = z.object({ tag: TagIdSchema, reason: z.string().min(1).max(140) }).strict();

/** Raw model output. Tag validity against the taxonomy is checked by the suggest stage. */
export const ModelSuggestionSchema = z
  .object({
    tags: z.array(z.string().min(1).max(40)).max(5),
    tagProposals: z.array(TagProposalSchema).max(2),
    oneLineSummary: z.string().min(10).max(160),
    draftWhySaved: z.string().min(10).max(280),
    project: z.string().min(1).max(120).optional(),
    confidence: z
      .object({
        tags: z.number().min(0).max(1),
        summary: z.number().min(0).max(1),
        project: z.number().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict();
export type ModelSuggestion = z.infer<typeof ModelSuggestionSchema>;

export const FieldNameSchema = z.enum(["type", "source", "project", "tags", "oneLineSummary", "draftWhySaved", "staleness"]);
export type FieldName = z.infer<typeof FieldNameSchema>;

export const StoredTagProposalSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid(),
    tag: TagIdSchema,
    reason: z.string().max(140),
    state: z.enum(["pending", "approved", "rejected"]),
    by: z.literal("model"),
    model: z.string(),
    modelVersion: z.string().optional(),
    at: IsoDate,
  })
  .strict();
export type StoredTagProposal = z.infer<typeof StoredTagProposalSchema>;

export const CategorisedItemSchema = z
  .object({
    itemId: z.string().uuid(),
    type: fieldSchema(ItemTypeSchema),
    source: fieldSchema(SourceSchema),
    project: fieldSchema(z.array(ProjectScoreSchema).max(3)),
    tags: fieldSchema(z.array(TagIdSchema).max(5)),
    oneLineSummary: fieldSchema(z.string().max(160)),
    draftWhySaved: fieldSchema(z.string().max(280)),
    staleness: fieldSchema(StalenessSchema),
    tagProposals: z.array(StoredTagProposalSchema),
    route: RouteSchema,
    pipelineVersion: z.string(),
  })
  .strict();
export type CategorisedItem = z.infer<typeof CategorisedItemSchema>;

export const BulkRevertSchema = z
  .object({
    userId: z.string().min(1),
    model: z.string().min(1),
    modelVersion: z.string().optional(),
    afterDate: IsoDate,
    fields: z.array(FieldNameSchema).optional(),
  })
  .strict();
export type BulkRevert = z.infer<typeof BulkRevertSchema>;

export const BulkUnconfirmSchema = BulkRevertSchema.extend({ dryRun: z.boolean().default(true) }).strict();
export type BulkUnconfirm = z.infer<typeof BulkUnconfirmSchema>;

export const BulkAcceptSchema = z
  .object({
    userId: z.string().min(1),
    project: z.string().min(1),
    minConfidence: z.number().min(0).max(1),
    fields: z.array(FieldNameSchema).optional(),
  })
  .strict();
export type BulkAccept = z.infer<typeof BulkAcceptSchema>;

export const UndoSchema = z.object({ userId: z.string().min(1), opId: z.string().uuid() }).strict();
export type Undo = z.infer<typeof UndoSchema>;

export const ConfirmFieldSchema = z
  .object({ userId: z.string().min(1), itemId: z.string().uuid(), field: FieldNameSchema })
  .strict();
export type ConfirmField = z.infer<typeof ConfirmFieldSchema>;

/** SPEC §1 `TagProposalDecision`, addressed by proposal id (one proposal per item+tag). */
export const TagProposalDecisionSchema = z
  .object({ userId: z.string().min(1), proposalId: z.string().uuid(), decision: z.enum(["approve", "reject"]) })
  .strict();
export type TagProposalDecision = z.infer<typeof TagProposalDecisionSchema>;

export const BulkResultSchema = z
  .object({
    opId: z.string().uuid(),
    dryRun: z.boolean(),
    affected: z.array(
      z.object({ itemId: z.string().uuid(), field: FieldNameSchema, from: z.unknown(), to: z.unknown() }).strict(),
    ),
    undoable: z.boolean(),
  })
  .strict();
export type BulkResult = z.infer<typeof BulkResultSchema>;

export class CategoriserError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: string,
    message: string,
    public readonly itemId?: string,
  ) {
    super(message);
    this.name = "CategoriserError";
  }
}

export const nowIso = () => new Date().toISOString();
