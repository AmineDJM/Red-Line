import { EARTH_RADIUS_KM, type GameTime, type LngLat } from './ids.js';
import type { Leg, Movement } from './view.js';

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function toVec([lng, lat]: LngLat): Vec3 {
  const la = lat * RAD;
  const lo = lng * RAD;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function fromVec([x, y, z]: Vec3): LngLat {
  const n = Math.hypot(x, y, z) || 1;
  return [Math.atan2(y, x) * DEG, Math.asin(Math.max(-1, Math.min(1, z / n))) * DEG];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Angle central entre deux points, en radians. */
export function centralAngle(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance orthodromique en km. */
export function distanceKm(a: LngLat, b: LngLat): number {
  return centralAngle(a, b) * EARTH_RADIUS_KM;
}

/** Point à la fraction f (0..1) du grand cercle de a vers b. */
export function interpolate(a: LngLat, b: LngLat, f: number): LngLat {
  const d = centralAngle(a, b);
  if (d < 1e-12) return [a[0], a[1]];
  const s = Math.sin(d);
  const k1 = Math.sin((1 - f) * d) / s;
  const k2 = Math.sin(f * d) / s;
  const va = toVec(a);
  const vb = toVec(b);
  return fromVec([k1 * va[0] + k2 * vb[0], k1 * va[1] + k2 * vb[1], k1 * va[2] + k2 * vb[2]]);
}

/** Cap initial de a vers b, en degrés (0 = nord, sens horaire). */
export function bearing(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = [a[0] * RAD, a[1] * RAD];
  const [lng2, lat2] = [b[0] * RAD, b[1] * RAD];
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** Point atteint depuis p en suivant le cap `bearingDeg` sur `distKm`. */
export function destination(p: LngLat, bearingDeg: number, distKm: number): LngLat {
  const d = distKm / EARTH_RADIUS_KM;
  const br = bearingDeg * RAD;
  const lat1 = p[1] * RAD;
  const lng1 = p[0] * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [normalizeLng(lng2 * DEG), lat2 * DEG];
}

export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Segment actif à l'instant t (le premier si avant, le dernier si après). */
export function legAt(move: Movement, t: GameTime): Leg | undefined {
  const { legs } = move;
  if (legs.length === 0) return undefined;
  for (const leg of legs) if (t < leg.t1) return leg;
  return legs[legs.length - 1];
}

/** Position interpolée sur un trajet (même code côté serveur et côté client). */
export function positionAt(move: Movement, t: GameTime): LngLat {
  const leg = legAt(move, t);
  if (!leg) throw new Error('trajet vide');
  if (t <= leg.t0) return [leg.from[0], leg.from[1]];
  if (t >= leg.t1) return [leg.to[0], leg.to[1]];
  return interpolate(leg.from, leg.to, (t - leg.t0) / (leg.t1 - leg.t0));
}

export function movementStart(move: Movement): GameTime {
  return move.legs[0]?.t0 ?? 0;
}

export function movementEnd(move: Movement): GameTime {
  return move.legs[move.legs.length - 1]?.t1 ?? 0;
}

export function movementDestination(move: Movement): LngLat | undefined {
  return move.legs[move.legs.length - 1]?.to;
}

/** Longueur totale d'un trajet en km. */
export function movementLengthKm(move: Movement): number {
  return move.legs.reduce((s, l) => s + distanceKm(l.from, l.to), 0);
}

/**
 * Déplie les longitudes pour qu'une ligne traversant l'antiméridien reste continue
 * (MapLibre accepte des longitudes hors de [-180, 180]).
 */
export function unwrapLngs(coords: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  let offset = 0;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]!;
    if (i > 0) {
      const prev = coords[i - 1]!;
      const d = c[0] - prev[0];
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    out.push([c[0] + offset, c[1]]);
  }
  return out;
}

/** Échantillonne le grand cercle a→b pour l'affichage (au moins un point tous les `stepKm`). */
export function greatCircleLine(a: LngLat, b: LngLat, stepKm = 50): LngLat[] {
  const n = Math.max(1, Math.ceil(distanceKm(a, b) / stepKm));
  const pts: LngLat[] = [];
  for (let i = 0; i <= n; i++) pts.push(interpolate(a, b, i / n));
  return unwrapLngs(pts);
}

/** Cercle géodésique (anneau fermé) de rayon `radiusKm`, pour les zones de portée. */
export function geodesicCircle(center: LngLat, radiusKm: number, steps = 96): LngLat[] {
  const ring: LngLat[] = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(center, (360 * i) / steps, radiusKm));
  return unwrapLngs(ring);
}
