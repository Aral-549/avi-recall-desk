import { describe, expect, it } from "vitest";
import { redact, redactionSummary } from "../src/redact/index.js";

const SECRETS = {
  stripe: ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234"].join("_"),
  aws: "AKIAIOSFODNN7EXAMPLE",
  google: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
  githubPat: "github_pat_11ABCDEFG0123456789abcdefghijklmnop",
  slack: "xoxb-123456789012-abcdefghijkl",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  email: "bob.smith+tag@example.co.uk",
  phone: "+1 (415) 555-0199",
  ipv4: "192.168.1.10",
  ipv6: "2001:db8::ff00:42:8329",
  privateUrl: "http://10.0.0.5:8080/admin?x=1",
  localhost: "http://localhost:3000/dashboard",
  credsUrl: "https://admin:hunter2@db.example.com/prod",
  kv: 'api_key = "supersecretvalue123"',
};

describe("redact: secrets never survive", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`strips ${name}`, () => {
      const r = redact(`before ${secret} after`);
      expect(r.text).not.toContain(secret);
      expect(r.text).toMatch(/\[REDACTED_[A-Z_]+\]/);
      const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(1);
    });
  }

  it("counts by category", () => {
    const r = redact(`${SECRETS.email} ${SECRETS.stripe} ${SECRETS.privateUrl} ${SECRETS.phone}`);
    expect(r.counts.email).toBe(1);
    expect(r.counts.apiKey).toBe(1);
    expect(r.counts.privateUrl).toBe(1);
    expect(r.counts.phone).toBe(1);
  });

  it("summary never contains the matched value", () => {
    const r = redact(SECRETS.stripe);
    expect(redactionSummary(r)).not.toContain("sk_live");
    expect(redactionSummary(r)).toMatch(/redacted=1/);
  });

  it("handles secrets at string boundaries and in markdown", () => {
    expect(redact(SECRETS.aws).text).toBe("[REDACTED_API_KEY]");
    expect(redact(`\`${SECRETS.github}\``).text).toBe("`[REDACTED_API_KEY]`");
    expect(redact(`key: ${SECRETS.stripe}\n`).text).not.toContain("sk_live");
  });

  it("is idempotent", () => {
    const once = redact(`x ${SECRETS.jwt} ${SECRETS.email}`).text;
    expect(redact(once).text).toBe(once);
  });
});

describe("redact: low false positives", () => {
  it.each([
    "released in 2024, version 1.2.3, port 8080",
    "meeting at 12:30:45 ratio 10:1",
    "order 98765432 and id 123456",
    "Next.js 16.4.0 with React 19",
    "see section 4.2.1.3 of the spec", // dotted numbers below 255 look like IPs; documented trade-off
  ])("keeps ordinary text: %s", (s) => {
    const r = redact(s);
    expect(r.counts.email + r.counts.apiKey + r.counts.token + r.counts.phone + r.counts.privateUrl).toBe(0);
  });

  it("keeps public URLs", () => {
    const r = redact("read https://example.com/blog/post?id=1 and https://github.com/a/b");
    expect(r.text).toContain("https://example.com/blog/post?id=1");
    expect(r.counts.privateUrl).toBe(0);
  });

  it("handles empty and huge input", () => {
    expect(redact("").text).toBe("");
    const big = "lorem ipsum ".repeat(50_000) + SECRETS.email;
    const r = redact(big);
    expect(r.counts.email).toBe(1);
    expect(r.text).not.toContain(SECRETS.email);
  });

  it("handles non-English text", () => {
    const r = redact("これはテストです。連絡先: tanaka@example.jp 電話 03-1234-5678");
    expect(r.counts.email).toBe(1);
    expect(r.counts.phone).toBe(1);
    expect(r.text).toContain("これはテストです");
  });
});
