import { describe, expect, it } from "vitest";
import { detect, detectFromUrl } from "../src/detect/index.js";
import { RawItemSchema, type RawItemInput } from "../src/schemas/index.js";

const base: Omit<RawItemInput, "url" | "text" | "file"> = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "u1",
  savedAt: "2026-10-19T00:00:00.000Z",
};
const mk = (extra: Partial<RawItemInput>) => RawItemSchema.parse({ ...base, ...extra });

describe("detect: URL patterns", () => {
  it.each([
    ["https://github.com/vercel/next.js", "github", "github", 1],
    ["https://www.github.com/vercel/next.js/tree/main", "github", "github", 1],
    ["https://github.com/topics/ai", "link", "github", 0.8],
    ["https://www.reddit.com/r/netsec/comments/abc", "social", "reddit", 1],
    ["https://old.reddit.com/r/x", "social", "reddit", 1],
    ["https://redd.it/abc", "social", "reddit", 1],
    ["https://x.com/a/status/1", "social", "x", 1],
    ["https://twitter.com/a/status/1", "social", "x", 1],
    ["https://myteam.slack.com/archives/C01/p1", "social", "slack", 1],
    ["https://www.youtube.com/watch?v=abc", "video", "youtube", 1],
    ["https://youtu.be/abc", "video", "youtube", 1],
    ["https://arxiv.org/pdf/2301.00001.pdf", "pdf", "web", 0.8],
    ["https://example.com/a.PNG", "image", "web", 0.8],
    ["https://example.com/blog", "link", "web", 1],
  ])("%s -> %s/%s", (url, type, source, conf) => {
    const r = detect(mk({ url }));
    expect(r.type.value).toBe(type);
    expect(r.source.value).toBe(source);
    expect(r.type.confidence).toBe(conf);
    expect(r.type.by).toBe("rule");
    expect(r.type.state).toBe("suggested");
  });

  it("does not match lookalike hosts", () => {
    expect(detectFromUrl("https://github.com.evil.com/a/b")).toMatchObject({ type: "link", source: "web" });
    expect(detectFromUrl("https://evil.com/?u=https://reddit.com")).toMatchObject({ type: "link", source: "web" });
    expect(detectFromUrl("https://notreddit.com/r/x")).toMatchObject({ type: "link", source: "web" });
    expect(detectFromUrl("https://fakeyoutube.com/watch")).toMatchObject({ type: "link", source: "web" });
  });

  it("ignores query strings when checking extensions", () => {
    expect(detectFromUrl("https://example.com/page?file=a.pdf")).toMatchObject({ type: "link" });
  });

  it("rejects non-http schemes at the schema boundary", () => {
    expect(() => mk({ url: "ftp://example.com/x" })).toThrow();
    expect(() => mk({ url: "javascript:alert(1)" })).toThrow();
    expect(detectFromUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("detect: files and notes", () => {
  it("uses MIME for uploads", () => {
    expect(detect(mk({ file: { mime: "image/png", bytes: "aGk=" } })).type).toMatchObject({ value: "image", confidence: 0.7 });
    expect(detect(mk({ file: { mime: "application/pdf", bytes: "aGk=" } })).source.value).toBe("upload");
  });
  it("rejects disallowed MIME types", () => {
    expect(() => mk({ file: { mime: "text/html", bytes: "aGk=" } })).toThrow();
    expect(() => mk({ file: { mime: "application/x-sh", bytes: "aGk=" } })).toThrow();
  });
  it("plain text is a manual note", () => {
    expect(detect(mk({ text: "hello" }))).toMatchObject({ type: { value: "note" }, source: { value: "manual" } });
  });
  it("requires at least one input", () => {
    expect(() => mk({})).toThrow();
  });
});

describe("detect: project context", () => {
  it("seeds project from currentProject with rule provenance", () => {
    const r = detect(mk({ url: "https://example.com", currentProject: "AVI" }));
    expect(r.project).toMatchObject({ value: [{ project: "AVI", score: 0.9 }], by: "rule", state: "suggested", confidence: 0.9 });
  });
  it("is null without currentProject", () => {
    expect(detect(mk({ url: "https://example.com" })).project).toBeNull();
  });
  it("never produces confirmed fields", () => {
    const r = detect(mk({ url: "https://github.com/a/b", currentProject: "P" }));
    for (const f of [r.type, r.source, r.project!]) expect(f.state).toBe("suggested");
  });
});
