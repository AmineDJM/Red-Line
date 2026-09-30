/** Couleurs de nations : conversions et règles (jamais de violet, voisins distincts). */

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const x = r / 255;
  const y = g / 255;
  const z = b / 255;
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === x) h = (y - z) / d + (y < z ? 6 : 0);
  else if (max === y) h = (z - x) / d + 2;
  else h = (x - y) / d + 4;
  return [h * 60, s, l];
}

/** Violet réservé au territoire du joueur (#9b6bff) : teinte 250-300°, saturée. */
export function isVioletLike(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const [h, s, l] = rgbToHsl(rgb);
  return h >= 250 && h <= 300 && s > 0.35 && l > 0.25 && l < 0.85;
}

/** Distance perceptuelle approximative (« redmean ») : 0 = identiques. */
export function colorDistance(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return Infinity;
  const rm = (x[0] + y[0]) / 2;
  const dr = x[0] - y[0];
  const dg = x[1] - y[1];
  const db = x[2] - y[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Sous ce seuil, deux voisins sont difficiles à distinguer sur la carte. */
export const TOO_CLOSE = 60;

/** Couleur de texte lisible sur un fond donné. */
export function inkOn(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#0a0e13';
  const [r, g, b] = rgb;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#0a0e13' : '#f2f5f8';
}
