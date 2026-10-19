# Contract: AVI sketchbook main UI integration

## Purpose
Make the supplied `avi_recall_desk.tsx` sketchbook interface AVI's primary frontend while connecting its interactions to the existing AVI app store, SQLite archive, and categoriser service. Preserve the existing archive and categoriser data contracts; the sketchbook is a presentation and interaction layer, not a second data store.

## Inputs
- The supplied `avi_recall_desk.tsx` component, hand-drawn visual treatment, and four views: Desk, Review, Library, and Ask.
- Existing `AppData`, `Item`, `Collection`, file/blob storage, undo behavior, SQLite APIs, and migrations in `lib/avi/` and `lib/db/`.
- Existing categoriser HTTP proxy, review endpoints, and Bedrock provider settings (`CATEGORISER_PROVIDER`, `AWS_REGION`, `BEDROCK_MODEL_ID`, and server-side AWS credentials or Bedrock bearer token).
- Captures containing a URL, text, an attachment, or a sketch; user actions to select a room, review suggestions, search/filter, edit, delete, and undo.
- Responsive viewport, reduced-motion preference, clipboard and file APIs, and categoriser/database availability.

## Outputs
- `app/page.tsx` presents the sketchbook design as AVI's primary UI. Existing server, SQLite storage, categoriser, and project data remain in the repository and continue to serve the frontend.
- The UI reads and writes the existing AVI `AppData` through its existing data store. It does not create an independent `avi:sketchbook:v6` source of truth.
- Saved links, notes, uploads, and sketches survive reload using existing item/blob persistence; failed writes and quota errors are visible and do not claim a save succeeded.
- Captures are saved before categoriser processing. Bedrock suggestions are mapped into AVI fields with actual provider, model, confidence, and review state. User-confirmed fields are never overwritten by later model results.
- Confirm/reject actions synchronize through the existing categoriser API and report success only after the backend confirms the action. Offline or provider errors leave the saved item available and offer a retry path where supported.
- Ask AVI is identified accurately as archive search unless a separately specified answer-generation endpoint is implemented; it must not claim that keyword matching is an LLM response.
- Old presentation code and promotional files are removed only when they are no longer used by the app. Backend code, schemas, migrations, contracts, assets required by the app, package manifests, lockfiles, and tests are retained.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | App starts with existing SQLite data | Sketchbook UI loads those projects, items, saved context, and field provenance | Do not replace populated data with the TSX seed data |
| 2 | App starts with an empty archive | Existing seed/migration behavior runs once; the UI marks illustrative records as samples | Reload does not duplicate samples |
| 3 | Person saves a note, URL, upload, or sketch | Item and attachment persist through the existing store; categoriser processing begins when applicable | A categoriser outage does not discard the save |
| 4 | Bedrock returns valid categorisation | Suggestions appear with actual model provenance and confidence and can be reviewed | Reuse the existing structured categoriser prompt/output schema |
| 5 | Bedrock is unavailable or returns invalid output | Item stays saved; UI reports processing failure without inventing successful model suggestions | Mock mode remains usable |
| 6 | Person confirms or rejects a suggestion | Existing categoriser review API and SQLite archive reflect the same confirmed/rejected state | Only allowed fields can be rejected |
| 7 | Person searches, filters, changes room, or opens item details | Results reflect the existing AppData; actions do not create a second copy of the item | Search state is view state unless existing settings define persistence |
| 8 | User edits, deletes, or undoes an item change | Existing store and undo semantics apply and persist across reload | No parallel local mutation path |
| 9 | Viewport is 390 px or reduced motion is enabled | Navigation and primary capture/review actions remain reachable, without horizontal overflow or nonessential motion | Keep the sketchbook visual language |
| 10 | AWS Bedrock bearer key is configured | Key is read server-side from `AWS_BEARER_TOKEN_BEDROCK`; browser bundles, prompts, logs, and Git history never contain it | AWS credentials via the SDK chain remain supported |

## Edge cases that must be covered
- Existing browser and SQLite data disagree or one store is unavailable.
- Attachment exceeds the supported size/type or IndexedDB/SQLite write fails.
- Browser reload occurs while categorisation is pending.
- Duplicate capture, rapid review actions, or a model response arrives after a user edit.
- Missing model confidence/provenance, unavailable Bedrock region/model access, expired bearer key, or absent credentials.
- Empty search/review results and records missing URL, preview, title, or optional fields.
- Existing user changes and uncommitted files are present when removing obsolete presentation assets.

## Explicitly out of scope
- Deleting the GitHub repository or wiping backend, database, categoriser, CI, or documentation files.
- Committing or pushing until this integration contract is reviewed and the resulting change is ready for the requested GitHub update.
- Adding a second independent localStorage item database or changing categoriser inference policy/schema without a separate contract.
- Claiming semantic chat or live Bedrock inference for deterministic/local mock behavior.
- Exposing AWS credentials or the categoriser HTTP token to the browser.

## Design brief
1. Match the supplied `avi_recall_desk.tsx` visual composition: textured grey graphite paper, hand-drawn square frames, taped study cards, and the oversized architectural AVI wordmark.
2. Keep its top bar with the room selector, `studies & pad` / `triage` / `index` / `ask avi` navigation, and tools menu; do not substitute a permanent project sidebar.
3. The Desk view begins with the large sketched AVI hero beside an inline multi-modal capture pad, then shows real archive items as a three-column Studies grid.
4. Keep the source's sketch, illustration, hand annotation, and type specimen treatments: Cabin Sketch display, Reenie Beanie notes, Cutive Mono labels, and Figtree interface text.
5. Keep the original four view compositions (Desk, Review, Library, Ask) while connecting their actions to the existing AVI store; seed records remain visibly illustrative.
6. Use the source's pencil-grey palette (#ecebe7 paper, #2c2c2f graphite, #424246 lead) and minimal interaction tint; do not introduce kraft paper, orange accents, or a highlighter-yellow desk treatment.

## Status
- [x] Drafted
- [x] Reviewed by a human
- [x] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
