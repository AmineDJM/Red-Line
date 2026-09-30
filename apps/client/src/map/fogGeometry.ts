/**
 * Géométrie du brouillard : polygone mondial percé par l'union du territoire du joueur et des
 * cercles de détection de ses unités (approximation admise). Calcul exécuté dans un Web Worker.
 */
import { union, difference, intersection } from 'polyclip-ts';
import { geodesicCircle, type LngLat } from '@redline/shared';

type Ring = [number, number][];
type Poly = Ring[];
type MultiPoly = Poly[];

export interface SensorCircle {
  c: LngLat;
  r: number;
}

const WORLD: Poly = [
  [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ],
];

/** Cercle géodésique ramené dans [-180, 180] (découpé à l'antiméridien si besoin). */
export function circlePolys(s: SensorCircle, steps = 40): MultiPoly {
  const ring = geodesicCircle(s.c, s.r, steps).map(([x, y]) => [x, Math.max(-85, Math.min(85, y))] as [number, number]);
  const minX = Math.min(...ring.map((p) => p[0]));
  const maxX = Math.max(...ring.map((p) => p[0]));
  if (minX >= -180 && maxX <= 180) return [[ring]];
  // Cercle à cheval sur l'antiméridien : partie directe + copie décalée de ±360, chacune recoupée par le monde.
  const shift = minX < -180 ? 360 : -360;
  const shifted: Ring = ring.map(([x, y]) => [x + shift, y]);
  const out: MultiPoly = [];
  for (const r of [ring, shifted]) {
    try {
      out.push(...intersection([r], WORLD));
    } catch {
      /* géométrie dégénérée : ignorée */
    }
  }
  return out;
}

export function unionAll(parts: MultiPoly[]): MultiPoly {
  const valid = parts.filter((p) => p.length);
  if (!valid.length) return [];
  // Union par dichotomie : bien plus rapide qu'une accumulation séquentielle.
  let layer: MultiPoly[] = valid;
  while (layer.length > 1) {
    const next: MultiPoly[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i]!;
      const b = layer[i + 1];
      if (!b) next.push(a);
      else {
        try {
          next.push(union(a, b));
        } catch {
          next.push(a, b);
        }
      }
    }
    if (next.length === layer.length) break;
    layer = next;
  }
  return layer.flat();
}

export function fogPolygon(territory: MultiPoly, sensors: SensorCircle[]): MultiPoly {
  const holes = unionAll([territory, ...sensors.map((s) => circlePolys(s))]);
  if (!holes.length) return [WORLD];
  try {
    return difference(WORLD, holes);
  } catch {
    return [WORLD];
  }
}
