# Contract: AVI SQLite database and backend server

## Purpose
Provide a persistent local SQLite database seeded with initial sample items and collections, and an HTTP/API server layer that allows the AVI frontend to load, query, save, and update scrap items and their categorized fields. It hands off AI classification inference to the categoriser pipeline and client UI rendering to the Next.js frontend.

## Inputs
- Database path: filesystem path to SQLite database file (e.g. `avi.db`), or in-memory `:memory:` for testing.
- Seed dataset: sample items, collections, and taxonomy from seed definitions (`lib/avi/seed.ts` and `categoriser/taxonomy.seed.yaml`).
- API requests:
  - `GET /api/data`: optional query parameters for filtering by collection or status.
  - `POST /api/items`: payload with `url`, `text`, `why`, `collectionId`, or attachment metadata.
  - `PATCH /api/items/:id/fields`: payload with field name (`tags`, `oneLineSummary`, `collection`), new value, and confirmation state.
  - `DELETE /api/items/:id`: soft or hard deletion of an item.
  - `GET /api/health`: probe for database connectivity and statistics.

## Outputs
- A populated SQLite database file with tables for `items`, `collections`, `fields`, `field_history`, and `taxonomy`.
- HTTP responses matching the frontend data model:
  - `GET /api/data`: `{ items: Record<string, Item>, collections: Collection[], taxonomy: Tag[] }` with HTTP 200.
  - `POST /api/items`: `{ item: Item }` with HTTP 201 on success, or HTTP 400 on invalid input.
  - `PATCH /api/items/:id/fields`: `{ item: Item }` with HTTP 200 on success, or HTTP 404 if item does not exist.
  - `DELETE /api/items/:id`: `{ success: true, id: string }` with HTTP 200.
  - `GET /api/health`: `{ ok: boolean, database: "sqlite", itemCount: number, collectionCount: number }`.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | Server initializes against a new or empty SQLite database | Database tables are created with proper schemas and populated with seed collections and sample items | Database schema is compatible with `categoriser/src/storage/sqlite.ts` |
| 2 | Frontend sends `GET /api/data` | Returns JSON containing all active collections, items, and their field values with HTTP 200 | Items contain both confirmed and suggested fields |
| 3 | Frontend sends `POST /api/items` with a valid note or URL | Inserts new record into SQLite `items` and initial `fields` tables, returns created `Item` with HTTP 201 | New items get pending or suggested status |
| 4 | Frontend sends `PATCH /api/items/:id/fields` accepting a suggested field | Updates field state to `confirmed`, sets `by: "user"`, records change in `field_history`, returns updated item with HTTP 200 | Conforms to rule: only user can set confirmed state |
| 5 | Frontend sends `PATCH /api/items/:id/fields` rejecting a rejectable field | Clears or resets the field value, records previous state in history, returns updated item with HTTP 200 | Type and source fields cannot be rejected |
| 6 | Frontend sends `DELETE /api/items/:id` | Marks item deleted or removes record, returns success with HTTP 200 | Soft-deleted items are excluded from subsequent `GET /api/data` |
| 7 | Frontend sends `GET /api/health` | Returns `{ ok: true, database: "sqlite", itemCount: N, collectionCount: M }` with HTTP 200 | Confirms server and SQLite are operational |

## Edge cases that must be covered
- Database file directory does not exist yet (server should create directory automatically).
- Concurrent reads and writes (WAL mode enabled, transactions used for atomic updates).
- Missing or malformed request payload (validation returns HTTP 400 with descriptive error code).
- Request targeting non-existent item id (returns HTTP 404).
- Empty database on first startup (auto-seeds without duplicate key errors).
- Server restart preserves all previously written user edits and confirmations.

## Explicitly out of scope
- Third-party cloud authentication and user session management (runs in local dev mode).
- Heavy external web scraping and remote browser automation (handled by extractor sidecar).
- Direct modification of frontend presentation components.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [x] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
