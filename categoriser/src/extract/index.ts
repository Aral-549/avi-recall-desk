import {
  CategoriserError,
  type Extraction,
  ExtractionSchema,
  type ExtractionStatus,
  type ItemType,
  type RawItem,
  type Source,
} from "../schemas/index.js";
import { extractGithub, parseGithubRepo } from "./github.js";
import { ExtractFailure } from "./http.js";
import { type OcrRunner, type PdfReader, pdfjsReader, tesseractOcr } from "./local.js";
import { MAX_TITLE, sanitizeLine, sanitizeText } from "./sanitize.js";
import { extractViaSidecar } from "./sidecar.js";
import { extractYoutube } from "./youtube.js";

export { parseGithubRepo, README_MAX_BYTES } from "./github.js";
export { DEFAULT_SIDECAR_URL, sidecarHealth, sidecarOrigin } from "./sidecar.js";
export { PDF_MAX_PAGES, pdfjsReader, tesseractOcr } from "./local.js";
export type { OcrResult, OcrRunner, PdfReader, PdfResult } from "./local.js";

export type ExtractDeps = {
  /** No network at all. URL items resolve from `fixtures` or come back `unavailable`. */
  mock?: boolean;
  fixtures?: ReadonlyMap<string, Extraction>;
  fetchImpl?: typeof fetch;
  sidecarUrl?: string;
  githubToken?: string;
  ocr?: OcrRunner;
  pdf?: PdfReader;
  /** Guard for OCR/PDF work, which has no network deadline of its own. */
  localTimeoutMs?: number;
  now?: () => Date;
};

export type Detected = { type: ItemType; source: Source };

const NO_FETCH_SOURCES: ReadonlySet<Source> = new Set(["reddit", "x", "slack"]);

function empty(status: ExtractionStatus, now: () => Date, bytes = 0): Extraction {
  return { status, fetchedAt: now().toISOString(), bytes };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractFailure("timeout", "local-timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function extractFile(item: RawItem, deps: Required<Pick<ExtractDeps, "now">> & ExtractDeps): Promise<Extraction> {
  const file = item.file!;
  const bytes = Uint8Array.from(Buffer.from(file.bytes, "base64"));
  const limit = deps.localTimeoutMs ?? 30_000;
  const now = deps.now;

  if (file.mime === "application/pdf") {
    const result = await withTimeout((deps.pdf ?? pdfjsReader)(bytes), limit);
    const text = sanitizeText(result.text);
    return {
      status: "ok",
      title: sanitizeLine(result.title, MAX_TITLE) ?? sanitizeLine(file.name, MAX_TITLE),
      text,
      meta: { pages: result.pages },
      fetchedAt: now().toISOString(),
      bytes: bytes.byteLength,
    };
  }

  if (file.mime.startsWith("image/")) {
    const allowNetwork = !deps.mock && !item.localOnly;
    const result = await withTimeout((deps.ocr ?? tesseractOcr)(bytes, { allowNetwork }), limit);
    if (!result) return empty("skipped", now, bytes.byteLength);
    return {
      status: "ok",
      title: sanitizeLine(file.name, MAX_TITLE),
      text: sanitizeText(result.text),
      meta: { ocrConfidence: Math.round(result.confidence * 100) / 100 },
      fetchedAt: now().toISOString(),
      bytes: bytes.byteLength,
    };
  }

  return empty("skipped", now, bytes.byteLength);
}

async function extractUrl(
  url: string,
  detected: Detected,
  deps: Required<Pick<ExtractDeps, "now">> & ExtractDeps,
): Promise<Extraction> {
  if (deps.mock) {
    const fixture = deps.fixtures?.get(url);
    return fixture ? { ...fixture } : empty("unavailable", deps.now);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (detected.source === "github") {
    const ref = parseGithubRepo(url);
    if (ref) return extractGithub(ref, { fetchImpl, token: deps.githubToken, now: deps.now });
  }
  if (detected.source === "youtube") {
    return extractYoutube(url, { fetchImpl, now: deps.now });
  }
  return extractViaSidecar(url, { fetchImpl, sidecarUrl: deps.sidecarUrl, now: deps.now });
}

/**
 * Stage 2. Never throws for extraction problems: any failure becomes a status with empty text,
 * so saving an item can never fail because of extraction. Only misconfiguration throws.
 */
export async function extract(item: RawItem, detected: Detected, deps: ExtractDeps = {}): Promise<Extraction> {
  const now = deps.now ?? (() => new Date());
  const ctx = { ...deps, now };

  let result: Extraction;
  try {
    if (item.file) {
      result = await extractFile(item, ctx);
    } else if (!item.url) {
      result = empty("skipped", now);
    } else if (detected.type === "social" || NO_FETCH_SOURCES.has(detected.source)) {
      result = empty("skipped", now);
    } else if (item.localOnly) {
      // localOnly blocks every outbound call, including GitHub, oEmbed and the sidecar's page fetch.
      result = empty("skipped", now);
    } else {
      result = await extractUrl(item.url, detected, ctx);
    }
  } catch (err) {
    if (err instanceof CategoriserError) throw err;
    result = err instanceof ExtractFailure ? empty(err.status, now, err.bytes) : empty("error", now);
  }

  const parsed = ExtractionSchema.safeParse(result);
  if (!parsed.success) return empty("error", now, result.bytes);
  if (parsed.data.status !== "ok") {
    return { status: parsed.data.status, fetchedAt: parsed.data.fetchedAt, bytes: parsed.data.bytes };
  }
  return parsed.data;
}
