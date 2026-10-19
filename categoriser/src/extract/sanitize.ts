import { MAX_STORED_TEXT } from "../schemas/index.js";

export const MAX_TITLE = 500;
export const MAX_DESCRIPTION = 2_000;

// C0/C1 controls (except \n \t), zero-width chars, bidi overrides and BOM: common places to hide injected text.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SPACES = /[ \t\u00A0\u2000-\u200A\u3000]+/g;

export function sanitizeText(raw: string | undefined | null, limit = MAX_STORED_TEXT): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => line.replace(SPACES, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, limit)
    .trimEnd();
  return text || undefined;
}

export function sanitizeLine(raw: string | undefined | null, limit: number): string | undefined {
  const text = sanitizeText(raw, limit * 2)?.replace(/\n/g, " ").slice(0, limit).trim();
  return text || undefined;
}

export function httpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
export function languageTag(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= 16 && LANG.test(raw) ? raw : undefined;
}

export function isoDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
