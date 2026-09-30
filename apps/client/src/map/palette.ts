/**
 * Jetons de couleur et polices de la carte (direction artistique « Terminal tactique »).
 * Mêmes valeurs que les jetons CSS de l'interface (packages/ui/src/tokens.css), recopiées ici car
 * MapLibre et les canevas ne lisent pas les variables CSS.
 */
import type { NationId, NationView } from '@redline/shared';

export const C = {
  bg: '#0a0e13',
  panel: '#0e141b',
  panel2: '#121a23',
  rule: '#1e2a36',
  text: '#d6dde6',
  dim: '#7d8b99',
  cyan: '#4cc9f0',
  green: '#3ddc84',
  amber: '#ffb020',
  red: '#ff4d5e',
  violet: '#9b6bff',
  blue: '#3a86ff',
  grey: '#8a96a3',
} as const;

/** Polices des canevas (pions, infobulles dessinées, surcouche). JetBrains Mono si chargée. */
export const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

/** Relation d'une nation avec le joueur, du point de vue de l'affichage. */
export type Rel = 'own' | 'ally' | 'neutral' | 'enemy';

/** Liseré des pions : vert (les siennes), violet (alliés), gris (neutres), rouge (en guerre). */
export const REL_COLOR: Record<Rel, string> = {
  own: C.green,
  ally: C.violet,
  neutral: C.grey,
  enemy: C.red,
};

/**
 * Relation d'affichage. Sans information diplomatique (`relation` absente : vue de phase 1, mode
 * démonstration), toute nation étrangère est traitée comme hostile — prudence militaire.
 */
export function relationOf(
  owner: NationId,
  me: NationId | null,
  nations: Record<NationId, NationView | undefined>,
): Rel {
  // Spectateur (aucune nation) : personne n'est « ennemi », liseré neutre pour tous.
  if (!me) return 'neutral';
  if (owner === me) return 'own';
  const r = nations[owner]?.relation;
  if (r === 'ally') return 'ally';
  if (r === 'peace' || r === 'ceasefire') return 'neutral';
  return 'enemy';
}

/** Mélange linéaire de deux couleurs hexadécimales (#rrggbb). */
export function mix(a: string, b: string, f: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const out = [16, 8, 0].map((s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * f));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Couleur hexadécimale avec opacité → rgba(). */
export function alpha(hex: string, a: number): string {
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${a})`;
}
