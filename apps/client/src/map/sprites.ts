/**
 * Sprites de la carte générés au canevas à l'exécution (aucun fichier de sprite à servir) :
 * formes SDF teintées par `icon-color` (cadre de sélection, flèches, missile, réticules), motifs de
 * hachures, et, si les glyphes PBF manquent, des étiquettes rendues en image avec les polices CSS.
 * Les sprites composites (pions, bâtiments, villes) sont dans pions.ts.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { renderSdf } from './sdf.js';
import { C, MONO } from './palette.js';
import { PION_H, PION_W } from './pions.js';
import { upper } from '../i18n/index.js';

export const PIXEL_RATIO = 2;
const SDF_RADIUS = 8;

function add(
  map: MlMap,
  id: string,
  img: { width: number; height: number; data: Uint8ClampedArray },
  sdf: boolean,
) {
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(
    id,
    { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) },
    { pixelRatio: PIXEL_RATIO, sdf },
  );
}

/** Identifiant témoin : présent quand les sprites de base sont enregistrés. */
export const SPRITES_MARK = 'sel-frame';

export function registerSprites(map: MlMap) {
  // Cadre de sélection : crochets d'angle autour du pion (style terminal).
  const fw = (PION_W + 12) * PIXEL_RATIO;
  const fh = (PION_H + 12) * PIXEL_RATIO;
  add(
    map,
    'sel-frame',
    renderSdf(fw + 16, fh + 16, SDF_RADIUS, (ctx) => {
      const x0 = 8;
      const y0 = 8;
      const L = 12 * PIXEL_RATIO;
      ctx.lineWidth = 2.2 * PIXEL_RATIO;
      ctx.lineCap = 'square';
      ctx.beginPath();
      for (const [x, y, sx, sy] of [
        [x0, y0, 1, 1],
        [x0 + fw, y0, -1, 1],
        [x0, y0 + fh, 1, -1],
        [x0 + fw, y0 + fh, -1, -1],
      ] as const) {
        ctx.moveTo(x + sx * L, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * L);
      }
      ctx.stroke();
    }),
    true,
  );
  // Réticule de cible.
  add(
    map,
    'reticle',
    renderSdf(72, 72, 6, (ctx) => {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(36, 36, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (const [a, b, c, d] of [
        [36, 4, 36, 20],
        [36, 52, 36, 68],
        [4, 36, 20, 36],
        [52, 36, 68, 36],
      ] as const) {
        ctx.moveTo(a, b);
        ctx.lineTo(c, d);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(36, 36, 3, 0, Math.PI * 2);
      ctx.fill();
    }),
    true,
  );
  // Destination d'un déplacement : losange évidé.
  add(
    map,
    'dest',
    renderSdf(48, 48, 6, (ctx) => {
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(24, 6);
      ctx.lineTo(42, 24);
      ctx.lineTo(24, 42);
      ctx.lineTo(6, 24);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(24, 24, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }),
    true,
  );
  // Flèche de cap (chevron) des aéronefs en vol, orbitant autour du pion.
  add(
    map,
    'heading',
    renderSdf(40, 40, 6, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(20, 6);
      ctx.lineTo(33, 30);
      ctx.lineTo(20, 23);
      ctx.lineTo(7, 30);
      ctx.closePath();
      ctx.fill();
    }),
    true,
  );
  // Missile en vol (silhouette orientée vers le haut).
  add(
    map,
    'missile',
    renderSdf(40, 64, 6, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(20, 4);
      ctx.bezierCurveTo(25, 9, 25.5, 14, 25.5, 18);
      ctx.lineTo(25.5, 44);
      ctx.lineTo(32, 54);
      ctx.lineTo(32, 60);
      ctx.lineTo(25.5, 56);
      ctx.lineTo(14.5, 56);
      ctx.lineTo(8, 60);
      ctx.lineTo(8, 54);
      ctx.lineTo(14.5, 44);
      ctx.lineTo(14.5, 18);
      ctx.bezierCurveTo(14.5, 14, 15, 9, 20, 4);
      ctx.closePath();
      ctx.fill();
    }),
    true,
  );
  // Point d'impact : croix dans un cercle en tirets.
  add(
    map,
    'impact',
    renderSdf(64, 64, 6, (ctx) => {
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.arc(32, 32, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(24, 24);
      ctx.lineTo(40, 40);
      ctx.moveTo(40, 24);
      ctx.lineTo(24, 40);
      ctx.stroke();
    }),
    true,
  );
  add(
    map,
    'arrow',
    renderSdf(48, 48, 8, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(24, 6);
      ctx.lineTo(40, 40);
      ctx.lineTo(24, 32);
      ctx.lineTo(8, 40);
      ctx.closePath();
      ctx.fill();
    }),
    true,
  );
  add(
    map,
    'tri',
    renderSdf(52, 48, 8, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(26, 6);
      ctx.lineTo(45, 40);
      ctx.lineTo(7, 40);
      ctx.closePath();
      ctx.fill();
    }),
    true,
  );
  add(
    map,
    'dot',
    renderSdf(32, 32, 6, (ctx) => {
      ctx.beginPath();
      ctx.arc(16, 16, 8, 0, Math.PI * 2);
      ctx.fill();
    }),
    true,
  );
  add(
    map,
    'ring',
    renderSdf(72, 72, 6, (ctx) => {
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(36, 36, 26, 0, Math.PI * 2);
      ctx.stroke();
    }),
    true,
  );
  add(
    map,
    'plus',
    renderSdf(32, 32, 6, (ctx) => {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(16, 6);
      ctx.lineTo(16, 26);
      ctx.moveTo(6, 16);
      ctx.lineTo(26, 16);
      ctx.stroke();
    }),
    true,
  );
  add(map, 'blockade', blockadeIcon(), false);

  add(map, 'hatch-fog', hatch(16, 'rgba(150, 168, 190, 0.12)', 1, 'rgba(2, 5, 10, 0.44)'), false);
  add(map, 'hatch-disputed', hatch(12, 'rgba(255, 176, 32, 0.55)', 1.6), false);
  add(map, 'hatch-unrest', hatch(10, 'rgba(255, 77, 94, 0.6)', 1.6), false);
  // Voile : fond sombre intégré au motif (une seule passe de dessin).
  add(
    map,
    'hatch-veil',
    crossHatch(12, 'rgba(125, 139, 153, 0.34)', 1, 'rgba(4, 7, 11, 0.36)'),
    false,
  );
  add(
    map,
    'hatch-veil-light',
    hatch(12, 'rgba(125, 139, 153, 0.26)', 1, 'rgba(4, 7, 11, 0.16)'),
    false,
  );
  add(map, 'hatch-nfz', crossHatch(14, 'rgba(255, 77, 94, 0.45)', 1.2), false);
  add(map, 'hatch-sat', hatch(10, 'rgba(76, 201, 240, 0.35)', 1), false);
}

function hatch(size: number, color: string, width: number, bg?: string) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  // Diagonales raccordées pour un motif continu.
  ctx.moveTo(-2, size + 2);
  ctx.lineTo(size + 2, -2);
  ctx.moveTo(-2, 2);
  ctx.lineTo(2, -2);
  ctx.moveTo(size - 2, size + 2);
  ctx.lineTo(size + 2, size - 2);
  ctx.stroke();
  return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
}

function crossHatch(size: number, color: string, width: number, bg?: string) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(-2, size + 2);
  ctx.lineTo(size + 2, -2);
  ctx.moveTo(-2, 2);
  ctx.lineTo(2, -2);
  ctx.moveTo(size - 2, size + 2);
  ctx.lineTo(size + 2, size - 2);
  ctx.moveTo(-2, -2);
  ctx.lineTo(size + 2, size + 2);
  ctx.moveTo(size - 2, -2);
  ctx.lineTo(size + 2, 2);
  ctx.moveTo(-2, size - 2);
  ctx.lineTo(2, size + 2);
  ctx.stroke();
  return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
}

/** Blocus : ancre barrée sur pastille rouge. */
function blockadeIcon() {
  const s = 18 * PIXEL_RATIO;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  ctx.fillStyle = C.red;
  ctx.strokeStyle = C.bg;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, 15, 15, 3);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = C.bg;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(9, 5.4, 1.4, 0, Math.PI * 2);
  ctx.moveTo(9, 6.8);
  ctx.lineTo(9, 14);
  ctx.moveTo(5.4, 11);
  ctx.quadraticCurveTo(6, 14, 9, 14);
  ctx.quadraticCurveTo(12, 14, 12.6, 11);
  ctx.moveTo(4, 4);
  ctx.lineTo(14, 14);
  ctx.stroke();
  return { width: s, height: s, data: ctx.getImageData(0, 0, s, s).data };
}

// ——— Étiquettes en image (repli sans glyphes PBF) ———

export type TextStyle =
  | 'country-l'
  | 'country-m'
  | 'country-s'
  | 'sea-l'
  | 'sea-s'
  | 'count'
  | 'prov'
  | 'city-0'
  | 'city-1'
  | 'city-2'
  | 'city-3';

interface TextSpec {
  font: string;
  size: number;
  spacing: number;
  color: string;
  halo: string;
  haloWidth: number;
  upper: boolean;
}

const CITY = (size: number, weight: number, color: string, upper = false): TextSpec => ({
  font: `${weight} {s}px "IBM Plex Sans", sans-serif`,
  size,
  spacing: upper ? 0.08 : 0.02,
  color,
  halo: 'rgba(3,6,10,0.85)',
  haloWidth: 2.4,
  upper,
});

const TEXT: Record<TextStyle, TextSpec> = {
  'country-l': {
    font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif',
    size: 19,
    spacing: 0.3,
    color: 'rgba(255,255,255,0.9)',
    halo: 'rgba(0,0,0,0.7)',
    haloWidth: 3,
    upper: true,
  },
  'country-m': {
    font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif',
    size: 15,
    spacing: 0.26,
    color: 'rgba(255,255,255,0.88)',
    halo: 'rgba(0,0,0,0.7)',
    haloWidth: 3,
    upper: true,
  },
  'country-s': {
    font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif',
    size: 12,
    spacing: 0.2,
    color: 'rgba(255,255,255,0.82)',
    halo: 'rgba(0,0,0,0.7)',
    haloWidth: 2.5,
    upper: true,
  },
  'sea-l': {
    font: 'italic 400 {s}px "IBM Plex Sans", sans-serif',
    size: 13,
    spacing: 0.14,
    color: '#6f8196',
    halo: 'rgba(0,0,0,0.5)',
    haloWidth: 2,
    upper: false,
  },
  'sea-s': {
    font: 'italic 400 {s}px "IBM Plex Sans", sans-serif',
    size: 11.5,
    spacing: 0.1,
    color: '#667a90',
    halo: 'rgba(0,0,0,0.5)',
    haloWidth: 2,
    upper: false,
  },
  count: {
    font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif',
    size: 12,
    spacing: 0,
    color: '#ffffff',
    halo: 'rgba(0,0,0,0.6)',
    haloWidth: 2,
    upper: false,
  },
  prov: {
    font: '400 {s}px "IBM Plex Sans", sans-serif',
    size: 11,
    spacing: 0.04,
    color: 'rgba(235,240,250,0.85)',
    halo: 'rgba(0,0,0,0.7)',
    haloWidth: 2,
    upper: false,
  },
  'city-0': CITY(12.5, 600, '#ffffff'),
  'city-1': CITY(11.5, 600, '#eef3f8'),
  'city-2': CITY(10.5, 400, '#dfe6ee'),
  'city-3': CITY(10, 400, '#b9c4cf'),
};

export const TEXT_IMAGE_PREFIX = 'txt|';

export function textImageId(style: TextStyle, text: string) {
  return `${TEXT_IMAGE_PREFIX}${style}|${text}`;
}

/** Dessine du texte espacé lettre par lettre (letterSpacing du canvas pas partout disponible). */
// Écritures liées (arabe, devanagari…) : jamais lettre par lettre (formes contextuelles, sens).
const JOINED_SCRIPT = /[\u0590-\u08ff\u0900-\u0dff\ufb1d-\ufdff\ufe70-\ufeff]/;

function spacedWidth(ctx: CanvasRenderingContext2D, text: string, spacingPx: number) {
  if (JOINED_SCRIPT.test(text)) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacingPx;
  return Math.max(0, w - spacingPx);
}

function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacingPx: number,
  stroke: boolean,
) {
  if (JOINED_SCRIPT.test(text)) {
    ctx.direction = /[\u0590-\u08ff\ufb1d-\ufeff]/.test(text) ? 'rtl' : 'ltr';
    ctx.textAlign = ctx.direction === 'rtl' ? 'right' : 'left';
    const ax = ctx.direction === 'rtl' ? x + ctx.measureText(text).width : x;
    if (stroke) ctx.strokeText(text, ax, y);
    else ctx.fillText(text, ax, y);
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    return;
  }
  let cx = x;
  for (const ch of text) {
    if (stroke) ctx.strokeText(ch, cx, y);
    else ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacingPx;
  }
}

export function renderTextImage(style: TextStyle, raw: string) {
  const spec = TEXT[style];
  const text = spec.upper ? upper(raw) : raw;
  const pr = PIXEL_RATIO;
  const size = spec.size * pr;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.font = spec.font.replace('{s}', String(size));
  const spacing = spec.spacing * size;
  const w = Math.ceil(spacedWidth(ctx, text, spacing) + spec.haloWidth * pr * 2 + 4);
  const h = Math.ceil(size * 1.3 + spec.haloWidth * pr * 2);
  c.width = Math.max(2, w);
  c.height = Math.max(2, h);
  ctx.font = spec.font.replace('{s}', String(size));
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const x = spec.haloWidth * pr + 2;
  const y = c.height / 2;
  ctx.strokeStyle = spec.halo;
  ctx.lineWidth = spec.haloWidth * pr;
  drawSpaced(ctx, text, x, y, spacing, true);
  ctx.fillStyle = spec.color;
  drawSpaced(ctx, text, x, y, spacing, false);
  return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

/** Génère une étiquette-image demandée par le style (`txt|style|texte`). */
export function handleMissingImage(map: MlMap, id: string) {
  if (!id.startsWith(TEXT_IMAGE_PREFIX)) return;
  const rest = id.slice(TEXT_IMAGE_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return;
  const style = rest.slice(0, sep) as TextStyle;
  if (!(style in TEXT)) return;
  const img = renderTextImage(style, rest.slice(sep + 1));
  if (!map.hasImage(id)) {
    map.addImage(
      id,
      { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) },
      { pixelRatio: PIXEL_RATIO },
    );
  }
}
