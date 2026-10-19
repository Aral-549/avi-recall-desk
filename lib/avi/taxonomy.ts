/** Closed taxonomy, copied from `categoriser/taxonomy.seed.yaml` (version 1). Tags outside this list are never stored. */
export const TAXONOMY_VERSION = 1;

export const TAXONOMY = [
  { id: "cybersecurity", label: "Cybersecurity", synonyms: ["security", "infosec", "appsec", "ctf", "pentest", "pentesting", "vulnerability", "exploit", "cve", "malware"] },
  { id: "open-source", label: "Open Source", synonyms: ["oss", "foss", "opensource", "github", "repo"] },
  { id: "web-dev", label: "Web Development", synonyms: ["webdev", "web-development", "frontend", "backend", "fullstack", "full-stack", "nextjs", "next-js", "react", "javascript", "typescript", "css", "html", "tailwind"] },
  { id: "ai-ml", label: "AI / ML", synonyms: ["ai", "ml", "artificial-intelligence", "machine-learning", "llm", "llms", "deep-learning", "neural-network", "gpt", "transformers", "agents", "agent", "prompt"] },
  { id: "design-ui", label: "Design / UI", synonyms: ["design", "ui", "ux", "ui-ux", "figma", "typography", "interface", "motion", "animation", "layout", "type"] },
  { id: "hackathon", label: "Hackathon", synonyms: ["hack", "hackathons", "devpost", "mlh"] },
  { id: "chess", label: "Chess", synonyms: ["lichess", "chesscom", "chess-com", "opening", "endgame"] },
  { id: "tutorial", label: "Tutorial", synonyms: ["guide", "howto", "how-to", "walkthrough", "course", "lesson", "learn", "codrops"] },
  { id: "tool-library", label: "Tool / Library", synonyms: ["tool", "tools", "library", "libraries", "package", "sdk", "cli", "framework", "utility", "plugin"] },
  { id: "docs-reference", label: "Docs / Reference", synonyms: ["docs", "documentation", "reference", "api-docs", "spec", "specification", "manual", "cheatsheet"] },
  { id: "inspiration", label: "Inspiration", synonyms: ["inspo", "showcase", "portfolio", "gallery", "awesome", "awwwards", "sotd", "moodboard"] },
  { id: "article", label: "Article", synonyms: ["blog", "blog-post", "post", "essay", "writeup", "write-up", "news", "paper"] },
  { id: "career-study", label: "Career / Study", synonyms: ["career", "job", "jobs", "interview", "interviews", "study", "exam", "resume", "cv", "internship"] },
] as const;

export type TagId = (typeof TAXONOMY)[number]["id"];
export const TAG_IDS = TAXONOMY.map((t) => t.id) as TagId[];

const LABELS = new Map<string, string>(TAXONOMY.map((t) => [t.id, t.label]));
export const tagLabel = (id: string) => LABELS.get(id) ?? id;
export const isTagId = (v: unknown): v is TagId => typeof v === "string" && LABELS.has(v);

/** Normalise anything (id, label, synonym, any case) to a taxonomy id, or null. */
const LOOKUP = new Map<string, TagId>();
for (const t of TAXONOMY) {
  LOOKUP.set(t.id, t.id);
  LOOKUP.set(t.label.toLowerCase(), t.id);
  for (const s of t.synonyms) LOOKUP.set(s, t.id);
}
export function resolveTag(raw: string): TagId | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return LOOKUP.get(key) ?? LOOKUP.get(key.replace(/-/g, "")) ?? null;
}
export const tagLookup = LOOKUP;
