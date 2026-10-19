/**
 * One motion language, reused everywhere. Durations 0.25 / 0.7 / 1.4s only, ease-out expo.
 * Source: expo.out curve popularised by GSAP; Codrops "Unreveal" uses 0.7s expo.out wipes.
 */
export const DUR = { fast: 0.25, base: 0.7, slow: 1.4 } as const;
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
export const STAGGER = 0.07;

export const t = (d: keyof typeof DUR = "base", delay = 0) => ({ duration: DUR[d], ease: EASE_OUT_EXPO, delay });
