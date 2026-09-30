/**
 * Sprites composites de la carte, dessinés au canevas à la demande (résolveur d'images manquantes
 * de MapLibre) et identifiés par une clé qui décrit entièrement leur contenu :
 *
 * - pion d'unité (`pion|…`) : rectangle arrondi net, liseré de relation, drapeau, pictogramme,
 *   effectif, barre d'état, pastilles d'état, cartes empilées pour une pile ;
 * - bâtiment (`bld|…`) : petite tuile avec pictogramme et état (endommagé, hors service, réparation) ;
 * - ville (`city|…`) : marqueur proportionné, capitale distinguée ;
 * - fortification (`fort|n`).
 *
 * Un pion est UNE image : l'ordre d'empilement entre pions voisins reste correct (symbol-sort-key),
 * ce qui ne serait pas le cas avec un calque par composant.
 */
import { FLAG_H, FLAG_W, flags } from './flagCache.js';
import { drawGlyph, type GlyphId } from './glyphs.js';
import { C, MONO, REL_COLOR, alpha, type Rel } from './palette.js';

export const SPRITE_RATIO = 2;

/** Dimensions du pion (px CSS, à icon-size 1). */
export const PION_W = 58;
export const PION_H = 26;
/** Marges du canevas autour du pion : cartes empilées, pastilles. */
const M_LEFT = 6;
const M_TOP = 8;
const M_RIGHT = 9;
const M_BOTTOM = 5;
export const PION_CANVAS_W = PION_W + M_LEFT + M_RIGHT;
export const PION_CANVAS_H = PION_H + M_TOP + M_BOTTOM;
/**
 * Décalage (px CSS) à appliquer à l'icône pour que le CENTRE DU PION tombe sur la position
 * (le canevas n'est pas symétrique).
 */
export const PION_ICON_OFFSET: [number, number] = [
  (M_RIGHT - M_LEFT) / 2,
  (M_BOTTOM - M_TOP) / 2,
];

/** Lettres d'état portées par la clé du pion. */
export type PionFlag =
  | 'm' // en mouvement
  | 'c' // au combat
  | 'e' // embarqué
  | 's' // ravitaillement coupé
  | 'l' // ravitaillement limité
  | 'a' // mission aérienne
  | 'd' // leurre (vu par son propriétaire seulement)
  | 'u' // en plongée (sous-marin du joueur)
  | 'n' // contact sonar (sous-marin étranger détecté)
  | 'j' // brouilleur actif
  | 'x'; // contact imprécis (présence seule)

export interface PionSpec {
  nation: string;
  /** Couleur de la nation (#rrggbb), repli si le drapeau manque. */
  color: string;
  glyph: GlyphId;
  rel: Rel;
  /** Effectif affiché ('' si inconnu). */
  count: string;
  /** Barre d'état : 0..10, ou -1 si inconnue. */
  hp: number;
  /** Nombre de piles regroupées (1 = pion simple). */
  stack: number;
  flags: string;
  /** Pion sélectionné (liseré renforcé). */
  sel?: boolean;
}

export function pionKey(s: PionSpec): string {
  return [
    'pion',
    s.nation,
    s.color.slice(1),
    s.glyph,
    s.rel,
    s.count,
    s.hp,
    s.stack,
    s.flags,
    s.sel ? 1 : 0,
  ].join('|');
}

export function parsePionKey(key: string): PionSpec | null {
  const p = key.split('|');
  if (p[0] !== 'pion' || p.length < 10) return null;
  return {
    nation: p[1]!,
    color: `#${p[2]}`,
    glyph: p[3] as GlyphId,
    rel: p[4] as Rel,
    count: p[5]!,
    hp: Number(p[6]),
    stack: Number(p[7]),
    flags: p[8]!,
    sel: p[9] === '1',
  };
}

/** Effectif compact : 7, 48, 320, 1,2k. */
export function compactCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`;
  return `${Math.round(n / 1000)}k`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * SPRITE_RATIO);
  c.height = Math.ceil(h * SPRITE_RATIO);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(SPRITE_RATIO, SPRITE_RATIO);
  return { c, ctx };
}

function out(c: HTMLCanvasElement) {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: new Uint8Array(d.data.buffer) };
}

export type SpriteImage = ReturnType<typeof out>;

function drawFlag(
  ctx: CanvasRenderingContext2D,
  nation: string,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  rr(ctx, x, y, w, h, 1.2);
  ctx.clip();
  const bmp = flags.get(nation);
  if (bmp) ctx.drawImage(bmp, 0, 0, FLAG_W, FLAG_H, x, y, w, h);
  else {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.6;
  rr(ctx, x + 0.3, y + 0.3, w - 0.6, h - 0.6, 1.2);
  ctx.stroke();
}

type BadgeKind = 'm' | 'c' | 'e' | 'a' | 'j' | 'n';
const BADGE_COLOR: Record<BadgeKind, string> = {
  m: C.cyan,
  c: C.red,
  e: C.blue,
  a: C.cyan,
  j: C.amber,
  n: C.cyan,
};

function drawBadgeGlyph(ctx: CanvasRenderingContext2D, k: BadgeKind, cx: number, cy: number) {
  ctx.strokeStyle = C.bg;
  ctx.fillStyle = C.bg;
  ctx.lineWidth = 1.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (k) {
    case 'm': // chevrons »
      ctx.moveTo(cx - 2.6, cy - 2.2);
      ctx.lineTo(cx - 0.6, cy);
      ctx.lineTo(cx - 2.6, cy + 2.2);
      ctx.moveTo(cx + 0.2, cy - 2.2);
      ctx.lineTo(cx + 2.2, cy);
      ctx.lineTo(cx + 0.2, cy + 2.2);
      ctx.stroke();
      break;
    case 'c': // épées croisées
      ctx.moveTo(cx - 2.4, cy - 2.4);
      ctx.lineTo(cx + 2.4, cy + 2.4);
      ctx.moveTo(cx + 2.4, cy - 2.4);
      ctx.lineTo(cx - 2.4, cy + 2.4);
      ctx.stroke();
      break;
    case 'e': // ancre
      ctx.moveTo(cx, cy - 2.6);
      ctx.lineTo(cx, cy + 2.4);
      ctx.moveTo(cx - 1.6, cy - 1.2);
      ctx.lineTo(cx + 1.6, cy - 1.2);
      ctx.moveTo(cx - 2.4, cy + 0.6);
      ctx.quadraticCurveTo(cx - 2, cy + 2.6, cx, cy + 2.4);
      ctx.quadraticCurveTo(cx + 2, cy + 2.6, cx + 2.4, cy + 0.6);
      ctx.stroke();
      break;
    case 'a': // orbite
      ctx.arc(cx, cy, 2.3, 0.3, Math.PI * 1.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 1.9, cy - 1.3, 0.9, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'j': // éclair
      ctx.moveTo(cx + 0.8, cy - 2.8);
      ctx.lineTo(cx - 1.6, cy + 0.4);
      ctx.lineTo(cx + 1.4, cy - 0.2);
      ctx.lineTo(cx - 0.8, cy + 2.8);
      ctx.stroke();
      break;
    case 'n': // arcs sonar
      ctx.arc(cx - 2, cy, 1.6, -0.9, 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - 2, cy, 3.6, -0.8, 0.8);
      ctx.stroke();
      break;
  }
}

function badge(ctx: CanvasRenderingContext2D, k: BadgeKind, cx: number, cy: number) {
  ctx.fillStyle = BADGE_COLOR[k];
  ctx.strokeStyle = C.bg;
  ctx.lineWidth = 1.2;
  rr(ctx, cx - 5, cy - 5, 10, 10, 2.2);
  ctx.fill();
  ctx.stroke();
  drawBadgeGlyph(ctx, k, cx, cy);
}

/** Dessine un pion d'unité (voir PionSpec). */
export function drawPion(s: PionSpec): SpriteImage {
  const { c, ctx } = canvas(PION_CANVAS_W, PION_CANVAS_H);
  const x = M_LEFT;
  const y = M_TOP;
  const w = PION_W;
  const h = PION_H;
  const edge = REL_COLOR[s.rel];
  const f = s.flags;
  const unknown = f.includes('x');
  const dashed = f.includes('d') || f.includes('n') || f.includes('u');

  // Cartes empilées derrière le pion.
  const cards = Math.min(2, Math.max(0, s.stack - 1));
  for (let i = cards; i >= 1; i--) {
    rr(ctx, x + 3.2 * i, y - 3.2 * i, w, h, 3.5);
    ctx.fillStyle = i === 2 ? '#0b1117' : '#0d141b';
    ctx.fill();
    ctx.strokeStyle = alpha(edge, i === 2 ? 0.45 : 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Ombre portée discrète puis corps.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  rr(ctx, x, y, w, h, 3.5);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.restore();
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, f.includes('u') ? '#0f2230' : '#17212c');
  grad.addColorStop(1, f.includes('u') ? '#08131c' : '#0b1015');
  rr(ctx, x, y, w, h, 3.5);
  ctx.fillStyle = grad;
  ctx.fill();
  // Filet de couleur de relation à gauche (lecture immédiate de l'appartenance).
  ctx.save();
  rr(ctx, x, y, w, h, 3.5);
  ctx.clip();
  ctx.fillStyle = edge;
  ctx.fillRect(x, y, 2.6, h);
  ctx.restore();

  // Drapeau, pictogramme, effectif.
  const fh = 12.6;
  const fw = 16.8;
  const cy = y + (s.hp >= 0 ? (h - 3) / 2 : h / 2);
  drawFlag(ctx, s.nation, s.color, x + 5, cy - fh / 2, fw, fh);
  const gs = 18;
  drawGlyph(ctx, s.glyph, x + 24.5, cy - gs / 2, gs, unknown ? C.dim : '#f2f6fa');
  if (s.count) {
    ctx.font = `700 ${s.count.length > 3 ? 9 : s.count.length > 2 ? 10 : 11}px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eef3f8';
    ctx.fillText(s.count, x + w - 4, cy + 0.7);
  }

  // Barre d'état (bas du pion).
  if (s.hp >= 0) {
    const bx = x + 5;
    const bw = w - 9;
    const by = y + h - 4.2;
    ctx.fillStyle = '#243241';
    ctx.fillRect(bx, by, bw, 2.2);
    const r = s.hp / 10;
    ctx.fillStyle = r > 0.6 ? C.green : r > 0.3 ? C.amber : C.red;
    ctx.fillRect(bx, by, Math.max(1, bw * r), 2.2);
  }

  // Liseré.
  ctx.strokeStyle = edge;
  ctx.lineWidth = s.sel ? 2 : 1.4;
  if (dashed) ctx.setLineDash([3, 2]);
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 3.2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Pastille d'état principale (coin supérieur gauche).
  const main: BadgeKind | null = f.includes('c')
    ? 'c'
    : f.includes('n')
      ? 'n'
      : f.includes('e')
        ? 'e'
        : f.includes('a')
          ? 'a'
          : f.includes('m')
            ? 'm'
            : f.includes('j')
              ? 'j'
              : null;
  if (main) badge(ctx, main, x - 0.5, y - 0.5);

  // Ravitaillement : triangle d'alerte (coin inférieur droit).
  if (f.includes('s') || f.includes('l')) {
    const tx = x + w + 1;
    const ty = y + h + 1;
    ctx.beginPath();
    ctx.moveTo(tx, ty - 8);
    ctx.lineTo(tx + 4.6, ty);
    ctx.lineTo(tx - 4.6, ty);
    ctx.closePath();
    ctx.fillStyle = f.includes('s') ? C.red : C.amber;
    ctx.fill();
    ctx.strokeStyle = C.bg;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.bg;
    ctx.fillRect(tx - 0.5, ty - 5.6, 1, 3);
    ctx.fillRect(tx - 0.5, ty - 1.8, 1, 1);
  }

  // Nombre de piles (onglet coin supérieur droit).
  if (s.stack > 1) {
    const txt = s.stack > 99 ? '99+' : String(s.stack);
    ctx.font = `700 8.4px ${MONO}`;
    const tw = Math.max(10, ctx.measureText(txt).width + 5);
    const bx = x + w + 6 - tw / 2 - 1;
    const by = y - 6.5;
    rr(ctx, bx - tw / 2 + 2, by - 4.6, tw, 9.2, 2);
    ctx.fillStyle = edge;
    ctx.fill();
    ctx.strokeStyle = C.bg;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + 2, by + 0.4);
  }

  // Leurre (propriétaire seulement) : mention discrète.
  if (f.includes('d')) {
    ctx.font = `700 6px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.amber;
    ctx.fillText('LEURRE', x + 3, y + h + 4.4);
  }
  return out(c);
}

// ——— Bâtiments ———

export type BuildingState = 'ok' | 'dmg' | 'down' | 'rep' | 'up';
export const BLD_SIZE = 17;

/**
 * Tuile de bâtiment : pictogramme propre au type, liseré de relation (ambre endommagé, rouge hors
 * service, tirets en réparation ou en construction), niveau 1-5 en exposant.
 */
export function drawBuilding(type: string, rel: Rel, state: BuildingState, level = 1): SpriteImage {
  const pad = 3;
  const S = BLD_SIZE;
  const { c, ctx } = canvas(S + pad * 2, S + pad * 2);
  const edge =
    state === 'down' ? C.red : state === 'dmg' ? C.amber : state === 'up' ? C.cyan : REL_COLOR[rel];
  const fill = state === 'down' ? '#1c0f13' : '#0f161e';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 2;
  rr(ctx, pad, pad, S, S, 2.5);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.1;
  if (state === 'rep' || state === 'up') ctx.setLineDash([2, 1.5]);
  rr(ctx, pad + 0.5, pad + 0.5, S - 1, S - 1, 2.3);
  ctx.stroke();
  ctx.setLineDash([]);
  drawGlyph(
    ctx,
    type as GlyphId,
    pad + 2,
    pad + 2,
    S - 4,
    state === 'down' ? alpha(C.text, 0.4) : C.text,
    fill,
  );
  if (state === 'down') {
    ctx.strokeStyle = C.red;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pad + 3, pad + 3);
    ctx.lineTo(pad + S - 3, pad + S - 3);
    ctx.moveTo(pad + S - 3, pad + 3);
    ctx.lineTo(pad + 3, pad + S - 3);
    ctx.stroke();
  } else if (state === 'dmg') {
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.moveTo(pad + S, pad + S - 6);
    ctx.lineTo(pad + S, pad + S);
    ctx.lineTo(pad + S - 6, pad + S);
    ctx.closePath();
    ctx.fill();
  }
  if (level > 1) {
    const txt = String(Math.min(5, Math.round(level)));
    const bx = pad + S - 0.5;
    const by = pad + 0.5;
    ctx.fillStyle = edge;
    rr(ctx, bx - 3.6, by - 3.6, 7.2, 7.2, 1.6);
    ctx.fill();
    ctx.font = `700 6.4px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.bg;
    ctx.fillText(txt, bx, by + 0.4);
  }
  return out(c);
}

// ——— Villes ———

/** Classes de ville : 0 capitale nationale, 1 grande, 2 moyenne, 3 petite. */
export function drawCity(cls: number, rel: Rel | 'none'): SpriteImage {
  const S = 16;
  const { c, ctx } = canvas(S, S);
  const m = S / 2;
  if (cls === 0) {
    // Capitale : carré sur pointe cerclé, point central.
    ctx.fillStyle = 'rgba(4,7,12,0.85)';
    ctx.beginPath();
    ctx.arc(m, m, 6.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rel === 'own' ? C.violet : 'rgba(214,221,230,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(m, m - 3.8);
    ctx.lineTo(m + 3.8, m);
    ctx.lineTo(m, m + 3.8);
    ctx.lineTo(m - 3.8, m);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.fillRect(m - 0.9, m - 0.9, 1.8, 1.8);
  } else {
    const r = cls === 1 ? 3.4 : cls === 2 ? 2.7 : 2.1;
    ctx.fillStyle = 'rgba(4,7,12,0.9)';
    ctx.fillRect(m - r - 1.2, m - r - 1.2, (r + 1.2) * 2, (r + 1.2) * 2);
    ctx.fillStyle = cls === 3 ? '#c9d3de' : '#ffffff';
    ctx.fillRect(m - r, m - r, r * 2, r * 2);
    if (cls === 1) {
      ctx.fillStyle = C.bg;
      ctx.fillRect(m - 1, m - 1, 2, 2);
    }
  }
  return out(c);
}

// ——— Renseignement ———

export const INTEL_COLORS = ['#ff4d5e', '#ffb020', '#4cc9f0', '#3ddc84'] as const;

/** Pastille du niveau de connaissance d'une province (calque « Renseignement »). */
export function drawIntelBadge(level: number): SpriteImage {
  const { c, ctx } = canvas(30, 12);
  const col = INTEL_COLORS[Math.max(0, Math.min(3, level))]!;
  rr(ctx, 1, 1, 28, 10, 2);
  ctx.fillStyle = 'rgba(10,14,19,0.9)';
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < level ? col : '#243241';
    ctx.fillRect(4 + i * 5.2, 4, 4.2, 4);
  }
  ctx.font = `700 6.6px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = col;
  ctx.fillText(`${level}/3`, 27.4, 6.4);
  return out(c);
}

// ——— Fortification ———

export function drawFort(level: number): SpriteImage {
  const { c, ctx } = canvas(18, 14);
  ctx.fillStyle = '#0f161e';
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 1;
  // Créneaux.
  ctx.beginPath();
  ctx.moveTo(2, 12);
  ctx.lineTo(2, 4);
  ctx.lineTo(4.5, 4);
  ctx.lineTo(4.5, 6);
  ctx.lineTo(7, 6);
  ctx.lineTo(7, 4);
  ctx.lineTo(9.5, 4);
  ctx.lineTo(9.5, 6);
  ctx.lineTo(12, 6);
  ctx.lineTo(12, 4);
  ctx.lineTo(14.5, 4);
  ctx.lineTo(14.5, 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.amber;
  const n = Math.max(0, Math.min(5, Math.round(level)));
  for (let i = 0; i < n; i++) ctx.fillRect(3.4 + i * 2.2, 8.4, 1.4, 2);
  return out(c);
}

// ——— Résolution des identifiants ———

/**
 * Nations dont le pion attend un drapeau : le résolveur d'images attend la fin du chargement
 * (au plus ~1,2 s) pour éviter un premier affichage sans drapeau.
 */
export async function resolveSprite(
  id: string,
  add: (id: string, img: SpriteImage) => void,
): Promise<boolean> {
  if (id.startsWith('pion|')) {
    const s = parsePionKey(id);
    if (!s) return false;
    if (!flags.isSettled(s.nation)) {
      await Promise.race([flags.load(s.nation), new Promise((r) => setTimeout(r, 1200))]);
    }
    add(id, drawPion(s));
    return true;
  }
  if (id.startsWith('bld|')) {
    const [, type, rel, state, level] = id.split('|');
    add(id, drawBuilding(type!, rel as Rel, state as BuildingState, Number(level ?? 1)));
    return true;
  }
  if (id.startsWith('intel|')) {
    add(id, drawIntelBadge(Number(id.split('|')[1])));
    return true;
  }
  if (id.startsWith('city|')) {
    const [, cls, rel] = id.split('|');
    add(id, drawCity(Number(cls), rel as Rel));
    return true;
  }
  if (id.startsWith('fort|')) {
    add(id, drawFort(Number(id.split('|')[1])));
    return true;
  }
  return false;
}
