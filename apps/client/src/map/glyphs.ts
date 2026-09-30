/**
 * Pictogrammes tactiques de la carte : silhouettes PLEINES (lisibles à 14-16 px sur un pion),
 * dans une boîte 24 × 24. Les tracés au trait de @redline/ui servent de repli (bâtiments).
 */
import type { Category, WeaponSystem } from '@redline/shared';
import { PICTOGRAMS, isPictogramId } from '@redline/ui';

export interface Glyph {
  fill?: string[];
  stroke?: string[];
  /** Épaisseur du trait (unités de la boîte 24). */
  sw?: number;
}

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const GLYPHS = {
  fighter: {
    fill: [
      'M12 1.2 L13.4 5.8 L13.5 9.4 L21.4 14.6 L21.4 16.6 L13.5 14.4 L13.2 18.2 L16.2 20.4 L16.2 22 L12 21 L7.8 22 L7.8 20.4 L10.8 18.2 L10.5 14.4 L2.6 16.6 L2.6 14.6 L10.5 9.4 L10.6 5.8 Z',
    ],
  },
  bomber: {
    fill: [
      'M12 2 C13 2 13.4 3.6 13.4 5.8 L13.4 9.4 L22.6 13 L22.6 15 L13.4 13.4 L13.1 18.4 L16.4 20.5 L16.4 21.8 L12 21 L7.6 21.8 L7.6 20.5 L10.9 18.4 L10.6 13.4 L1.4 15 L1.4 13 L10.6 9.4 L10.6 5.8 C10.6 3.6 11 2 12 2 Z',
    ],
  },
  drone: {
    fill: [
      'M12 3 C12.9 3 13.1 4 13.1 5 L13.1 9 L22 9.7 L22 11.4 L13.1 11.8 L12.9 17.8 L15.6 20.6 L14.8 21.5 L12 19.7 L9.2 21.5 L8.4 20.6 L11.1 17.8 L10.9 11.8 L2 11.4 L2 9.7 L10.9 9 L10.9 5 C10.9 4 11.1 3 12 3 Z',
    ],
  },
  helicopter: {
    fill: [
      'M12 6.4 C14.3 6.4 15 8.6 15 10.8 C15 13 13.9 14.6 13 15.2 L12.8 20.2 L11.2 20.2 L11 15.2 C10.1 14.6 9 13 9 10.8 C9 8.6 9.7 6.4 12 6.4 Z',
    ],
    stroke: ['M9.4 20.6 L14.6 20.6', 'M3 4.6 L21 17.4 M21 4.6 L3 17.4'],
    sw: 1.7,
  },
  missile: {
    fill: [
      'M12 1.6 C13.5 3.2 13.9 5.2 13.9 6.8 L13.9 16.2 L16.8 19.8 L16.8 21.8 L13.9 20.3 L10.1 20.3 L7.2 21.8 L7.2 19.8 L10.1 16.2 L10.1 6.8 C10.1 5.2 10.5 3.2 12 1.6 Z',
    ],
  },
  tank: {
    fill: [
      'M2.6 13.6 L21.4 13.6 L19.8 18.8 L4.2 18.8 Z',
      'M7.6 13.6 L8.8 9.8 L15.2 9.8 L16.4 13.6 Z',
      'M14.6 10.9 L22.4 10.9 L22.4 12.3 L14.6 12.3 Z',
    ],
  },
  ifv: {
    fill: [
      'M2.2 16.2 L3.8 11.4 L16.8 11.4 L21 13.8 L21.6 16.2 Z',
      'M8.8 11.4 L9.6 9 L13.6 9 L14.4 11.4 Z',
      'M13.4 9.6 L19.6 9.6 L19.6 10.6 L13.4 10.6 Z',
      circle(6, 18.2, 1.8),
      circle(11, 18.2, 1.8),
      circle(16, 18.2, 1.8),
    ],
  },
  artillery: {
    fill: ['M3.4 18.6 L9.4 15.6 L10.6 17.4 L4.4 20.6 Z'],
    stroke: ['M7.2 15.6 L20.6 6.2', circle(9.6, 17.2, 2.9)],
    sw: 2.3,
  },
  air_defense: {
    fill: [
      'M2.6 16.2 L17.4 16.2 L17.4 19.2 L2.6 19.2 Z',
      'M6 15.2 L14.8 6.6 L16.4 8.2 L7.6 16.2 Z',
      'M10 15.8 L18.6 7.4 L20.2 9 L11.8 16.4 Z',
    ],
    stroke: ['M2.6 11.2 A4.6 4.6 0 0 1 7.2 6.6'],
    sw: 1.7,
  },
  ship: {
    fill: [
      'M1.4 14.4 L22.6 14.4 L19.6 19.6 L4.4 19.6 Z',
      'M6.6 14.4 L6.6 11 L10.2 11 L10.2 8.4 L14 8.4 L14 11 L16.6 11 L16.6 14.4 Z',
    ],
    stroke: ['M12.1 8.4 L12.1 4.4 M10.4 5.8 L13.8 5.8'],
    sw: 1.5,
  },
  carrier: {
    fill: [
      'M1 12.6 L23 12.6 L21 18 L4.2 18 Z',
      'M15.2 12.6 L15.2 9.2 L18.6 9.2 L18.6 12.6 Z',
    ],
    stroke: ['M3.8 15.2 L13 15.2'],
    sw: 1,
  },
  submarine: {
    fill: [
      'M2.6 15 C2.6 12.7 4.6 11.8 7 11.8 L17.6 11.8 C20.4 11.8 21.8 13.2 21.8 15 C21.8 16.8 20.4 18.2 17.6 18.2 L7 18.2 C4.6 18.2 2.6 17.3 2.6 15 Z',
      'M9.4 11.8 L10.2 8.2 L14 8.2 L14.6 11.8 Z',
    ],
    stroke: ['M2.6 15 L1 13 M2.6 15 L1 17'],
    sw: 1.5,
  },
  infantry: {
    fill: [
      circle(12, 4.6, 2.4),
      'M9.2 8 L14.8 8 L15.8 14.2 L13.6 14.2 L14.8 21.4 L12.6 21.4 L12 16.2 L11.4 21.4 L9.2 21.4 L10.4 14.2 L8.2 14.2 Z',
    ],
    stroke: ['M15.2 10 L20.4 4.6'],
    sw: 1.6,
  },
  satellite: {
    fill: [
      'M9.6 9.6 L14.4 9.6 L14.4 14.4 L9.6 14.4 Z',
      'M1.8 9.2 L7.8 9.2 L7.8 14.8 L1.8 14.8 Z',
      'M16.2 9.2 L22.2 9.2 L22.2 14.8 L16.2 14.8 Z',
    ],
    stroke: ['M7.8 12 L9.6 12 M14.4 12 L16.2 12', 'M12 9.6 L12 6.4', 'M9.4 4.4 A2.8 2.8 0 0 0 14.6 4.4'],
    sw: 1.4,
  },
  logistics: {
    fill: [
      'M1.8 7.6 L13.8 7.6 L13.8 16.6 L1.8 16.6 Z',
      'M14.8 10.4 L18.8 10.4 L22 13.6 L22 16.6 L14.8 16.6 Z',
      circle(5.4, 18.4, 2),
      circle(18, 18.4, 2),
    ],
  },
  unknown: {
    stroke: ['M8.6 8.4 C8.6 5.8 10.3 4.4 12 4.4 C14 4.4 15.6 5.8 15.6 7.8 C15.6 10.6 12 11 12 14.2'],
    fill: [circle(12, 18.6, 1.6)],
    sw: 2.4,
  },
} as const satisfies Record<string, Glyph>;

export type GlyphId = keyof typeof GLYPHS | 'refinery' | 'power_plant' | 'port' | 'air_base' | 'military_base' | 'arms_factory' | 'research_center' | 'city';

const CATEGORY_GLYPH: Record<Category, keyof typeof GLYPHS> = {
  fighter: 'fighter',
  bomber: 'bomber',
  air_support: 'bomber',
  helicopter: 'helicopter',
  drone: 'drone',
  tank: 'tank',
  ifv: 'ifv',
  artillery: 'artillery',
  air_defense: 'air_defense',
  strike_missile: 'missile',
  nuclear: 'missile',
  surface_ship: 'ship',
  submarine: 'submarine',
  infantry: 'infantry',
  space: 'satellite',
  logistics: 'logistics',
};

/** Pictogramme de carte d'un système d'armes. */
export function glyphFor(sys: Pick<WeaponSystem, 'category' | 'icon'> | undefined): GlyphId {
  if (!sys) return 'unknown';
  if (sys.icon === 'carrier' || (sys.icon && /carrier|porte-avions/.test(sys.icon))) return 'carrier';
  if (sys.icon && sys.icon in GLYPHS) return sys.icon as GlyphId;
  return CATEGORY_GLYPH[sys.category] ?? 'unknown';
}

/** Dessine un pictogramme centré dans le carré (x, y, taille). */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  id: GlyphId,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  const g: Glyph | undefined = (GLYPHS as Record<string, Glyph>)[id];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (g) {
    for (const d of g.fill ?? []) ctx.fill(new Path2D(d));
    ctx.lineWidth = g.sw ?? 1.8;
    for (const d of g.stroke ?? []) ctx.stroke(new Path2D(d));
  } else if (isPictogramId(id)) {
    // Bâtiments : tracés au trait de la bibliothèque d'interface, épaissis.
    ctx.lineWidth = 2.1;
    for (const d of PICTOGRAMS[id]) ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}
