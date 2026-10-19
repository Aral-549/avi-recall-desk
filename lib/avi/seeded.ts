/** Deterministic per-id randomness: the "mess" is a pure function of the item id, so nothing jitters between renders. */
export function hash32(input: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG. */
export function seeded(seed: string) {
  let a = hash32(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAX_ROTATION = 1.5;

export interface Mess {
  rotation: number;
  dx: number;
  dy: number;
  tape: "sage" | "rose";
  tapeAngle: number;
  tapeShift: number;
  /** Torn-edge polygon points, % values, for scraps. */
  tear: string;
}

export function messFor(id: string): Mess {
  const r = seeded(id);
  const rotation = Math.round((r() * 2 - 1) * MAX_ROTATION * 100) / 100;
  const dx = Math.round((r() * 2 - 1) * 6);
  const dy = Math.round((r() * 2 - 1) * 6);
  const tape = r() > 0.5 ? "sage" : "rose";
  const tapeAngle = Math.round((r() * 2 - 1) * 6);
  const tapeShift = Math.round((r() * 2 - 1) * 18);
  const teeth = 14;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= teeth; i++) {
    const x = (i / teeth) * 100;
    top.push(`${x.toFixed(1)}% ${(r() * 2.2).toFixed(2)}%`);
    bottom.push(`${(100 - x).toFixed(1)}% ${(100 - r() * 2.2).toFixed(2)}%`);
  }
  return { rotation, dx, dy, tape, tapeAngle, tapeShift, tear: `polygon(${[...top, ...bottom].join(",")})` };
}

/** Deterministic UUID-v4-shaped id for seed/fixture data. */
export function seedUuid(n: number): string {
  const tail = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const r = seeded(String(Date.now() + Math.random()));
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(r() * 16).toString(16));
}
