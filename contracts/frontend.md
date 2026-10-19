# Contract: AVI frontend

## Purpose
Present saved items in a project-focused archive, surface useful items when a person returns to a project, and make suggested categorization easy to review. This UI uses the existing AVI data and store actions; it does not change categorization or storage behavior.

## Inputs
- `AppData`: collections, saved items, item field values, suggestion state, provenance, confidence, and sample-data status.
- Active view: Room, Review, or Library.
- Active project, selected item, search query, and library filters.
- User actions: change view or project, search, filter, select item, accept or reject an eligible suggestion, and open an item URL.
- Viewport: desktop-first, with a usable compact layout at 390 px.

## Outputs
- A Room view with project navigation, a visible Relevant now item, and nearby saved items.
- A Review view that distinguishes suggested fields from confirmed fields and shows available confidence and provenance.
- A Library view with search, filters, item selection, and item context.
- View and review actions reflected in the UI and existing AVI store.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | App data is hydrated and contains collections and saved items | Room view shows project navigation and saved items; the selected project and its Relevant now item are visually clear | Use real seed records when sample data is active; do not present sample activity as live |
| 2 | Person switches from Room to Library | Library view shows the saved-item collection with search and project, source, type, and tag filters | Search and filters update visible results without changing saved data |
| 3 | Person opens a suggested item for review | Review view shows its preview or content, each suggested field’s AI-suggested status, and its available confidence and provenance | Suggested and confirmed values must not look alike |
| 4 | Person accepts an eligible suggestion | The accepted value is shown as confirmed by the person; unrelated fields remain unchanged | Review actions are reversible through the existing undo behavior when available |
| 5 | Person rejects an eligible suggestion | The rejected suggestion is removed from the pending review state; unrelated confirmed fields remain unchanged | Type and source are not rejectable |
| 6 | Search has no matches, or the selected project has no items | The current view shows a clear empty state and an obvious way to clear filters or change project | No fabricated items |
| 7 | Viewport narrows to 390 px | Navigation remains reachable, content reflows without horizontal scrolling, and body text remains readable | Preserve all core actions |

## Edge cases that must be covered
- App data is still hydrating or storage reports an issue.
- An item has no title, URL, attachment preview, or optional provenance/confidence value.
- A selected item is deleted or filtered out while its detail is open.
- A search query and multiple filters produce no results.
- Reduced-motion preference is enabled.
- Suggested fields include non-rejectable type or source values.

## Explicitly out of scope
- Changes to the categorizer, extraction, storage, taxonomy, or provider pipeline.
- New backend APIs, authentication, or network fetching.
- Login, onboarding, mobile-specific screens, and a separate design system.

## Design brief
1. AVI helps people retrieve and review saved links, notes, and screenshots within a project.
2. The Room puts one contextually useful saved item above the archive when a person returns.
3. Show actual AVI seed content, including its source, project, saved context, and suggestion state.
4. Use the existing warm-paper and orange signal palette; the orange marks a surfaced item or pending review.
5. Use the project’s existing Instrument Serif display, IBM Plex Sans interface, and DM Mono metadata typefaces.

## Status
- [x] Drafted
- [x] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
