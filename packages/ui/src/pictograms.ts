/**
 * Pictogrammes au trait de Red Line.
 *
 * Source unique : les mêmes tracés SVG (viewBox 0 0 24 24) servent au composant React <HexIcon>
 * et à la génération des sprites SDF de la carte (Path2D sur canvas). Tracés dessinés à la main,
 * à rendre en trait blanc (épaisseur ≈ 1,6), extrémités et jointures arrondies.
 */
import type { BuildingType, Category } from '@redline/shared';

/** Cercle en syntaxe de chemin SVG (utilisable par Path2D). */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

export const PICTOGRAMS = {
  // ——— Unités ———
  fighter: [
    'M12 2 L13.2 7 L13.2 10 L20.5 15 L20.5 16.6 L13.2 14.6 L13 18 L15.6 20 L15.6 21.3 L12 20.4 L8.4 21.3 L8.4 20 L11 18 L10.8 14.6 L3.5 16.6 L3.5 15 L10.8 10 L10.8 7 Z',
  ],
  bomber: [
    'M12 2.5 C12.9 2.5 13.2 4 13.2 6 L13.2 9.5 L22 13 L22 14.6 L13.2 13.1 L13 18.5 L16 20.5 L16 21.5 L12 20.8 L8 21.5 L8 20.5 L11 18.5 L10.8 13.1 L2 14.6 L2 13 L10.8 9.5 L10.8 6 C10.8 4 11.1 2.5 12 2.5 Z',
    'M16.6 11.4 L16.6 13.4 M19.2 12.4 L19.2 14 M7.4 11.4 L7.4 13.4 M4.8 12.4 L4.8 14',
  ],
  helicopter: [
    'M12 7 C14 7 14.6 9 14.6 11 C14.6 13 13.6 14.5 12.8 15 L12.6 20.5 L11.4 20.5 L11.2 15 C10.4 14.5 9.4 13 9.4 11 C9.4 9 10 7 12 7 Z',
    'M9.6 20.5 L14.4 20.5',
    'M3.5 5 L20.5 17 M20.5 5 L3.5 17',
  ],
  drone: [
    'M12 3.2 C12.8 3.2 12.9 4.2 12.9 5 L12.9 9.2 L21.5 9.8 L21.5 11.2 L12.9 11.6 L12.7 18 L15.3 20.8 L14.6 21.4 L12 19.6 L9.4 21.4 L8.7 20.8 L11.3 18 L11.1 11.6 L2.5 11.2 L2.5 9.8 L11.1 9.2 L11.1 5 C11.1 4.2 11.2 3.2 12 3.2 Z',
  ],
  tank: [
    'M4.2 14.8 L19.8 14.8 C21.8 14.8 21.8 19.2 19.8 19.2 L4.2 19.2 C2.2 19.2 2.2 14.8 4.2 14.8 Z',
    'M5.5 14.8 L7.2 12 L16.8 12 L18.5 14.8',
    'M8.8 12 L9.8 9.2 L14.6 9.2 L15.4 12',
    'M14.6 10.4 L21.8 10.4',
    circle(6.6, 17, 0.8),
    circle(10.2, 17, 0.8),
    circle(13.8, 17, 0.8),
    circle(17.4, 17, 0.8),
  ],
  ifv: [
    'M2.8 16.2 L4.4 11.2 L16.8 11.2 L20.6 13.6 L21.2 16.2 Z',
    'M9 11.2 L9.6 8.8 L13.6 8.8 L14.2 11.2',
    'M13.6 9.9 L18.8 9.9',
    circle(6.2, 18, 1.7),
    circle(11, 18, 1.7),
    circle(15.8, 18, 1.7),
  ],
  artillery: [
    'M6.8 14.4 L19.4 5.6 M8.2 16.4 L20.6 7.6 M19.4 5.6 L20.6 7.6',
    'M7.4 13 L11.8 14.4 L10.6 17.4',
    circle(9.2, 17.6, 2.8),
    'M7 19.4 L2.6 21.2',
  ],
  air_defense: [
    'M2.8 19 L21.2 19',
    'M4.6 19 L4.6 16.2 L16.4 16.2 L16.4 19',
    'M7.4 16.2 L15.2 8.4 M10.6 16.2 L18.4 8.4',
    'M15.2 8.4 L16.4 6.2 L17.4 7.2 Z M18.4 8.4 L19.6 6.2 L20.6 7.2 Z',
    'M3.4 11 A4.4 4.4 0 0 1 7.8 6.6',
    'M3.4 7.8 A1.6 1.6 0 0 1 5 6.2',
    circle(7.2, 20.8, 0.9),
    circle(14, 20.8, 0.9),
  ],
  missile: [
    'M12 2.4 C13.3 3.8 13.6 5.5 13.6 7 L13.6 16.4 L16.2 19.8 L16.2 21.4 L13.6 20 L10.4 20 L7.8 21.4 L7.8 19.8 L10.4 16.4 L10.4 7 C10.4 5.5 10.7 3.8 12 2.4 Z',
    'M10.4 7 L13.6 7',
    'M10.4 10.2 L8.4 12.4 L10.4 12.4 M13.6 10.2 L15.6 12.4 L13.6 12.4',
  ],
  ship: [
    'M2 15 L22 15 L19.4 19.4 L4.6 19.4 Z',
    'M6.6 15 L6.6 11.6 L10.6 11.6 L10.6 9 L14 9 L14 11.6 L16.2 11.6 L16.2 15',
    'M12.3 9 L12.3 5.2 M10.8 6.6 L13.8 6.6',
    'M16.2 13.2 L20 12.4',
  ],
  submarine: [
    'M3.4 15 C3.4 12.9 5.2 12 7.2 12 L17.8 12 C20.4 12 21.8 13.3 21.8 15 C21.8 16.7 20.4 18 17.8 18 L7.2 18 C5.2 18 3.4 17.1 3.4 15 Z',
    'M9.6 12 L10.4 8.6 L13.8 8.6 L14.4 12',
    'M12.2 8.6 L12.2 5.8 L13.8 5.8',
    'M3.4 15 L1.8 13.2 M3.4 15 L1.8 16.8',
  ],
  infantry: [
    circle(12, 4.6, 2),
    'M12 7.4 L12 14 M12 14 L8.8 20.6 M12 14 L15.2 20.6',
    'M12 9.6 L8 12.6 M12 9.6 L15.6 11.4',
    'M13.4 13.4 L19.4 6.2',
  ],
  satellite: [
    'M9.8 9.8 L14.2 9.8 L14.2 14.2 L9.8 14.2 Z',
    'M2.4 9 L7.8 9 L7.8 15 L2.4 15 Z M5.1 9 L5.1 15',
    'M16.2 9 L21.6 9 L21.6 15 L16.2 15 Z M18.9 9 L18.9 15',
    'M7.8 12 L9.8 12 M14.2 12 L16.2 12',
    'M12 9.8 L12 6.8',
    'M9.6 4.6 A2.6 2.6 0 0 0 14.4 4.6',
  ],
  // ——— Bâtiments génériques ———
  refinery: [
    'M2.4 21 L21.6 21',
    'M4.4 21 L4.4 9 L7.6 9 L7.6 21',
    'M9.8 21 L9.8 6 L13 6 L13 21',
    'M7.6 12.4 L9.8 12.4 M13 15.4 L15.8 15.4',
    circle(18.8, 17.4, 3),
    'M11.4 6 C10.2 4.8 10.8 3.4 11.6 2.4 C12.2 3.6 13.2 4.4 11.4 6',
  ],
  power_plant: [
    'M3.4 21 C4.8 16.4 4.8 11.8 3.8 8 L11.4 8 C10.4 11.8 10.4 16.4 11.8 21 Z',
    'M2.4 21 L21.6 21',
    'M5.4 5.6 C6.4 4.6 7.8 4.6 8.8 5.6',
    'M18 3 L15.2 10 L18.4 10 L15.8 17.4',
  ],
  port: [
    circle(12, 4.6, 1.8),
    'M12 6.4 L12 20.6',
    'M8.4 9.4 L15.6 9.4',
    'M4.8 14 C5.4 18 8.4 20.6 12 20.6 C15.6 20.6 18.6 18 19.2 14',
    'M4.8 14 L3.6 16.2 M4.8 14 L7 15',
    'M19.2 14 L20.4 16.2 M19.2 14 L17 15',
  ],
  air_base: [
    'M4 21.2 L9.4 2.8 M20 21.2 L14.6 2.8',
    'M12 19.6 L12 17 M12 13.8 L12 11.4 M12 8.6 L12 6.6 M12 4.4 L12 3.2',
    'M6.4 21.2 L17.6 21.2',
  ],
  military_base: [
    'M12 3.6 L14 9.4 L20 9.6 L15.3 13.3 L17 19.2 L12 15.8 L7 19.2 L8.7 13.3 L4 9.6 L10 9.4 Z',
    'M3 21.2 L21 21.2',
  ],
  arms_factory: [
    'M2.8 21 L2.8 11 L7.6 14 L7.6 11 L12.4 14 L12.4 11 L17.2 14 L17.2 5 L20.8 5 L20.8 21 Z',
    'M8.4 21 L8.4 17.4 L11.6 17.4 L11.6 21',
    'M14.2 17.2 L16.4 17.2',
  ],
  research_center: [
    'M3 12 a9 3.6 0 1 0 18 0 a9 3.6 0 1 0 -18 0',
    'M7.5 4.206 a9 3.6 60 1 0 9 15.588 a9 3.6 60 1 0 -9 -15.588',
    'M16.5 4.206 a9 3.6 120 1 0 -9 15.588 a9 3.6 120 1 0 9 -15.588',
    circle(12, 12, 1.4),
  ],
  // ——— Divers ———
  unknown: [
    'M9 8.6 C9 6.3 10.5 5 12 5 C13.8 5 15.2 6.2 15.2 8 C15.2 10.4 12 10.8 12 13.8',
    'M12 17.6 L12 17.7',
  ],
  city: [circle(12, 12, 4.2), circle(12, 12, 1.2)],
} as const satisfies Record<string, readonly string[]>;

export type PictogramId = keyof typeof PICTOGRAMS;
export const PICTOGRAM_IDS = Object.keys(PICTOGRAMS) as PictogramId[];

/** Pictogrammes remplis (en plus du trait) — le point du « ? » par exemple. */
export const PICTOGRAM_STROKE = 1.7;

const CATEGORY_PICTOGRAM: Record<Category, PictogramId> = {
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
  logistics: 'ifv',
  radar: 'air_defense',
};

export function isPictogramId(id: string): id is PictogramId {
  return Object.prototype.hasOwnProperty.call(PICTOGRAMS, id);
}

/** Noms d'icônes du catalogue sans pictogramme propre. */
const ICON_ALIASES: Record<string, PictogramId> = {
  infantry_mech: 'ifv',
  jammer: 'air_defense',
  sam: 'air_defense',
  mbt: 'tank',
  frigate: 'ship',
  destroyer: 'ship',
  carrier: 'ship',
  uav: 'drone',
};

/** Pictogramme d'un système d'armes : son champ `icon` s'il est connu, sinon celui de sa catégorie. */
export function pictogramFor(
  system: { icon?: string; category: Category } | undefined,
): PictogramId {
  if (!system) return 'unknown';
  if (system.icon && isPictogramId(system.icon)) return system.icon;
  if (system.icon && ICON_ALIASES[system.icon]) return ICON_ALIASES[system.icon]!;
  return CATEGORY_PICTOGRAM[system.category] ?? 'unknown';
}

export function pictogramForCategory(category: Category): PictogramId {
  return CATEGORY_PICTOGRAM[category] ?? 'unknown';
}

/** Bâtiments sans pictogramme dédié (à dessiner) : pictogramme le plus proche en attendant. */
const BUILDING_FALLBACK: Partial<Record<BuildingType, PictogramId>> = {
  oil_field: 'refinery',
  mine: 'arms_factory',
  farm: 'power_plant',
  electronics_plant: 'research_center',
  local_industry: 'arms_factory',
  recruiting_office: 'military_base',
  naval_base: 'port',
  bunker: 'military_base',
  air_defense_site: 'air_defense',
  coastal_battery: 'artillery',
  radar_station: 'air_defense',
  missile_silo: 'missile',
  hospital: 'military_base',
  secret_lab: 'research_center',
  forward_base: 'military_base',
};

export function pictogramForBuilding(b: BuildingType): PictogramId {
  return BUILDING_FALLBACK[b] ?? (b as PictogramId);
}

/** Sommets d'un hexagone à sommets latéraux (« flat-top »), centre (cx, cy), rayon r. */
export function hexPoints(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Même hexagone en chemin SVG. */
export function hexPath(cx: number, cy: number, r: number): string {
  return (
    hexPoints(cx, cy, r)
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${y.toFixed(3)}`)
      .join(' ') + ' Z'
  );
}
