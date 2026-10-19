import { z } from "zod";
import type { Extraction } from "../schemas/index.js";
import { ExtractFailure, decodeUtf8, fetchCapped, parseJson, statusForHttp } from "./http.js";
import { MAX_DESCRIPTION, MAX_TITLE, httpsUrl, isoDate, sanitizeLine, sanitizeText } from "./sanitize.js";

const API_HOST = "api.github.com";
export const README_MAX_BYTES = 4096;

const RESERVED_OWNERS = new Set([
  "about", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore",
  "features", "login", "marketplace", "new", "notifications", "orgs", "organizations", "pricing",
  "pulls", "issues", "search", "security", "settings", "signup", "sponsors", "topics", "trending", "users",
]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export type GithubRepoRef = { owner: string; repo: string };

export function parseGithubRepo(rawUrl: string): GithubRepoRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, rawRepo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/, "");
  if (RESERVED_OWNERS.has(owner.toLowerCase()) || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}

const RepoSchema = z
  .object({
    full_name: z.string(),
    description: z.string().nullable().optional(),
    stargazers_count: z.number().optional(),
    forks_count: z.number().optional(),
    topics: z.array(z.string()).optional(),
    language: z.string().nullable().optional(),
    pushed_at: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    owner: z.object({ avatar_url: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type GithubDeps = { fetchImpl: typeof fetch; token?: string; now: () => Date };

export async function extractGithub(ref: GithubRepoRef, deps: GithubDeps): Promise<Extraction> {
  const base = `https://${API_HOST}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
  };

  const repoRes = await fetchCapped(base, { fetchImpl: deps.fetchImpl, allowedHosts: [API_HOST], headers });
  if (repoRes.status !== 200) throw new ExtractFailure(statusForHttp(repoRes.status), `github-${repoRes.status}`, repoRes.bytes);
  const parsed = RepoSchema.safeParse(parseJson(repoRes.body));
  if (!parsed.success) throw new ExtractFailure("error", "github-shape", repoRes.bytes);
  const repo = parsed.data;

  let readme: string | undefined;
  let readmeBytes = 0;
  try {
    const readmeRes = await fetchCapped(`${base}/readme`, {
      fetchImpl: deps.fetchImpl,
      allowedHosts: [API_HOST],
      headers: { ...headers, Accept: "application/vnd.github.raw" },
      maxBytes: README_MAX_BYTES,
    });
    readmeBytes = readmeRes.bytes;
    if (readmeRes.status === 200) readme = sanitizeText(decodeUtf8(readmeRes.body, readmeRes.truncated));
  } catch (err) {
    if (!(err instanceof ExtractFailure)) throw err;
  }

  const meta: Record<string, string | number | string[]> = {};
  if (typeof repo.stargazers_count === "number") meta.stars = repo.stargazers_count;
  if (typeof repo.forks_count === "number") meta.forks = repo.forks_count;
  if (repo.topics?.length) meta.topics = repo.topics.slice(0, 20).map((t) => t.slice(0, 50));
  if (repo.language) meta.language = repo.language.slice(0, 50);
  const pushedAt = isoDate(repo.pushed_at);
  if (pushedAt) meta.pushedAt = pushedAt;
  if (typeof repo.archived === "boolean") meta.archived = String(repo.archived);

  return {
    status: "ok",
    title: sanitizeLine(repo.full_name, MAX_TITLE),
    description: sanitizeLine(repo.description, MAX_DESCRIPTION),
    text: readme,
    image: httpsUrl(repo.owner?.avatar_url),
    meta,
    fetchedAt: deps.now().toISOString(),
    bytes: repoRes.bytes + readmeBytes,
  };
}
