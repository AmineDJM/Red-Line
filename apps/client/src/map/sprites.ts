/**
 * Sprites de la carte générés au canvas à l'exécution (aucun fichier de sprite à servir) :
 * hexagone et pictogrammes en SDF (teintés par `icon-color`), flèches, triangles, hachures,
 * et, si les glyphes PBF manquent, des étiquettes rendues en image avec les polices CSS.
 */
import type { Map as MlMap } from 'maplibre-gl';
import { PICTOGRAMS, PICTOGRAM_IDS, PICTOGRAM_STROKE, hexPoints } from '@redline/ui';
import { renderSdf } from './sdf.js';

export const PIXEL_RATIO = 2;
/** Taille commune des images d'unité (px physiques) : même centre pour hexagone et pictogramme. */
const UNIT_W = 136;
const UNIT_H = 124;
/** Rayon de l'hexagone (px physiques) : 48 → 48 px CSS de large à icon-size 1. */
export const HEX_R = 48;
const SDF_RADIUS = 10;

function hexPathOn(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const pts = hexPoints(cx, cy, r);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function add(map: MlMap, id: string, img: { width: number; height: number; data: Uint8ClampedArray }, sdf: boolean) {
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: PIXEL_RATIO, sdf });
}

export function registerSprites(map: MlMap) {
  const cx = UNIT_W / 2;
  const cy = UNIT_H / 2;

  add(
    map,
    'hex',
    renderSdf(UNIT_W, UNIT_H, SDF_RADIUS, (ctx) => {
      hexPathOn(ctx, cx, cy, HEX_R);
      ctx.fill();
    }),
    true,
  );
  add(
    map,
    'hex-sel',
    renderSdf(UNIT_W, UNIT_H, SDF_RADIUS, (ctx) => {
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      hexPathOn(ctx, cx, cy, HEX_R + 11);
      ctx.stroke();
    }),
    true,
  );

  // Pictogrammes : même canevas que l'hexagone, centrés, 60 % de sa largeur.
  const scale = (HEX_R * 2 * 0.6) / 24;
  for (const id of PICTOGRAM_IDS) {
    add(
      map,
      `pic-${id}`,
      renderSdf(UNIT_W, UNIT_H, SDF_RADIUS, (ctx) => {
        ctx.translate(cx - 12 * scale, cy - 12 * scale);
        ctx.scale(scale, scale);
        ctx.lineWidth = PICTOGRAM_STROKE * 1.25;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const d of PICTOGRAMS[id]) ctx.stroke(new Path2D(d));
        if (id === 'unknown') {
          ctx.lineWidth = PICTOGRAM_STROKE * 2.4;
          ctx.stroke(new Path2D('M12 17.6 L12 17.7'));
        }
      }),
      true,
    );
  }

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

  add(map, 'hatch-fog', hatch(16, 'rgba(160, 176, 204, 0.20)', 1.4), false);
  add(map, 'hatch-disputed', hatch(12, 'rgba(255, 214, 160, 0.55)', 2), false);
}

function hatch(size: number, color: string, width: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
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

// ——— Étiquettes en image (repli sans glyphes PBF) ———

export type TextStyle = 'country-l' | 'country-m' | 'country-s' | 'sea-l' | 'sea-s' | 'count' | 'prov';

interface TextSpec {
  font: string;
  size: number;
  spacing: number;
  color: string;
  halo: string;
  haloWidth: number;
  upper: boolean;
}

const TEXT: Record<TextStyle, TextSpec> = {
  'country-l': { font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif', size: 19, spacing: 0.22, color: '#ffffff', halo: 'rgba(0,0,0,0.75)', haloWidth: 3, upper: true },
  'country-m': { font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif', size: 15, spacing: 0.2, color: '#ffffff', halo: 'rgba(0,0,0,0.75)', haloWidth: 3, upper: true },
  'country-s': { font: '700 {s}px "Barlow Condensed", "Arial Narrow", sans-serif', size: 12, spacing: 0.16, color: 'rgba(255,255,255,0.92)', halo: 'rgba(0,0,0,0.7)', haloWidth: 2.5, upper: true },
  'sea-l': { font: 'italic 400 {s}px "IBM Plex Sans", sans-serif', size: 14, spacing: 0.12, color: '#8d99ad', halo: 'rgba(0,0,0,0.5)', haloWidth: 2, upper: false },
  'sea-s': { font: 'italic 400 {s}px "IBM Plex Sans", sans-serif', size: 12, spacing: 0.08, color: '#8391a6', halo: 'rgba(0,0,0,0.5)', haloWidth: 2, upper: false },
  count: { font: '600 {s}px "IBM Plex Mono", monospace', size: 12, spacing: 0, color: '#ffffff', halo: 'rgba(0,0,0,0.6)', haloWidth: 2, upper: false },
  prov: { font: '400 {s}px "IBM Plex Sans", sans-serif', size: 11, spacing: 0.04, color: 'rgba(235,240,250,0.85)', halo: 'rgba(0,0,0,0.7)', haloWidth: 2, upper: false },
};

export const TEXT_IMAGE_PREFIX = 'txt|';

export function textImageId(style: TextStyle, text: string) {
  return `${TEXT_IMAGE_PREFIX}${style}|${text}`;
}

/** Dessine du texte espacé lettre par lettre (letterSpacing du canvas pas partout disponible). */
function spacedWidth(ctx: CanvasRenderingContext2D, text: string, spacingPx: number) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacingPx;
  return Math.max(0, w - spacingPx);
}

function drawSpaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacingPx: number, stroke: boolean) {
  let cx = x;
  for (const ch of text) {
    if (stroke) ctx.strokeText(ch, cx, y);
    else ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacingPx;
  }
}

export function renderTextImage(style: TextStyle, raw: string) {
  const spec = TEXT[style];
  const text = spec.upper ? raw.toLocaleUpperCase('fr') : raw;
  const pr = PIXEL_RATIO;
  const size = spec.size * pr;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
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

/** Gestionnaire `styleimagemissing` : génère à la volée les étiquettes-images demandées. */
export function handleMissingImage(map: MlMap, id: string) {
  if (!id.startsWith(TEXT_IMAGE_PREFIX)) return;
  const rest = id.slice(TEXT_IMAGE_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return;
  const style = rest.slice(0, sep) as TextStyle;
  if (!(style in TEXT)) return;
  const img = renderTextImage(style, rest.slice(sep + 1));
  if (!map.hasImage(id)) {
    map.addImage(id, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: PIXEL_RATIO });
  }
}
