import { z } from "zod";
import { CategoriserError, type Extraction, ExtractionStatusSchema } from "../schemas/index.js";
import { ExtractFailure, fetchCapped, parseJson } from "./http.js";
import { MAX_DESCRIPTION, MAX_TITLE, httpsUrl, isoDate, languageTag, sanitizeLine, sanitizeText } from "./sanitize.js";

export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8787";
const SIDECAR_TIMEOUT_MS = 8_000; // sidecar's own 5 s fetch deadline + parse headroom
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The sidecar must be local: it is the only generic fetcher, so the TS side never reaches arbitrary hosts. */
export function sidecarOrigin(raw: string = DEFAULT_SIDECAR_URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CategoriserError("config", "extract", "invalid sidecar URL");
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new CategoriserError("config", "extract", "sidecar URL must be http on a loopback host");
  }
  return url;
}

const SidecarResponseSchema = z
  .object({
    status: ExtractionStatusSchema,
    title: z.string().optional(),
    description: z.string().optional(),
    text: z.string().optional(),
    image: z.string().optional(),
    language: z.string().optional(),
    publishedAt: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type SidecarDeps = { fetchImpl: typeof fetch; sidecarUrl?: string; now: () => Date };

function isConnectionFailure(err: unknown): boolean {
  return err instanceof ExtractFailure && err.status === "error";
}

export async function extractViaSidecar(pageUrl: string, deps: SidecarDeps): Promise<Extraction> {
  const origin = sidecarOrigin(deps.sidecarUrl);
  let res;
  try {
    res = await fetchCapped(new URL("/extract", origin).toString(), {
      fetchImpl: deps.fetchImpl,
      allowedHosts: [origin.hostname],
      allowHttp: true,
      method: "POST",
      jsonBody: { url: pageUrl },
      headers: { Accept: "application/json" },
      timeoutMs: SIDECAR_TIMEOUT_MS,
    });
  } catch (err) {
    // Connection refused / reset: sidecar is down. Save must still succeed.
    if (isConnectionFailure(err)) throw new ExtractFailure("unavailable", "sidecar-unreachable");
    throw err;
  }
  if (res.status !== 200) throw new ExtractFailure("unavailable", `sidecar-${res.status}`);
  const parsed = SidecarResponseSchema.safeParse(parseJson(res.body));
  if (!parsed.success) throw new ExtractFailure("error", "sidecar-shape");
  const data = parsed.data;

  // Defence in depth: re-sanitise and re-clip everything the sidecar returned.
  return {
    status: data.status,
    title: sanitizeLine(data.title, MAX_TITLE),
    description: sanitizeLine(data.description, MAX_DESCRIPTION),
    text: sanitizeText(data.text),
    image: httpsUrl(data.image),
    language: languageTag(data.language),
    publishedAt: isoDate(data.publishedAt),
    fetchedAt: deps.now().toISOString(),
    bytes: data.bytes ?? 0,
  };
}

export type SidecarHealth = { reachable: boolean; mode?: string };

export async function sidecarHealth(deps: Omit<SidecarDeps, "now">): Promise<SidecarHealth> {
  const origin = sidecarOrigin(deps.sidecarUrl);
  try {
    const res = await fetchCapped(new URL("/health", origin).toString(), {
      fetchImpl: deps.fetchImpl,
      allowedHosts: [origin.hostname],
      allowHttp: true,
      timeoutMs: 1_500,
      maxBytes: 4096,
    });
    if (res.status !== 200) return { reachable: false };
    const body = parseJson(res.body) as { mode?: unknown };
    return { reachable: true, mode: typeof body.mode === "string" ? body.mode : undefined };
  } catch {
    return { reachable: false };
  }
}
