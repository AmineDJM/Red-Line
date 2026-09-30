/**
 * PRNG à graine xoshiro128** (32 bits). L'état (4 entiers non signés) est stocké dans le GameState
 * et sérialisé avec lui : même graine + mêmes appels ⇒ mêmes tirages.
 */
export type RngState = [number, number, number, number];

/** Initialise l'état à partir d'une graine quelconque (splitmix32). */
export function seedRng(seed: number): RngState {
  let x = (Math.floor(seed) >>> 0) ^ 0x9e3779b9;
  const next = (): number => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const s: RngState = [next(), next(), next(), next()];
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Entier non signé 32 bits suivant (modifie l'état en place). */
export function nextU32(s: RngState): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

/** Réel uniforme dans [0, 1). */
export function nextFloat(s: RngState): number {
  return nextU32(s) / 4294967296;
}

/** Entier uniforme dans [0, n). */
export function nextInt(s: RngState, n: number): number {
  return Math.floor(nextFloat(s) * n);
}
