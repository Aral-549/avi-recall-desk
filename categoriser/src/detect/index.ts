import {
  type Field,
  type ItemType,
  type ProjectScore,
  type RawItem,
  type Source,
  nowIso,
} from "../schemas/index.js";

export type DetectResult = {
  type: Field<ItemType>;
  source: Field<Source>;
  project: Field<ProjectScore[]> | null;
  host?: string;
};

type Match = { type: ItemType; source: Source; confidence: number };

const CONF_URL = 1.0;
const CONF_MIME = 0.7;
const CONF_EXT = 0.8;
const CONF_DEFAULT = 0.5;
const CONF_CURRENT_PROJECT = 0.9;

const SOCIAL_HOSTS: Array<{ re: RegExp; source: Source }> = [
  { re: /(^|\.)reddit\.com$|^redd\.it$/, source: "reddit" },
  { re: /^(www\.|mobile\.)?(x|twitter)\.com$|^t\.co$/, source: "x" },
  { re: /(^|\.)slack\.com$/, source: "slack" },
];

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;
const GITHUB_HOSTS = /^(www\.)?github\.com$/;

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function detectFromUrl(url: string): Match | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (GITHUB_HOSTS.test(host)) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length >= 2 && !["topics", "search", "marketplace", "sponsors", "settings"].includes(segs[0]!)) {
      return { type: "github", source: "github", confidence: CONF_URL };
    }
    return { type: "link", source: "github", confidence: CONF_EXT };
  }
  for (const s of SOCIAL_HOSTS) {
    if (s.re.test(host)) return { type: "social", source: s.source, confidence: CONF_URL };
  }
  if (VIDEO_HOSTS.test(host)) return { type: "video", source: "youtube", confidence: CONF_URL };

  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".pdf")) return { type: "pdf", source: "web", confidence: CONF_EXT };
  if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(lowerPath)) return { type: "image", source: "web", confidence: CONF_EXT };
  return { type: "link", source: "web", confidence: CONF_URL };
}

export function detectFromMime(mime: string, name?: string): Match {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return { type: "pdf", source: "upload", confidence: CONF_MIME };
  if (m.startsWith("image/")) return { type: "image", source: "upload", confidence: CONF_MIME };
  if (name && /\.pdf$/i.test(name)) return { type: "pdf", source: "upload", confidence: CONF_EXT };
  if (name && /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name)) return { type: "image", source: "upload", confidence: CONF_EXT };
  return { type: "note", source: "manual", confidence: CONF_DEFAULT };
}

/** Stage 1. Deterministic, never fails, never calls the network. */
export function detect(item: RawItem): DetectResult {
  const at = nowIso();
  let match: Match | null = null;
  let host: string | undefined;

  if (item.url) {
    match = detectFromUrl(item.url);
    host = hostOf(item.url);
  }
  if (!match && item.file) match = detectFromMime(item.file.mime, item.file.name);
  if (!match) match = { type: "note", source: "manual", confidence: item.text ? CONF_URL : CONF_DEFAULT };

  const rule = (conf: number) => ({ state: "suggested" as const, by: "rule" as const, confidence: conf, at });

  const project: Field<ProjectScore[]> | null = item.currentProject
    ? { value: [{ project: item.currentProject, score: CONF_CURRENT_PROJECT }], ...rule(CONF_CURRENT_PROJECT) }
    : null;

  return {
    type: { value: match.type, ...rule(match.confidence) },
    source: { value: match.source, ...rule(match.confidence) },
    project,
    host,
  };
}
