/**
 * Carte du monde « matrice de points » (fond de l'accueil du jeu et des pages publiques).
 *
 * Grille régulière de 1° en projection équirectangulaire (longitude −180…180, latitude 84…−56 : sans
 * l'Antarctique). Un point est allumé si son centre tombe dans une province de data/map/provinces.geojson.
 * Chaque suite de points terrestres d'une rangée devient un segment `M x y h n` tracé en pointillés ronds
 * (stroke-dasharray 0 1) : ~10 Kio pour toute la planète, sans JavaScript, net à toutes les tailles.
 */

export type Ring = [number, number][];
export interface Geometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: Ring[] | Ring[][];
}
export interface FeatureCollection {
  features: { properties?: Record<string, unknown> | null; geometry: Geometry | null }[];
}

/** Bornes de la carte (degrés). Partagées avec les surimpressions (positions en %). */
export const WORLD = { west: -180, east: 180, north: 84, south: -56 } as const;

/** Position relative (0…1) d'un point lon/lat sur la carte. */
export function worldXY(lon: number, lat: number): { x: number; y: number } {
  return {
    x: (lon - WORLD.west) / (WORLD.east - WORLD.west),
    y: (WORLD.north - lat) / (WORLD.north - WORLD.south),
  };
}

interface Poly {
  rings: Ring[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function polygons(fc: FeatureCollection): Poly[] {
  const out: Poly[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const list = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as Ring[][];
    for (const rings of list) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of rings[0] ?? []) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      out.push({ rings, minX, minY, maxX, maxY });
    }
  }
  return out;
}

/** Règle pair-impair sur tous les anneaux (les trous s'excluent d'eux-mêmes). */
function inside(p: Poly, x: number, y: number): boolean {
  let c = false;
  for (const ring of p.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** Masque terre/mer : rows[j][i] vrai si la case (colonne i, rangée j) est terrestre. */
export function landMask(fc: FeatureCollection, step = 1): boolean[][] {
  const polys = polygons(fc);
  // Index par bande de latitude de 1° pour limiter les tests.
  const bands = new Map<number, Poly[]>();
  for (const p of polys) {
    for (let b = Math.floor(p.minY); b <= Math.floor(p.maxY); b++) {
      const l = bands.get(b) ?? [];
      l.push(p);
      bands.set(b, l);
    }
  }
  const cols = Math.round((WORLD.east - WORLD.west) / step);
  const rowsN = Math.round((WORLD.north - WORLD.south) / step);
  const rows: boolean[][] = [];
  for (let j = 0; j < rowsN; j++) {
    const lat = WORLD.north - (j + 0.5) * step;
    const cand = bands.get(Math.floor(lat)) ?? [];
    const row: boolean[] = [];
    for (let i = 0; i < cols; i++) {
      const lon = WORLD.west + (i + 0.5) * step;
      row.push(
        cand.some(
          (p) =>
            lon >= p.minX && lon <= p.maxX && lat >= p.minY && lat <= p.maxY && inside(p, lon, lat),
        ),
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Chemin SVG des suites de points (coordonnées entières, une unité = une case). */
export function dotsPath(rows: boolean[][]): string {
  const parts: string[] = [];
  rows.forEach((row, j) => {
    let i = 0;
    while (i < row.length) {
      if (!row[i]) {
        i++;
        continue;
      }
      const start = i;
      while (i < row.length && row[i]) i++;
      parts.push(`M${start} ${j}h${i - 1 - start}`);
    }
  });
  return parts.join('');
}

export interface WorldSvgOptions {
  step?: number;
  color?: string;
  /** Diamètre d'un point, en fraction du pas de la grille. */
  dot?: number;
}

/** Document SVG complet (autonome, sans police ni script). */
export function worldDotsSvg(fc: FeatureCollection, o: WorldSvgOptions = {}): string {
  const step = o.step ?? 1;
  const rows = landMask(fc, step);
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  const d = dotsPath(rows);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 4}" height="${h * 4}">` +
    `<path transform="translate(.5 .5)" fill="none" stroke="${o.color ?? '#7d8b99'}" ` +
    `stroke-width="${o.dot ?? 0.46}" stroke-linecap="round" stroke-dasharray="0 1" d="${d}"/></svg>\n`
  );
}
