import type { ExtractionStatus } from "../schemas/index.js";

export const USER_AGENT = "avi-categoriser/1.0";
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export class ExtractFailure extends Error {
  constructor(
    public readonly status: ExtractionStatus,
    reason: string,
    public readonly bytes = 0,
  ) {
    super(reason);
    this.name = "ExtractFailure";
  }
}

export type CappedResponse = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  bytes: number;
  truncated: boolean;
};

export type CappedFetchOptions = {
  fetchImpl: typeof fetch;
  allowedHosts: readonly string[];
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  jsonBody?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;
};

async function readCapped(res: Response, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, maxBytes - total);
    chunks.push(take);
    total += take.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

/**
 * Fetch restricted to an allow-list of hosts. Redirects are followed manually (max 3)
 * and every hop is re-checked against the allow-list. No cookies, 5 s deadline, 1 MB cap.
 */
export async function fetchCapped(url: string, opts: CappedFetchOptions): Promise<CappedResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let current = new URL(url);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const schemeOk = current.protocol === "https:" || (opts.allowHttp === true && current.protocol === "http:");
      if (!schemeOk || !opts.allowedHosts.includes(current.hostname) || current.username || current.password) {
        throw new ExtractFailure("blocked", "host-not-allowed");
      }
      const res = await opts.fetchImpl(current, {
        method: opts.method ?? "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          ...(opts.jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : undefined,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        current = new URL(location, current);
        continue;
      }
      const { body, truncated } = await readCapped(res, maxBytes);
      return { status: res.status, headers: res.headers, body, bytes: body.byteLength, truncated };
    }
    throw new ExtractFailure("blocked", "too-many-redirects");
  } catch (err) {
    if (err instanceof ExtractFailure) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ExtractFailure("timeout", "timeout");
    }
    throw new ExtractFailure("error", err instanceof Error ? err.name : "fetch-failed");
  }
}

export function statusForHttp(code: number): ExtractionStatus {
  if (code === 404 || code === 410 || code === 400) return "not_found";
  if (code === 401 || code === 403 || code === 429 || code === 451) return "blocked";
  return "error";
}

export function decodeUtf8(bytes: Uint8Array, truncated: boolean): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // A byte cap can split a multi-byte character; drop the replacement char it leaves behind.
  return truncated ? text.replace(/\uFFFD+$/, "") : text;
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes, false));
  } catch {
    throw new ExtractFailure("error", "invalid-json");
  }
}
