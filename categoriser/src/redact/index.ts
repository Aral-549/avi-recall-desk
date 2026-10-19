import type { Redaction } from "../schemas/index.js";

type Counter = Redaction["counts"];

const emptyCounts = (): Counter => ({ apiKey: 0, token: 0, email: 0, phone: 0, privateUrl: 0, ip: 0 });

/**
 * Ordered patterns. Earlier ones win because the replacement token is not re-matched later.
 * Patterns are intentionally broad: a false positive costs a little context, a false negative leaks a secret.
 */
const API_KEY_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}\b/g, // Stripe, OpenAI, Anthropic-style
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temp key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, // SendGrid
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:api[_-]?key|apikey|secret|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[^\s"'<>]{8,}["']?/gi, // key=value assignments
];

const TOKEN_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:bearer|token)\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// E.164 and common national formats; requires 9+ digits to avoid eating years/ids.
const PHONE = /(?<![\w.])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}(?!\w)/g;

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Full and compressed forms. Filter below rejects clock times like 12:30:45.
const IPV6 = /(?<![\w:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![\w:])/g;

const PRIVATE_URL =
  /\bhttps?:\/\/(?:[^\s/@]+@)?(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1\]|[^\s/]+\.(?:local|internal|corp|lan|intranet))(?::\d+)?[^\s<>"']*/gi;

const URL_WITH_CREDS = /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s<>"']+/gi;

function countDigits(s: string): number {
  let n = 0;
  for (const c of s) if (c >= "0" && c <= "9") n++;
  return n;
}

function apply(text: string, patterns: RegExp[], token: string, counts: Counter, key: keyof Counter, filter?: (m: string) => boolean): string {
  for (const re of patterns) {
    text = text.replace(re, (m) => {
      if (filter && !filter(m)) return m;
      counts[key]++;
      return token;
    });
  }
  return text;
}

/** Stage 3. Pure, sync. Strips secrets before any text leaves the machine. Returns counts only, never matches. */
export function redact(input: string): Redaction {
  const counts = emptyCounts();
  let text = input;

  text = apply(text, [URL_WITH_CREDS], "[REDACTED_PRIVATE_URL]", counts, "privateUrl");
  text = apply(text, [PRIVATE_URL], "[REDACTED_PRIVATE_URL]", counts, "privateUrl");
  text = apply(text, [TOKEN_PATTERNS[2]!], "[REDACTED_TOKEN]", counts, "token");
  text = apply(text, API_KEY_PATTERNS, "[REDACTED_API_KEY]", counts, "apiKey");
  text = apply(text, [TOKEN_PATTERNS[0]!, TOKEN_PATTERNS[1]!], "[REDACTED_TOKEN]", counts, "token");
  text = apply(text, [EMAIL], "[REDACTED_EMAIL]", counts, "email");
  text = apply(text, [IPV4], "[REDACTED_IP]", counts, "ip");
  text = apply(text, [IPV6], "[REDACTED_IP]", counts, "ip", (m) => m.includes("::") || (m.split(":").length >= 5 && /[a-f]/i.test(m)));
  text = apply(text, [PHONE], "[REDACTED_PHONE]", counts, "phone", (m) => countDigits(m) >= 9 && countDigits(m) <= 15);

  return { text, counts };
}

/** Convenience for log lines: total redactions, never the text. */
export function redactionSummary(r: Redaction): string {
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  return `redacted=${total} ${Object.entries(r.counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(",")}`;
}
