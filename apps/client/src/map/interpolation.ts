import {
  bearing,
  greatCircleLine,
  legAt,
  movementDestination,
  movementEnd,
  positionAt,
  type GameTime,
  type LngLat,
  type Movement,
  type UnitView,
} from '@redline/shared';

/** Position affichée d'une unité à l'instant t : interpolée sur son trajet, sinon position fixe. */
export function unitPosition(u: UnitView, t: GameTime): LngLat {
  if (!u.move || u.move.legs.length === 0) return u.pos;
  return positionAt(u.move, t);
}

/** Vrai si l'unité se déplace à l'instant t (trajet non terminé). */
export function isMoving(u: UnitView, t: GameTime): boolean {
  return (
    !!u.move && u.move.legs.length > 0 && movementEnd(u.move) > t && (u.move.legs[0]?.t0 ?? 0) <= t
  );
}

/** Cap courant (degrés) d'une unité en mouvement, sinon null. */
export function unitHeading(u: UnitView, t: GameTime): number | null {
  if (!u.move || !isMoving(u, t)) return null;
  const leg = legAt(u.move, t);
  if (!leg) return null;
  const p = positionAt(u.move, t);
  // Cap vers la fin du segment (grand cercle : le cap varie le long du trajet).
  const d = Math.abs(p[0] - leg.to[0]) + Math.abs(p[1] - leg.to[1]);
  return d < 1e-9 ? bearing(leg.from, leg.to) : bearing(p, leg.to);
}

/** Trajet restant à partir de l'instant t (pour l'affichage), échantillonné en grand cercle. */
export function remainingPath(move: Movement, t: GameTime, stepKm = 60): LngLat[] {
  const out: LngLat[] = [];
  const start = positionAt(move, t);
  let first = true;
  for (const leg of move.legs) {
    if (leg.t1 <= t) continue;
    const from = first ? start : leg.from;
    const pts = greatCircleLine(from, leg.to, stepKm);
    if (!first) pts.shift();
    // Raccorde les longitudes dépliées au segment précédent.
    if (out.length && pts.length) {
      const last = out[out.length - 1]!;
      const off = Math.round((last[0] - pts[0]![0]) / 360) * 360;
      if (off) pts.forEach((p) => (p[0] += off));
    }
    out.push(...pts);
    first = false;
  }
  if (out.length === 0) {
    const dest = movementDestination(move);
    if (dest) out.push(dest);
  }
  return out;
}
