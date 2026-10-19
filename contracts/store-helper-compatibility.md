# Contract: AVI store helper compatibility

## Purpose
Provide the layout and URL-title helpers that `lib/avi/store.ts` already calls so the AVI app can compile and preserve its existing item-placement and capture behavior. This contract covers helper behavior only; it does not change the categorizer, persistence, or the frontend views.

## Inputs
- `pageItems`: live saved items on the active page, including any per-page manual positions.
- `page`: active page key (`all`, `unfiled`, or a collection id).
- `boardCols`: positive integer column count used by the board layout.
- `item`: a newly captured item with an optional existing position.
- `rects`: occupied item rectangles from the active page layout.
- `view`: current viewport origin and dimensions.
- `url`: a candidate URL string; caller-supplied title may already exist.

## Outputs
- A page layout mapping item ids to positions.
- A position for a new item that avoids existing item rectangles when placement is enabled.
- A display title derived from a valid URL, or `undefined` for malformed URLs.

## Behavior cases (input → expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | A page with manually positioned items and unpositioned items | Preserve manual positions and assign positions to remaining items without overlap | Uses the existing card geometry and deterministic layout order |
| 2 | A new item with tidy mode enabled, reduced motion enabled, or viewport width below 640 px | Return the item without adding a board position | Existing store behavior in `placeNew` |
| 3 | A new item with placement enabled and occupied rectangles | Return a position outside the occupied rectangles, within the current view where space permits | Existing store call passes `view` and item dimensions |
| 4 | URL `https://github.com/owner/project` and no caller-supplied title | Derive `owner/project` | Caller-supplied title takes precedence |
| 5 | URL with a readable final path segment such as `https://site.test/a-useful-page` | Derive `A useful page` | Decode the segment and replace common separators |
| 6 | Malformed URL | Return `undefined` without throwing | Capture remains usable as a note |

## Edge cases that must be covered
- Empty page layout and no occupied rectangles.
- A viewport too small to fit a card, or a view with a non-zero origin.
- Numeric-only URL path segments and URL encoding that cannot be decoded.
- Existing manual positions that overlap or sit near the viewport boundary.

## Explicitly out of scope
- Changes to categorization, confidence, suggestion review, storage, or migrations.
- Changes to card geometry, the board UI, or current room/library/review behavior.
- Fetching URLs or reading page metadata from the network.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
