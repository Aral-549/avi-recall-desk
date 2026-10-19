import { NextRequest, NextResponse } from "next/server";

const ALLOWED = new Set(["health", "items", "tag-proposals", "bulk", "taxonomy"]);
const METHODS = new Set(["GET", "POST", "PUT"]);

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!path.length || path.some((part) => !part || part === "." || part === "..") || !ALLOWED.has(path[0]!)) {
    return NextResponse.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
  }
  if (!METHODS.has(request.method)) {
    return NextResponse.json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, { status: 405 });
  }

  const origin = process.env.CATEGORISER_URL ?? "http://127.0.0.1:8788";
  let target: URL;
  try {
    target = new URL(origin);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return NextResponse.json({ error: { code: "configuration", message: "Categoriser URL is invalid" } }, { status: 503 });
  }
  target.pathname = `/${path.map(encodeURIComponent).join("/")}`;
  target.search = request.nextUrl.search;

  const headers = new Headers();
  const token = process.env.CATEGORISER_HTTP_TOKEN;
  if (token) headers.set("authorization", `Bearer ${token}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.arrayBuffer();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: { code: "categoriser_unavailable", message: "Categoriser service is unavailable" } }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
