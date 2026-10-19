# Contract: AVI frontend and project integration

## Purpose
Integrate the scrapbook-style frontend supplied in `continue-conversation (1).zip` with AVI’s persistent app database and categorizer service. Adopt the reference’s capture-first scrapbook presentation while preserving AVI’s saved data, categorizer pipeline, and review behavior.

## Inputs
- Existing AVI `AppData`: collections, items, field values, positions, settings, and sample-data status.
- Persistent app SQLite database and its `/api/data`, `/api/items`, and health routes.
- Categorizer service URL and optional server-side bearer token (`CATEGORISER_URL`, `CATEGORISER_HTTP_TOKEN`).
- Capture, project selection, suggestion review, search, library-filter, and item-management actions from the scrapbook frontend.
- The reference frontend’s capture form, item cards, list composition, and visual treatment from `continue-conversation (1).zip`.
- Categorizer results: item state, extracted metadata, suggested fields, confidence, provenance, and processing status.

## Outputs
- The scrapbook-style capture and saved-item views shown in the supplied frontend reference, backed by persisted AVI data after reload.
- AVI project navigation, search, review, item selection, and item-management actions available through the integrated scrapbook UI.
- New captures retained in AVI and submitted to the categorizer without exposing its token to the browser.
- Categorizer suggestions represented in the frontend with their state, confidence, and provenance.
- Confirm and reject actions persisted in both systems without overwriting unrelated user-confirmed fields.
- Clear loading, offline, empty, and error states that preserve access to saved items.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | App starts with an empty app database | Schema and illustrative sample data initialize once; the scrapbook UI hydrates with those samples | Restarting does not duplicate seed items |
| 2 | App starts with existing app data | The scrapbook UI loads saved collections, items, fields, and positions from the app database | Persisted user edits take precedence over sample data |
| 3 | A person captures a valid URL or note | The item is saved to AVI and submitted to the categorizer; the UI shows pending processing until a result is available | A categorizer outage does not discard the saved item |
| 4 | Categorizer returns suggested fields | Suggestions appear in the matching project/item with confidence and provenance | A result never replaces a current user-confirmed field |
| 5 | A person confirms an eligible suggestion | The frontend shows the value as confirmed by the user and the change persists after reload | Categorizer history and app database remain consistent |
| 6 | A person rejects an eligible suggestion | The pending suggestion is removed or marked rejected according to the categorizer contract | Type/source and user-confirmed values cannot be rejected |
| 7 | Categorizer service is offline or returns an error | Saved items remain available; the UI identifies processing failure and offers a retry path | Do not fabricate successful suggestions |
| 8 | A request uses an unsupported proxy path or a missing/invalid token | The API rejects it without forwarding to an arbitrary host or exposing credentials | Proxy allowlist and server-only secret handling |
| 9 | A person searches and filters saved items, then reloads | Search and filters affect visible results; saved data remains unchanged | Persist only preferences already defined by AVI |
| 10 | Viewport narrows to 390 px | Scrapbook navigation, capture, item review, and core item actions remain reachable without horizontal overflow | No mobile-specific redesign is required |

## Edge cases that must be covered
- App database is unavailable at startup or fails during a write.
- Categorizer is unavailable before capture, during processing, or during review actions.
- The same item is submitted or processed more than once.
- Categorizer results arrive after the person has confirmed or edited a field.
- Existing browser-local data and server data differ during migration or recovery.
- Missing confidence, provenance, extraction title, URL, or optional item metadata.
- User credentials are absent, malformed, or rejected by the categorizer service.

## Explicitly out of scope
- Provisioning a Neon account, database, or credentials.
- Public deployment, multi-user authentication, or account management.
- Changes to categorizer model behavior, prompt policy, or extraction rules.

## Design brief
1. AVI is a personal work archive; help a maker capture a useful fragment, review it, and find it later.
2. Use the `desk-objects` move: make the saved-item UI feel like real notes and clippings arranged on a cutting mat.
3. Show actual AVI records and their saved context; mark illustrative seed items as samples.
4. Use highlighter yellow as the accent, drawn from the reference’s marker-on-cutting-mat desk; green is the work surface.
5. Use Unbounded for display, Figtree for interface text, Chakra Petch for labels, and Gochi Hand sparingly for handwritten notes.

## Status
- [x] Drafted
- [x] Reviewed by a human
- [x] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
