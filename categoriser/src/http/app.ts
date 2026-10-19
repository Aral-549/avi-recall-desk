import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bulkAccept, bulkRevert, confirmField, undo, type BulkDeps } from "../bulk/index.js";
import type { Categoriser } from "../pipeline.js";
import { decideTagProposal } from "../proposals/index.js";
import { CategoriserError, FieldNameSchema, MAX_FILE_BYTES, type BulkResult, type FieldName } from "../schemas/index.js";
import type { StorageAdapter } from "../storage/index.js";
import { parseTaxonomy, serializeTaxonomy } from "../taxonomy/index.js";

const STAGE = "http";
/** base64 inflates by 4/3; leave room for JSON framing. */
export const MAX_BODY_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HttpLogEvent = { stage: "http"; method: string; route: string; status: number; code?: string };

/** Resolves the caller's user id, or null when unauthenticated. Better Auth plugs in here. */
export type Authenticator = (req: IncomingMessage) => Promise<string | null> | string | null;

export type HttpDeps = {
  storage: StorageAdapter;
  categoriser: Categoriser;
  bulk: BulkDeps;
  authenticate: Authenticator;
  /** Accepted `Host` header names (DNS-rebinding guard). Defaults to loopback names. */
  allowedHosts?: string[];
  log?: (e: HttpLogEvent) => void;
};

/** `--mock`: every request is the fixed dev user. */
export const mockAuthenticator = (userId: string): Authenticator => () => userId;

/** Static bearer token mapped to one user. Stand-in until Better Auth sessions are wired on Neon. */
export function bearerAuthenticator(token: string, userId: string): Authenticator {
  if (token.length < 16) throw new CategoriserError("config", STAGE, "bearer token must be at least 16 characters");
  const expected = Buffer.from(token);
  return (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const given = Buffer.from(m[1]!);
    return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
  };
}

const STATUS_BY_CODE: Record<string, number> = {
  validation: 400,
  bad_request: 400,
  unauthorized: 401,
  confirm_forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  already_undone: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
};

function fail(code: string, message: string): never {
  throw new CategoriserError(code, STAGE, message);
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    fail("unsupported_media_type", "content-type must be application/json");
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) fail("payload_too_large", "request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) fail("payload_too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    fail("bad_request", "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("bad_request", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function fieldName(raw: string): FieldName {
  const parsed = FieldNameSchema.safeParse(raw);
  if (!parsed.success) fail("validation", "unknown field name");
  return parsed.data;
}

function requireId(raw: string, what: string): string {
  if (!UUID.test(raw)) fail("validation", `${what} must be a uuid`);
  return raw;
}

/**
 * Field reject (SPEC section 8, decided here): clears a *suggested*, non-user field. It is an op
 * with an `opId` and an `expect` guard, so `POST /bulk/undo` restores it. Confirmed and user-set
 * fields are refused (`invalid_state`); withdrawing those is `bulk unconfirm`'s job. A later
 * pipeline re-run may suggest the field again: reject is a clear, not a block.
 */
async function rejectField(userId: string, itemId: string, name: FieldName, deps: BulkDeps): Promise<BulkResult> {
  const { storage } = deps;
  if (!(await storage.getItem(userId, itemId))) fail("not_found", "item not found");
  const current = (await storage.getFields(userId, itemId))[name];
  const opId = (deps.newId ?? randomUUID)();
  if (!current) return { opId, dryRun: false, affected: [], undoable: false };
  if (current.state === "confirmed" || current.by === "user") {
    fail("invalid_state", `${name} is user-set; use bulk unconfirm to withdraw it`);
  }
  await storage.applyFieldChanges(userId, [{ itemId, name, field: null, expect: current }], { opId });
  return { opId, dryRun: false, affected: [{ itemId, field: name, from: current, to: null }], undoable: true };
}

function publicItem(view: NonNullable<Awaited<ReturnType<Categoriser["get"]>>>) {
  const { file, ...rest } = view.item;
  const bytes = file ? Buffer.byteLength(file.bytes, "base64") : 0;
  return { ...view, item: { ...rest, ...(file ? { file: { mime: file.mime, name: file.name, bytes } } : {}) } };
}

export function createHttpHandler(deps: HttpDeps) {
  const log = deps.log ?? (() => {});
  const hosts = new Set((deps.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"]).map((h) => h.toLowerCase()));

  const hostAllowed = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
    return hosts.has(name);
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return fail("bad_request", "malformed path");
    }

    if (!hostAllowed(req)) fail("unauthorized", "host not allowed");

    // /health reports only coarse state, so it is the one unauthenticated route.
    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      send(res, 200, await deps.categoriser.health());
      return "GET /health";
    }

    const userId = await deps.authenticate(req);
    if (!userId) fail("unauthorized", "authentication required");

    if (method === "POST" && parts.length === 1 && parts[0] === "items") {
      const body = await readJson(req);
      // Preserve the AVI id and saved timestamp so retries are idempotent across the two stores.
      // The authenticated user id always comes from the server, never the browser.
      const { userId: _userId, ...input } = body;
      try {
        send(res, 202, await deps.categoriser.save({ ...input, userId } as never));
      } catch (err) {
        if (err instanceof CategoriserError && err.code === "duplicate" && typeof input.id === "string") {
          const existing = await deps.categoriser.get(userId, input.id);
          if (existing) {
            const queued = existing.status === "pending";
            if (queued) await deps.categoriser.enqueue(userId, input.id);
            send(res, 200, { itemId: input.id, queued, existing: true });
            return "POST /items";
          }
        }
        throw err;
      }
      return "POST /items";
    }

    if (method === "GET" && parts.length === 1 && parts[0] === "items") {
      const ids = await deps.storage.listItemIds(userId);
      const views = await Promise.all(ids.map((id) => deps.categoriser.get(userId, id)));
      const items = views
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .map(publicItem)
        .sort((a, b) => b.item.savedAt.localeCompare(a.item.savedAt))
        .slice(0, 50);
      send(res, 200, { items });
      return "GET /items";
    }

    if (method === "GET" && parts[0] === "items" && parts.length === 2) {
      const view = await deps.categoriser.get(userId, requireId(parts[1]!, "item id"));
      if (!view) fail("not_found", "item not found");
      send(res, 200, publicItem(view));
      return "GET /items/:id";
    }

    if (method === "POST" && parts[0] === "items" && parts[2] === "fields" && parts.length === 5) {
      const itemId = requireId(parts[1]!, "item id");
      const name = fieldName(parts[3]!);
      if (parts[4] === "confirm") {
        send(res, 200, await confirmField({ userId, itemId, field: name }, deps.bulk));
        return "POST /items/:id/fields/:name/confirm";
      }
      if (parts[4] === "reject") {
        send(res, 200, await rejectField(userId, itemId, name, deps.bulk));
        return "POST /items/:id/fields/:name/reject";
      }
    }

    if (method === "POST" && parts[0] === "tag-proposals" && parts.length === 2) {
      const body = await readJson(req);
      const result = await decideTagProposal(
        { userId, proposalId: requireId(parts[1]!, "proposal id"), decision: body.decision as never },
        { storage: deps.storage },
      );
      send(res, 200, result);
      return "POST /tag-proposals/:id";
    }

    if (method === "POST" && parts[0] === "bulk" && parts.length === 2) {
      const handlers = { revert: bulkRevert, accept: bulkAccept, undo } as const;
      const op = handlers[parts[1] as keyof typeof handlers];
      if (op) {
        const body = await readJson(req);
        send(res, 200, await (op as (i: never, d: BulkDeps) => Promise<BulkResult>)({ ...body, userId } as never, deps.bulk));
        return `POST /bulk/${parts[1]}`;
      }
    }

    if (parts.length === 1 && parts[0] === "taxonomy") {
      if (method === "GET") {
        const t = await deps.storage.getTaxonomy(userId);
        send(res, 200, { version: t.version, yaml: serializeTaxonomy(t) });
        return "GET /taxonomy";
      }
      if (method === "PUT") {
        const body = await readJson(req);
        if (typeof body.yaml !== "string") fail("validation", "yaml: expected string");
        let taxonomy: ReturnType<typeof parseTaxonomy>;
        try {
          taxonomy = parseTaxonomy(body.yaml);
        } catch (err) {
          if (err instanceof CategoriserError) throw err;
          return fail("validation", "taxonomy is not valid");
        }
        await deps.storage.putTaxonomy(userId, taxonomy);
        send(res, 200, { version: taxonomy.version });
        return "PUT /taxonomy";
      }
    }

    return fail("not_found", "no such route");
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let route = "unmatched";
    let status = 500;
    let code: string | undefined;
    try {
      route = await dispatch(req, res);
      status = res.statusCode;
    } catch (err) {
      code = err instanceof CategoriserError ? err.code : err instanceof Error ? err.name : "unknown";
      status = (err instanceof CategoriserError && STATUS_BY_CODE[err.code]) || 500;
      // Only CategoriserError messages are content-free by construction.
      const message = err instanceof CategoriserError && status !== 500 ? err.message : "internal error";
      if (!res.headersSent) send(res, status, { error: { code: status === 500 ? "internal" : code, message } });
    }
    log({ stage: "http", method: req.method ?? "?", route, status, code });
  };
}
