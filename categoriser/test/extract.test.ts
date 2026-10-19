import { describe, expect, it, vi } from "vitest";
import {
  CategoriserError,
  type Extraction,
  type RawItem,
  RawItemSchema,
  extract,
  parseGithubRepo,
  sidecarHealth,
  sidecarOrigin,
} from "../src/index.js";
import { buildPdf } from "./helpers/pdf.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const now = () => NOW;

function item(over: Partial<RawItem> = {}): RawItem {
  return RawItemSchema.parse({
    id: "8b6f6c1e-4f3a-4c55-9a43-2f0d7c1b5e01",
    userId: "u1",
    savedAt: NOW.toISOString(),
    ...over,
  });
}

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(route: Route) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url: url.toString(), init });
    return route(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const throwingFetch = (() => {
  throw new Error("network must not be touched");
}) as unknown as typeof fetch;

describe("parseGithubRepo", () => {
  it("parses repo URLs and strips .git", () => {
    expect(parseGithubRepo("https://github.com/vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js" });
    expect(parseGithubRepo("https://www.github.com/a-b/c_d.git/tree/main")).toEqual({ owner: "a-b", repo: "c_d" });
  });
  it("rejects non-repo and reserved paths", () => {
    for (const url of [
      "https://github.com/vercel",
      "https://github.com/topics/ai",
      "https://github.com/settings/profile",
      "https://gist.github.com/a/b",
      "https://evil.com/vercel/next.js",
      "https://github.com/-bad/x",
      "not a url",
    ]) {
      expect(parseGithubRepo(url)).toBeNull();
    }
  });
});

describe("extract: dispatch without network", () => {
  it("skips social sources and text-only notes", async () => {
    const { impl } = fakeFetch(() => json({}));
    for (const [url, source] of [
      ["https://reddit.com/r/x/comments/1", "reddit"],
      ["https://x.com/a/status/1", "x"],
      ["https://acme.slack.com/archives/C1/p1", "slack"],
    ] as const) {
      const r = await extract(item({ url }), { type: "social", source }, { fetchImpl: impl, now });
      expect(r).toEqual({ status: "skipped", fetchedAt: NOW.toISOString(), bytes: 0 });
    }
    const note = await extract(item({ text: "just a note" }), { type: "note", source: "manual" }, { fetchImpl: impl, now });
    expect(note.status).toBe("skipped");
    expect(impl).not.toHaveBeenCalled();
  });

  it("localOnly blocks every outbound call", async () => {
    const r = await extract(
      item({ url: "https://github.com/vercel/next.js", localOnly: true }),
      { type: "github", source: "github" },
      { fetchImpl: throwingFetch, now },
    );
    expect(r.status).toBe("skipped");
  });

  it("mock mode never fetches: fixtures or unavailable", async () => {
    const fixture: Extraction = { status: "ok", title: "Fixture", fetchedAt: NOW.toISOString(), bytes: 10 };
    const fixtures = new Map([["https://example.com/a", fixture]]);
    const hit = await extract(item({ url: "https://example.com/a" }), { type: "link", source: "web" }, { mock: true, fixtures, fetchImpl: throwingFetch, now });
    expect(hit.title).toBe("Fixture");
    const miss = await extract(item({ url: "https://github.com/a/b" }), { type: "github", source: "github" }, { mock: true, fetchImpl: throwingFetch, now });
    expect(miss.status).toBe("unavailable");
  });

  it("mock mode with a global fetch that throws still returns a result", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no network in mock");
    });
    try {
      const r = await extract(item({ url: "https://example.com/z" }), { type: "link", source: "web" }, { mock: true, now });
      expect(r.status).toBe("unavailable");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("extract: GitHub", () => {
  const repoBody = {
    full_name: "vercel/next.js",
    description: "The React Framework\u200b",
    stargazers_count: 130000,
    forks_count: 28000,
    topics: ["react", "nextjs"],
    language: "JavaScript",
    pushed_at: "2026-10-18T10:00:00Z",
    archived: false,
    owner: { avatar_url: "https://avatars.githubusercontent.com/u/14985020" },
  };

  it("uses api.github.com only, sends token, truncates README to 4096 bytes", async () => {
    const readme = "# Next.js\n" + "x".repeat(10_000);
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === "/repos/vercel/next.js") return json(repoBody);
      if (url.pathname === "/repos/vercel/next.js/readme") return new Response(readme);
      return new Response("", { status: 500 });
    });
    const r = await extract(
      item({ url: "https://github.com/vercel/next.js" }),
      { type: "github", source: "github" },
      { fetchImpl: impl, githubToken: "ghp_test", now },
    );
    expect(r.status).toBe("ok");
    expect(r.title).toBe("vercel/next.js");
    expect(r.description).toBe("The React Framework");
    expect(r.meta).toEqual({
      stars: 130000,
      forks: 28000,
      topics: ["react", "nextjs"],
      language: "JavaScript",
      pushedAt: "2026-10-18T10:00:00.000Z",
      archived: "false",
    });
    expect(new TextEncoder().encode(r.text!).byteLength).toBeLessThanOrEqual(4096);
    expect(r.text!.startsWith("# Next.js")).toBe(true);
    expect(calls.every((c) => new URL(c.url).hostname === "api.github.com")).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_test");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("maps 404 to not_found and rate limits to blocked", async () => {
    const notFound = fakeFetch(() => json({ message: "Not Found" }, 404));
    const r1 = await extract(item({ url: "https://github.com/a/missing" }), { type: "github", source: "github" }, { fetchImpl: notFound.impl, now });
    expect(r1.status).toBe("not_found");

    const limited = fakeFetch(() => json({ message: "rate limit" }, 403));
    const r2 = await extract(item({ url: "https://github.com/a/b" }), { type: "github", source: "github" }, { fetchImpl: limited.impl, now });
    expect(r2.status).toBe("blocked");
  });

  it("missing README still yields ok", async () => {
    const { impl } = fakeFetch((url) => (url.pathname.endsWith("/readme") ? json({}, 404) : json(repoBody)));
    const r = await extract(item({ url: "https://github.com/vercel/next.js" }), { type: "github", source: "github" }, { fetchImpl: impl, now });
    expect(r.status).toBe("ok");
    expect(r.text).toBeUndefined();
  });

  it("refuses redirects that leave api.github.com", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest" } }));
    const r = await extract(item({ url: "https://github.com/a/b" }), { type: "github", source: "github" }, { fetchImpl: impl, now });
    expect(r.status).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("follows same-host renames, capped at 3 redirects", async () => {
    let hops = 0;
    const { impl } = fakeFetch(() => {
      hops++;
      return new Response(null, { status: 301, headers: { location: `https://api.github.com/repositories/${hops}` } });
    });
    const r = await extract(item({ url: "https://github.com/a/b" }), { type: "github", source: "github" }, { fetchImpl: impl, now });
    expect(r.status).toBe("blocked");
    expect(hops).toBe(4);
  });

  it("non-repo GitHub URLs go to the sidecar", async () => {
    const { impl, calls } = fakeFetch(() => json({ status: "ok", title: "Profile", bytes: 5 }));
    await extract(item({ url: "https://github.com/vercel" }), { type: "github", source: "github" }, { fetchImpl: impl, now });
    expect(new URL(calls[0]!.url).host).toBe("127.0.0.1:8787");
  });
});

describe("extract: YouTube oEmbed", () => {
  it("reads title, author and https thumbnail from oEmbed only", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ title: "Talk", author_name: "Chan", thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg" }),
    );
    const url = "https://www.youtube.com/watch?v=abc123";
    const r = await extract(item({ url }), { type: "video", source: "youtube" }, { fetchImpl: impl, now });
    expect(r).toMatchObject({ status: "ok", title: "Talk", image: "https://i.ytimg.com/vi/x/hq.jpg", meta: { author: "Chan", provider: "YouTube" } });
    const called = new URL(calls[0]!.url);
    expect(called.host).toBe("www.youtube.com");
    expect(called.pathname).toBe("/oembed");
    expect(called.searchParams.get("url")).toBe(url);
  });

  it("drops non-https thumbnails and maps 401 to blocked", async () => {
    const insecure = fakeFetch(() => json({ title: "T", thumbnail_url: "http://i.ytimg.com/x.jpg" }));
    const r1 = await extract(item({ url: "https://youtu.be/x" }), { type: "video", source: "youtube" }, { fetchImpl: insecure.impl, now });
    expect(r1.image).toBeUndefined();
    const priv = fakeFetch(() => new Response("Unauthorized", { status: 401 }));
    const r2 = await extract(item({ url: "https://youtu.be/x" }), { type: "video", source: "youtube" }, { fetchImpl: priv.impl, now });
    expect(r2.status).toBe("blocked");
  });
});

describe("extract: sidecar", () => {
  it("posts the URL to the loopback sidecar and re-sanitises the response", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        status: "ok",
        title: "Hello\u202e world",
        text: "line one\u200b\n\n\n  line   two  ",
        image: "javascript:alert(1)",
        language: "en-GB",
        publishedAt: "2026-01-02T03:04:05+02:00",
        bytes: 1234,
        unexpected: "ignored",
      }),
    );
    const r = await extract(item({ url: "https://example.com/post" }), { type: "link", source: "web" }, { fetchImpl: impl, now });
    expect(r).toEqual({
      status: "ok",
      title: "Hello world",
      text: "line one\nline two",
      language: "en-GB",
      publishedAt: "2026-01-02T01:04:05.000Z",
      fetchedAt: NOW.toISOString(),
      bytes: 1234,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/extract");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ url: "https://example.com/post" });
  });

  it("sidecar down -> unavailable, never throws", async () => {
    const down = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const r = await extract(item({ url: "https://example.com/x" }), { type: "link", source: "web" }, { fetchImpl: down, now });
    expect(r).toEqual({ status: "unavailable", fetchedAt: NOW.toISOString(), bytes: 0 });
  });

  it("garbage from the sidecar -> error", async () => {
    const { impl } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const r = await extract(item({ url: "https://example.com/x" }), { type: "link", source: "web" }, { fetchImpl: impl, now });
    expect(r.status).toBe("error");
  });

  it("non-ok sidecar statuses carry no content", async () => {
    const { impl } = fakeFetch(() => json({ status: "blocked", title: "should be dropped", bytes: 0 }));
    const r = await extract(item({ url: "https://example.com/x" }), { type: "link", source: "web" }, { fetchImpl: impl, now });
    expect(r).toEqual({ status: "blocked", fetchedAt: NOW.toISOString(), bytes: 0 });
  });

  it("caps sidecar text at 20k chars", async () => {
    const { impl } = fakeFetch(() => json({ status: "ok", text: "a".repeat(50_000), bytes: 50_000 }));
    const r = await extract(item({ url: "https://example.com/x" }), { type: "link", source: "web" }, { fetchImpl: impl, now });
    expect(r.text!.length).toBe(20_000);
  });

  it("refuses non-loopback sidecar URLs", async () => {
    expect(() => sidecarOrigin("http://10.0.0.5:8787")).toThrow(CategoriserError);
    expect(() => sidecarOrigin("https://127.0.0.1:8787")).toThrow(CategoriserError);
    await expect(
      extract(item({ url: "https://example.com/x" }), { type: "link", source: "web" }, { fetchImpl: throwingFetch, sidecarUrl: "http://evil.com", now }),
    ).rejects.toBeInstanceOf(CategoriserError);
  });

  it("reports sidecar health", async () => {
    const up = fakeFetch(() => json({ ok: true, mode: "mock" }));
    expect(await sidecarHealth({ fetchImpl: up.impl })).toEqual({ reachable: true, mode: "mock" });
    const down = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await sidecarHealth({ fetchImpl: down })).toEqual({ reachable: false });
  });
});

describe("extract: files", () => {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

  it("reads the first 3 pages of a PDF with pdfjs", async () => {
    const pdf = buildPdf(["Alpha page", "Beta page", "Gamma page", "Delta page"], "Quarterly report");
    const r = await extract(
      item({ file: { mime: "application/pdf", bytes: b64(pdf), name: "q.pdf" } }),
      { type: "pdf", source: "upload" },
      { fetchImpl: throwingFetch, now },
    );
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Quarterly report");
    expect(r.text).toContain("Alpha page");
    expect(r.text).toContain("Gamma page");
    expect(r.text).not.toContain("Delta page");
    expect(r.meta).toEqual({ pages: 4 });
    expect(r.bytes).toBe(pdf.byteLength);
  });

  it("corrupt PDF -> error, not a throw", async () => {
    const r = await extract(
      item({ file: { mime: "application/pdf", bytes: b64(new TextEncoder().encode("not a pdf")) } }),
      { type: "pdf", source: "upload" },
      { now },
    );
    expect(r.status).toBe("error");
  });

  it("OCRs images through the injected runner", async () => {
    const ocr = vi.fn(async () => ({ text: "INVOICE\u200b  #42\n\nTotal 10", confidence: 0.873 }));
    const r = await extract(
      item({ file: { mime: "image/png", bytes: b64(new Uint8Array([1, 2, 3])), name: "scan.png" } }),
      { type: "image", source: "upload" },
      { ocr, now },
    );
    expect(r).toMatchObject({ status: "ok", title: "scan.png", text: "INVOICE #42\nTotal 10", meta: { ocrConfidence: 0.87 }, bytes: 3 });
    expect(ocr).toHaveBeenCalledWith(expect.any(Uint8Array), { allowNetwork: true });
  });

  it("OCR gets allowNetwork:false under localOnly or mock, and null -> skipped", async () => {
    const ocr = vi.fn(async () => null);
    const file = { mime: "image/png", bytes: b64(new Uint8Array([1])) };
    const r1 = await extract(item({ file, localOnly: true }), { type: "image", source: "upload" }, { ocr, now });
    const r2 = await extract(item({ file }), { type: "image", source: "upload" }, { ocr, mock: true, now });
    expect(r1.status).toBe("skipped");
    expect(r2.status).toBe("skipped");
    expect(ocr.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ allowNetwork: false }, { allowNetwork: false }]);
  });

  it("slow OCR times out", async () => {
    const ocr = () => new Promise<never>(() => {});
    const r = await extract(
      item({ file: { mime: "image/jpeg", bytes: b64(new Uint8Array([1])) } }),
      { type: "image", source: "upload" },
      { ocr, localTimeoutMs: 20, now },
    );
    expect(r.status).toBe("timeout");
  });
});
