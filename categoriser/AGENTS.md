# AGENTS.md — AVI CATEGORISER contracts

Read `SPEC.md` for the approved design. This file tracks what is actually implemented and the invariants every change must keep.

## Non-negotiable invariants

1. A model never writes a `confirmed` value. Only `by:"user"` may set `state:"confirmed"`.
2. Every output field carries provenance: `{ value, state, by, model?, modelVersion?, confidence?, at }`.
3. The whole pipeline works with no LLM, no network, no AWS (`--mock`).
4. Model output is validated by `ModelSuggestionSchema` (strict). Invalid -> retry once -> discard entirely -> rule fallback. Never partially accept.
5. Page content is untrusted. It goes in a separate `<untrusted_content>` section, never in the system prompt, and never in logs.
6. `localOnly: true` blocks every cloud call for that item. Redaction runs before any cloud call.
7. Tags in `tags` must be taxonomy ids. New tags only via `tagProposals`.
8. Generic-link fetching happens only in the Python sidecar (single SSRF surface). The TS side never fetches arbitrary URLs.
9. Bulk revert touches suggestions only. `unconfirm` is opt-in, dry-run by default, undoable.
10. Never log raw secrets, matched redaction values, or full page content. Log counts and byte sizes.

## Stage status

| Stage | Module | Status | Tests |
|---|---|---|---|
| schemas | `src/schemas/index.ts` | done | via stage tests |
| 1 detect | `src/detect/index.ts` | done | `test/detect.test.ts` |
| 2 extract | `src/extract/` | done | `test/extract.test.ts` |
| 3 redact | `src/redact/` | done | `test/redact.test.ts` |
| taxonomy | `src/taxonomy/` | done | `test/taxonomy.test.ts` |
| storage | `src/storage/` | done (SQLite); Neon adapter pending with HTTP stage | `test/storage.test.ts` |
| 4 similarity | `src/similarity/` | done | `test/similarity.test.ts` |
| 5 suggest + providers | `src/suggest/`, `src/providers/` | done | `test/suggest.test.ts`, `test/providers.test.ts` |
| 6 route + pipeline | `src/route/`, `src/pipeline.ts` | done | `test/route.test.ts`, `test/pipeline.test.ts` |
| bulk ops | `src/bulk/` | done | `test/bulk.test.ts` |
| confirm + tag decisions | `src/bulk/` (`confirmField`), `src/proposals/` | done | `test/cli.test.ts` |
| CLI | `src/cli/` | done | `test/cli.test.ts` |
| HTTP | `src/http/` | pending | |
| sidecar | `../categoriser-extractor/` | done | `tests/test_extractor.py` (pytest) |
| eval | `src/eval/`, `fixtures/` | pending | |

## Stage contracts (implemented)

### detect(item: RawItem): DetectResult
- Pure, sync, no I/O. Never throws for a schema-valid item.
- Confidence: 1.0 URL host/path pattern, 0.8 extension-only, 0.7 MIME-only, 0.5 default.
- Host matching is exact-suffix on `hostname` (parsed by `URL`), never substring on the raw string.
- `project` is seeded only from `currentProject` (by:"rule", 0.9); otherwise `null` and left to similarity.

### StorageAdapter (`src/storage/types.ts`), SqliteStorage (`src/storage/sqlite.ts`)
- Every method takes `userId`; every query filters by it. Writes onto another user's item throw `not_found`.
- `writeField` rejects `state:"confirmed"` unless `by:"user"` (`confirm_forbidden`) and validates via `fieldSchema`.
- Fields are versioned: one `current` row per (item, name); older versions kept. Every write/clear appends to `field_history` with optional `opId` (bulk ops + undo read it back via `getHistoryByOp`).
- `applyFieldChanges` is all-or-nothing (single transaction). `field: null` clears. An optional per-change `expect` (compare-and-set; `null` = no current value) aborts the whole batch with `conflict` if the current field differs at write time. Equality is `sameField` (key-order-insensitive JSON). The Neon adapter must implement the same guard inside its transaction.
- Date filters use a stored `at_ms` so mixed timezone offsets compare correctly.
- Taxonomy seeds per user on first read; `putTaxonomy` requires a strictly greater version.
- Tag proposals can be decided once (`invalid_state` afterwards).
- Deviation from SPEC §6: raw parameterised SQL in a portable subset instead of Drizzle, because Drizzle has no `node:sqlite` driver. The Neon adapter will reuse the same DDL.
- `node:sqlite` is loaded via `createRequire` because vitest 2 strips the `node:` prefix.

### extract (`src/extract/`)
- `extract(item, {type, source}, deps)` never throws for extraction problems; only misconfiguration (non-loopback `sidecarUrl`) throws `CategoriserError{code:"config"}`. Non-`ok` results carry no content.
- Dispatch: file (pdf -> pdfjs first 3 pages; image/* -> OCR) > no URL (`skipped`) > social/reddit/x/slack (`skipped`) > `localOnly` (`skipped`) > mock (fixtures map or `unavailable`) > GitHub repo URL (api.github.com) > YouTube (oEmbed) > sidecar.
- Interpretation: `localOnly` blocks *every* outbound call (GitHub, oEmbed, sidecar page fetch); OCR/PDF still run locally. OCR only downloads tesseract language data when network is allowed, unless `TESSDATA_PATH` points at local traineddata.
- TS only ever reaches `api.github.com`, `www.youtube.com/oembed` and the loopback sidecar (`fetchCapped` allow-list, manual redirects re-checked per hop, 5 s, 1 MB). Generic pages are sidecar-only.
- All text is re-sanitised in TS (controls, zero-width, bidi overrides stripped; 20k cap), even from the sidecar.
- pdfjs-dist 6 has no `isEvalSupported` (eval was removed). Tests build PDFs with `test/helpers/pdf.ts`; OCR is injected in tests.

### similarity (`src/similarity/`)
- `similarity({userId,itemId,text}, {storage, embedder})`: `text` must be the *redacted* text. Embeds, `putEmbedding`, then ranks projects (top 3) by cosine to the centroid of items whose `project` field is `state:"confirmed"` and the user's other items (top 5). Scores = cosine clamped to [0,1], 4 dp; ties break by name/id.
- Excluded: the item itself (no self-voting after confirmation), suggested project fields, vectors from a different model or dimension, other users. Blank text -> empty result, nothing stored.
- Embedders: `createMiniLmEmbedder({allowDownload, cacheDir})` (`all-MiniLM-L6-v2`, 384-d, via `@xenova/transformers`; cache `CATEGORISER_MODEL_CACHE` or `~/.cache/avi-categoriser/models`) falls back to `hashEmbedder` (`hash-v1`, 512-d signed feature hashing, deterministic) if the model can't load or a call fails. `embeddingModel` reports the model actually used. Weight downloads send no item data.
- Items embedded under one model aren't re-embedded when the active model changes; they just drop out of comparisons until re-run.
- Calibration note for stage 8: with MiniLM a clear project match scores about 0.6 and unrelated about 0.05, so the 0.80 project threshold in SPEC §5 will route almost everything to review. Revisit with eval data.
- `sharp` build approved (transformers imports it); `protobufjs` postinstall not needed.
- Opt-in real-model test: `CATEGORISER_MODEL_CACHE=<dir with Xenova/all-MiniLM-L6-v2> pnpm test`.

### providers (`src/providers/`)
- `Provider { id, modelVersion, supportsVision, cloud, status(), complete(req) }`. `createProvider(id, env)` never touches the network; failures surface on `complete` as `ProviderError{code}`: `rate_limited`/`unavailable` (retryable), `budget_exceeded`/`not_configured`/`bad_request` (fail closed). Error messages are error names/HTTP codes only.
- Mock: offline, deterministic, builds replies only from allowed tag ids + metadata (never echoes content). `cloud` defaults to true so `--mock` mirrors localOnly gating; injectable `respond(req, call)`.
- Bedrock: Converse API via `@aws-sdk/client-bedrock-runtime` (SDK retries off, 30 s abort). Default `us.anthropic.claude-haiku-4-5-20251001-v1:0` (inference profile; bare model ids fail on-demand), `BEDROCK_MODEL_ID`, `AWS_REGION` (default `us-east-1`). `status()` is a credential-env heuristic; the real chain is resolved on first call.
- Gemini: REST `generateContent` on the fixed Google host, key in `x-goog-api-key` (never in URL), `redirect:"error"`, `responseMimeType: application/json`. Default `gemini-flash-latest`, `GEMINI_MODEL` validated against a strict id regex. `gemini-2.5-flash*` gets `thinkingBudget: 0` so thinking can't eat the 600-token cap. `BudgetGuard` (sliding RPM/RPD, defaults 10/250, `GEMINI_RPM`/`GEMINI_RPD`) fails closed with no fetch.
- Kimi, Anthropic-direct, Ollama: `NotConfigured` stubs (Ollama `cloud:false`).

### suggest (`src/suggest/`)
- `suggest(input, {taxonomy, provider, sleep?, random?, now?, log?})` never throws and always returns `tags`/`oneLineSummary`/`draftWhySaved` Fields (`state:"suggested"`), plus `status`, `by`, `calls`, `projectPick`, `tagProposals`. All text inputs (title, text, userNote) must be redacted by the caller.
- Gating: no provider -> `no_provider`; `localOnly && provider.cloud` -> `skipped_local_only` with zero calls. Image sent only when `visionOptIn && supportsVision && !localOnly`.
- Prompt (`prompt.ts`) follows SPEC §4 exactly; content capped 6000, note 500; `<untrusted_content>`/`<metadata>` tags inside any untrusted string are replaced with `[tag removed]`; candidate project names are single-lined with `|` -> `/`. `MODEL_SUGGESTION_JSON_SCHEMA` is a hand-written mirror (a test checks keys/required match the zod schema).
- Validation (`validate.ts`): one code fence tolerated; otherwise JSON + strict schema + every tag resolves via taxonomy + proposals must be new and unique + a kept project needs `confidence.project`. Strings are stripped of control/bidi chars and re-validated. A non-candidate project is dropped (SPEC §1), not rejected.
- Retries: invalid -> one retry with `RETRY_NOTE` appended -> rules (`invalid_output`). Retryable provider errors back off 1 s/4 s/16 s (+0-25% jitter), so up to 4 calls, then rules. Model field confidences: tags = `confidence.tags`; summary and draftWhySaved = `confidence.summary` (ranking signal only, per redline 2).
- Rule fallback (`rules.ts`): taxonomy keywords (0.6), title or first 120 chars clipped at a word (0.5), `Saved from {source} while working on {project}` (0.3).
- Log event: status, call count, invalid reasons, prompt/output char counts. No content.
- Open for stage 12: the rule summary copies the (redacted) page title, so an injection page with a hostile *title* would surface it in `oneLineSummary`. The eval's "no injection string in any output field" assertion will catch this; decide then whether rule summaries should prefer the user note.

### route (`src/route/`)
- `route(fields, thresholds?) -> {route, review: FieldName[]}`, pure. Only `by:"model"|"embedding"` fields with a non-empty value are gated; rule and user fields never decide. Threshold inclusive, default 0.80 per field, missing confidence counts as 0. `validateThresholds` throws `CategoriserError{code:"config"}` for unknown names or values outside [0,1]. Calibrated values (stage 12) are passed in as `thresholds`.
- `staleness({extraction, savedAt, now}, at)`, by:"rule": `not_found` -> dead (0.9); else age from `publishedAt` then `meta.pushedAt` (0.7), else `savedAt` (0.4). fresh < 180 d <= aging < 730 d <= stale. Dates > 1 day in the future are ignored. blocked/timeout/error/unavailable never mean dead.

### pipeline (`src/pipeline.ts`)
- `createCategoriser({storage, embedder, provider?, extract?, thresholds?, concurrency=2, log?, now?, suggest?})` -> `{save, process, enqueue, get, idle, health}`. Only this file composes stages.
- `save` validates (`CategoriserError{code:"validation"}` lists paths only, never values), persists the item + stage 1 fields, enqueues and returns. `id`/`savedAt` default to `randomUUID()`/now. `{process:false}` skips enqueueing.
- `process` (stages 2-6) never fails because of extraction: an `extract` throw becomes `status:"error"` with `code` in the log. Order: extract -> saveExtraction -> redact (title, user note, content separately) -> similarity on redacted text (failure -> empty ranking) -> suggest -> one `applyFieldChanges` -> tag proposals -> `setItemMeta` last (a route is what marks an item processed; `get` reports `pending` until then).
- A bare note (no url/file) is the content and goes in `<untrusted_content>`; otherwise `item.text` is the user note in `<metadata>`.
- Fields with current `by:"user"` are never overwritten by a re-run (`keptUserFields`). The pipeline never writes `confirmed`.
- Project field: `currentProject` -> rule 0.9 on top + similarity alternatives. Otherwise a valid model pick re-orders the similarity ranking (by:"model", confidence = the pick's *similarity score*, since model confidence is only a ranking signal). Otherwise by:"embedding" with confidence = top-1 score (`model` = embedding model id, so bulk revert can target it). No candidates -> `[]`, which routing ignores.
- Candidates sent to the model: `currentProject` + similarity top 3 (max 4).
- Vision: pixels can't be redacted, so if any redaction count > 0 for the item the image is withheld from the provider (`visionWithheld` in the suggest log). Text still goes, redacted.
- Tag proposals: stored `pending` once per (item, tag), including previously rejected tags, so a re-run never re-proposes.
- Queue: `p-queue`, concurrency 2. `enqueue` dedupes per (user, item) while queued or running; failures log `{stage:"pipeline", code}` (code/name only, never message) and resolve `null`, leaving the item pending.
- `health()`: storage, provider `status()` (or `none`), sidecar (`mock` when `extract.mock`, else `/health` probe), queue size/pending. `ok` follows storage only; sidecar/provider being down degrades but doesn't fail.
- Not atomic across fields/proposals/meta (separate writes); a crash between them leaves the item `pending`, and a re-run is safe (user fields kept, proposals deduped).
- Calibration still open (see similarity note): with MiniLM, project rankings rarely reach 0.80, so most non-`currentProject` items route to review until stage 12 calibrates.

### bulk (`src/bulk/`)
- `bulkRevert`, `bulkUnconfirm`, `bulkAccept`, `undo`, each `(input, {storage, now?, newId?, log?}) -> BulkResult`. Input is parsed with the strict SPEC schemas (`UndoSchema` added). Bad input -> `CategoriserError{code:"validation"}` naming paths only. Each write is one `applyFieldChanges` with an `opId` and an `expect` guard per change, so a field changed concurrently (pipeline re-run, user edit) aborts the whole op with `conflict` and nothing is written. Log: `{stage, op, opId, dryRun, affected}` counts only.
- `affected[].from/to` are whole Field objects (or `null`), so previews show provenance. `undoable = !dryRun && affected.length > 0`. Ops with no matches still return an `opId`, but there's nothing to undo.
- **revert**: current `state:"suggested"`, `by != user` fields with `model` (+ `modelVersion`), `at` strictly after `afterDate`, optional `fields` (`[]` = nothing). Clears them (SPEC: "removes"). It doesn't restore an older version, doesn't touch confirmed values, and doesn't recompute `route`.
- **toConfirmed(field, name, at)**: the single confirm transform: `by:"user"`, `state:"confirmed"`, value kept, origin `model`/`modelVersion` copied as provenance, confidence dropped. Project narrows to the top entry, because similarity counts a confirmed item toward *every* project in the list. CLI/HTTP confirm must use this, or unconfirm can't find their confirmations.
- **unconfirm** (dry run by default): confirmed `by:"user"` fields whose provenance is `model`. The origin is the version immediately before the current one; it must be a suggestion from that model (+ version) with `at` strictly after `afterDate` (suggestion time, not confirm time), and `toConfirmed(origin).value` must equal the current value. Restores that origin version, so items go back to suggested, and a follow-up revert can remove them. User-edited confirmations and values the user typed are never touched.
- **accept**: items whose top project (trimmed) equals `project`, where the project is already confirmed or has `confidence >= minConfidence`. Confirms that item's suggested, non-user, non-empty fields with `confidence >= minConfidence` (inclusive, like routing). Default fields exclude `staleness`: confirming it would freeze it (the pipeline never overwrites user fields). Pass `fields` to include it.
- **undo**: reads `getHistoryByOp`, groups per (item, field), restores the pre-op value. Precondition: every touched field still equals its post-op value. Otherwise `already_undone` (all back at pre-op) or `conflict` (anything else); either way nothing is written. An undo is an op with its own `opId`, so undoing it is a redo. Restored fields keep their original `at`, so date-filtered ops still match them. User-scoped: another user's opId -> `not_found`.

### confirm + tag decisions (shared by CLI and the coming HTTP wrapper)
- `confirmField({userId,itemId,field}, BulkDeps) -> BulkResult` (`src/bulk/`): the single-item confirm. It goes through `toConfirmed` and is an op with an `opId` + `expect` guard, so `undo` reverses it and `bulk unconfirm` finds it. Already confirmed -> no-op (`affected: []`, not undoable). Missing/empty value -> `invalid_state` (a confirmed empty project would freeze the item out of re-ranking). Unknown item -> `not_found`. HTTP `POST /items/:id/fields/:name/confirm` must call this.
- `decideTagProposal({userId, proposalId, decision}) -> {proposal, taxonomyVersion, taxonomyChanged}` (`src/proposals/`): approve appends the tag to the *taxonomy* (version + 1) via `TaxonomyIndex.approveProposal`. It does not add the tag to the item's `tags` field (SPEC §3 "appends to tags" read as taxonomy tags). If the tag already resolves (the same tag was approved from another item), it only marks the proposal approved. The taxonomy is written before the proposal state; a crash in between leaves it pending, and re-approving is a no-op on the taxonomy. Decided once (`invalid_state`); user-scoped (`not_found`).
- Field *reject* (SPEC §8 HTTP) is still undefined: clearing a suggestion would just be re-suggested on the next run. Decide its semantics in stage 11.

### CLI (`src/cli/`)
- `run(argv, io, factory?) -> exitCode` never throws. Exit 0 ok, 1 operational error (`error [code]: message`, or `{"error":{code,message}}` with `--json`), 2 usage. Only `CategoriserError` messages are printed (content-free by construction); other errors print their name and `unexpected failure`.
- Parsing: `node:util` `parseArgs`, no deps. A loose pass finds the one- or two-word command (`bulk revert`, `proposals approve`, `taxonomy import`), then a strict pass allows only global + that command's options.
- Runtime (`runtime.ts`): SQLite at `--db` / `$CATEGORISER_DB` / `~/.local/share/avi-categoriser/{mock,live}.db`. User `--user` / `$CATEGORISER_USER` / `local` (the library trusts the caller; Better Auth is HTTP-only). Provider `--provider` / `$CATEGORISER_PROVIDER` / `bedrock` (live) or `mock` (`--mock`); `none` = rules only. `--mock` = mock provider + `hashEmbedder` + `extract.mock`, and refuses any other provider so it can't reach the network. A test stubs `fetch` to throw and asserts it's never called.
- `save` runs stages 2-6 inline (`save({process:false})` then `process`), since the process exits when the command returns. `--no-process` leaves it pending for `categoriser process <id>`. Input: `-` = stdin note, `http(s)://` = URL (+ `--note`), `.txt/.md` = bare note, `.pdf/.png/.jpg/.jpeg/.gif/.webp` = file (+ `--note`), size checked against `MAX_FILE_BYTES` before reading. Other schemes and extensions are usage errors.
- `confirm` uses `confirmField`. `bulk unconfirm` is a dry run unless `--apply`. `--after` accepts ISO with offset or bare `YYYY-MM-DD` (midnight UTC). `--fields a,b` is validated against `FieldNameSchema`.
- Output: human tables by default, `--json` for the raw result. `show --json` replaces the base64 file payload with `{mime,name,bytes}`. Every printed string goes through `clean()`, which strips C0/C1 controls (ANSI escapes), bidi overrides and zero-width chars, because page-derived titles and summaries reach the terminal.
- `--verbose` streams pipeline log events as JSON lines on stderr (already content-free; a test asserts a note's text doesn't appear).
- `eval` and `serve` are registered (they appear in help) but return `not_implemented` until stages 12 and 11. `taxonomy import <file>` is an addition to SPEC §9 (CLI twin of `PUT /taxonomy`). `categoriser.config.json` thresholds aren't loaded yet; stage 12 defines that file.

### sidecar (`../categoriser-extractor/`)
- `python -m extractor [--mock] [--port 8787]`, binds 127.0.0.1 only. Venv: `uv venv .venv && uv pip install --python .venv/bin/python -e '.[test]'`; tests: `.venv/bin/python -m pytest`.
- Deviation from SPEC §10: fetching uses httpx with `GuardedTransport` instead of Scrapling's `Fetcher` (Scrapling `Selector` still does all parsing). The guard resolves DNS, rejects if *any* answer is non-public, then connects to the vetted IP while TLS verifies the original hostname, which closes DNS rebinding. Scrapling's Fetcher can't pin IPs.
- robots.txt: 4xx -> allow, 401/403/5xx/unreachable -> disallow (fail closed); cached 24 h per origin. Disk cache stores only `ok`/`not_found`, 7 d TTL.
- Unsupported content types -> `skipped`. Any crash -> `{"status":"error"}` with HTTP 200.

## Conventions
- ESM, strict TS, `node:` imports. Zod at every boundary. Tests in `test/`, one file per stage, written in a separate pass after the stage.
- Commands: `pnpm typecheck`, `pnpm test`, `pnpm cli <cmd>`, `pnpm serve --mock`.
