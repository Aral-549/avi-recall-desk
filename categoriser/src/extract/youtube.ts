import { z } from "zod";
import type { Extraction } from "../schemas/index.js";
import { ExtractFailure, fetchCapped, parseJson, statusForHttp } from "./http.js";
import { MAX_TITLE, httpsUrl, sanitizeLine } from "./sanitize.js";

const OEMBED_HOST = "www.youtube.com";

const OembedSchema = z
  .object({
    title: z.string().optional(),
    author_name: z.string().optional(),
    thumbnail_url: z.string().optional(),
  })
  .passthrough();

export type YoutubeDeps = { fetchImpl: typeof fetch; now: () => Date };

export async function extractYoutube(videoUrl: string, deps: YoutubeDeps): Promise<Extraction> {
  const endpoint = `https://${OEMBED_HOST}/oembed?format=json&url=${encodeURIComponent(videoUrl)}`;
  const res = await fetchCapped(endpoint, {
    fetchImpl: deps.fetchImpl,
    allowedHosts: [OEMBED_HOST],
    headers: { Accept: "application/json" },
    maxBytes: 64 * 1024,
  });
  if (res.status !== 200) throw new ExtractFailure(statusForHttp(res.status), `oembed-${res.status}`, res.bytes);
  const parsed = OembedSchema.safeParse(parseJson(res.body));
  if (!parsed.success) throw new ExtractFailure("error", "oembed-shape", res.bytes);

  const meta: Record<string, string> = { provider: "YouTube" };
  const author = sanitizeLine(parsed.data.author_name, 200);
  if (author) meta.author = author;

  return {
    status: "ok",
    title: sanitizeLine(parsed.data.title, MAX_TITLE),
    image: httpsUrl(parsed.data.thumbnail_url),
    meta,
    fetchedAt: deps.now().toISOString(),
    bytes: res.bytes,
  };
}
