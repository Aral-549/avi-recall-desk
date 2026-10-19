# Contract: AVI app startup compatibility

## Purpose
Make the existing AVI app store compatible with its browser data store and rule-based categorizer so the frontend can hydrate, render its sample archive, and process saves without runtime import or shape errors. This does not change the independent `categoriser/` backend package.

## Inputs
- Browser storage availability and any saved `AppData` value.
- `DataStore.load()` result: nullable `data`, optional migration metadata, and optional recovery status.
- Store hydration and capture actions, including a URL or note, optional saved context, and active collection.
- Categorizer collection context built from the current app collections and confirmed tags.
- Abort signal for categorization work.
- A text prompt passed to idea tag matching.

## Outputs
- One `DataStore` instance backed by browser storage when available, with a safe in-memory fallback when storage is unavailable.
- Hydrated app state with existing saved data, recovered data, or seeded sample data.
- Categorization suggestions with valid source, type, tags, summary, and collection fields.
- A list of known taxonomy tags matched from idea prompt text.
- No uncaught runtime error from an optional subscription, storage recovery result, or cancelled categorization task.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | Browser storage is available and contains valid data | Hydration loads the saved data and subscribes to cross-tab updates | Preserve current storage schema and migrations |
| 2 | Browser storage is unavailable or throws during access | The app uses an in-memory store and still hydrates | In-memory data is not promised to survive reload |
| 3 | `load()` returns no saved data | Hydration builds the existing illustrative seed data and marks the store ready | Seed items remain labeled as samples in the UI |
| 4 | `load()` returns recovered backup or set-aside status | Hydration uses the returned data and surfaces a recovery notice | Do not expect a `warnings` field from `DataStore.load()` |
| 5 | A saved item is processed with collection tags and an abort signal | Categorization receives a valid context; aborting prevents a late suggestion from being committed | Existing confirmed fields remain protected by the store |
| 6 | A note or URL is categorized without an explicit collection match | It returns valid suggestion fields and a safe title fallback | Malformed URLs do not throw from title derivation |
| 7 | Idea text contains words matching known taxonomy tags | Tag matching returns only valid tag ids | Deterministic ordering for ties |

## Edge cases that must be covered
- `localStorage` access throws before a browser store can be constructed.
- A storage recovery result has no warning text or has no recovered data.
- A categorizer task is aborted while simulated latency is pending.
- Empty prompts and text with no known tags.
- A captured attachment has metadata beyond the categorizer's required name and MIME fields.

## Explicitly out of scope
- Changes to the independent categorizer CLI, database, provider, or extractor pipeline.
- New remote services, authentication, or network fetching.
- Changes to archive design, taxonomy values, or storage schema.
- Refactoring unrelated export/import helpers that are not in the frontend startup path.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
