/**
 * Board geometry. Every note has the same footprint, so the strict grid underneath is real and
 * overlap is a pure rectangle test. Free dragging + collision push: the dragged note stays where
 * it was dropped and overlapping neighbours are pushed out of the way, deterministically.
 */
import type { Item, Point } from "./types";

export const CARD_W = 264;
export const CARD_H = 252;
export const GAP = 32;
export const PAD = 48;
/** Max per-note visual offset from `messFor` (px). Rects include it so visual overlap is impossible. */
const MESS = 6;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectAt = (p: Point): Rect => ({ x: p.x - MESS, y: p.y - MESS, w: CARD_W + MESS * 2, h: CARD_H + MESS * 2 });

export function overlaps(a: Rect, b: Rect, gap = 8): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export const cellPoint = (index: number, cols: number): Point => ({
  x: PAD + (index % cols) * (CARD_W + GAP),
  y: PAD + Math.floor(index / cols) * (CARD_H + GAP),
});

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width - PAD * 2 + GAP) / (CARD_W + GAP)));
}

/** Resolve stored or automatic item positions into occupied board rectangles for a page. */
export function layoutPage(items: Item[], page: string, cols: number): Map<string, Rect> {
  const positions = computeLayout(items.map((item) => ({ id: item.id, manual: item.positions?.[page] })), cols);
  return new Map(Object.entries(positions).map(([id, point]) => [id, rectAt(point)]));
}

/** Every saved item uses the shared card footprint, including its visual offset. */
export function sizeOf(_item: Item): Pick<Rect, "w" | "h"> {
  return { w: CARD_W + MESS * 2, h: CARD_H + MESS * 2 };
}

/** Find the first deterministic grid position that does not collide with an occupied rectangle. */
export function freeSpot(rects: Rect[], size: Pick<Rect, "w" | "h">, view: { x: number; y: number; w: number; h: number }): Point {
  const cols = columnsFor(view.w);
  const startX = Math.max(PAD, Math.round(view.x + PAD));
  const startY = Math.max(PAD, Math.round(view.y + PAD));
  for (let index = 0; index < 10_000; index++) {
    const point = {
      x: startX + (index % cols) * (CARD_W + GAP),
      y: startY + Math.floor(index / cols) * (CARD_H + GAP),
    };
    const candidate = { x: point.x - MESS, y: point.y - MESS, ...size };
    if (!rects.some((rect) => overlaps(candidate, rect, GAP / 2))) return point;
  }
  return { x: startX, y: startY + Math.ceil(10_000 / cols) * (CARD_H + GAP) };
}

/**
 * Manual positions win. Every other item takes the next grid cell that doesn't collide with a
 * manually placed note, in the given order (newest first).
 */
export function computeLayout(entries: { id: string; manual?: Point }[], cols: number): Record<string, Point> {
  const out: Record<string, Point> = {};
  const manualRects: Rect[] = [];
  for (const e of entries) {
    if (e.manual) {
      out[e.id] = e.manual;
      manualRects.push(rectAt(e.manual));
    }
  }
  let cell = 0;
  for (const e of entries) {
    if (e.manual) continue;
    let p = cellPoint(cell++, cols);
    let guard = 0;
    while (manualRects.some((r) => overlaps(r, rectAt(p))) && guard++ < 10_000) p = cellPoint(cell++, cols);
    out[e.id] = p;
  }
  return out;
}

/**
 * Push neighbours away from `fixedId` until nothing overlaps. Returns only the positions that
 * changed (including the fixed one if it was clamped). Deterministic: candidates are tried in a
 * fixed order and ties go to the smaller move.
 */
export function resolveCollisions(layout: Record<string, Point>, fixedId: string, maxSteps = 2000): Record<string, Point> {
  const pos: Record<string, Point> = { ...layout };
  const fixed = pos[fixedId];
  if (!fixed) return {};
  pos[fixedId] = { x: Math.max(PAD / 2, Math.round(fixed.x)), y: Math.max(PAD / 2, Math.round(fixed.y)) };
  const changed = new Set<string>([fixedId]);
  const settled = new Set<string>([fixedId]);
  const queue = [fixedId];
  const ids = Object.keys(pos).sort();
  let steps = 0;

  while (queue.length && steps++ < maxSteps) {
    const pusherId = queue.shift() as string;
    const a = rectAt(pos[pusherId]);
    for (const id of ids) {
      if (id === pusherId || id === fixedId) continue;
      const b = rectAt(pos[id]);
      if (!overlaps(a, b, GAP / 2)) continue;
      const m = GAP / 2;
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      const candidates: { dx: number; dy: number }[] = [
        bx >= ax ? { dx: a.x + a.w + m - b.x, dy: 0 } : { dx: a.x - m - (b.x + b.w), dy: 0 },
        by >= ay ? { dx: 0, dy: a.y + a.h + m - b.y } : { dx: 0, dy: a.y - m - (b.y + b.h) },
        { dx: a.x + a.w + m - b.x, dy: 0 },
        { dx: 0, dy: a.y + a.h + m - b.y },
      ];
      const valid = candidates
        .map((c) => ({ ...c, x: pos[id].x + c.dx, y: pos[id].y + c.dy, cost: Math.abs(c.dx) + Math.abs(c.dy) }))
        .filter((c) => c.x >= PAD / 2 && c.y >= PAD / 2);
      valid.sort((p, q) => p.cost - q.cost);
      const pick = valid[0];
      if (!pick) continue;
      pos[id] = { x: Math.round(pick.x), y: Math.round(pick.y) };
      changed.add(id);
      queue.push(id);
    }
    settled.add(pusherId);
  }

  const out: Record<string, Point> = {};
  for (const id of changed) out[id] = pos[id];
  return out;
}

export function boundsOf(layout: Record<string, Point>): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const p of Object.values(layout)) {
    w = Math.max(w, p.x + CARD_W);
    h = Math.max(h, p.y + CARD_H);
  }
  return { w: w + PAD, h: h + PAD };
}
