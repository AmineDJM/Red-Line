import {
  StacksBalanceSchema,
  distanceKm,
  positionAt,
  stackClassOf,
  type Balance,
  type GameTime,
  type LngLat,
  type Order,
  type StackPartView,
  type SystemId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';

/**
 * Piles (logique pure, sans React) : composition d'une pile, caractéristiques combinées et ordres
 * `split` / `merge` prêts à envoyer. Réutilisable par la carte, la fenêtre Armée, le menu de choix de
 * pile et la console. Le moteur reste seul juge (mêmes règles, revalidées côté serveur).
 */

type Catalog = Record<SystemId, WeaponSystem>;

/** Éléments d'une pile (une pile d'un seul matériel donne un seul élément). */
export function stackParts(u: UnitView): StackPartView[] {
  if (u.parts && u.parts.length > 0) return u.parts;
  if (!u.systemId) return [];
  return [{ systemId: u.systemId, count: u.count ?? 1 }];
}

/** Pile de plusieurs matériels. */
export function isMixed(u: UnitView): boolean {
  return (u.parts?.length ?? 0) > 1;
}

export interface StackSummary {
  /** Éléments au total. */
  count: number;
  /** Matériels différents. */
  systems: number;
  /** Vitesse de la pile : celle du plus lent (km/h). */
  speedKmh: number;
  /** Portée d'arme la plus longue (km). */
  rangeKm: number;
  /** Portée de détection la plus longue (km). */
  detectionKm: number;
}

/** Caractéristiques combinées d'une pile (comme le moteur : plus lent, plus longue portée). */
export function stackSummary(u: UnitView, catalog: Catalog): StackSummary | null {
  const parts = stackParts(u).filter((p) => catalog[p.systemId]);
  if (parts.length === 0) return null;
  const sys = parts.map((p) => catalog[p.systemId]!);
  return {
    count: parts.reduce((a, p) => a + p.count, 0),
    systems: parts.length,
    speedKmh: Math.min(...sys.map((s) => s.speedKmh)),
    rangeKm: Math.max(...sys.map((s) => s.weaponRangeKm.max)),
    detectionKm: Math.max(...sys.map((s) => s.detectionRangeKm)),
  };
}

/** Une pile peut-elle être divisée (pile à soi d'au moins deux éléments) ? */
export function canSplit(u: UnitView): boolean {
  return u.level === 'own' && (u.count ?? 0) >= 2 && !u.missile && !u.decoy;
}

/** « Diviser en 2 ». */
export function splitHalfOrder(u: UnitView): Order | null {
  if (!canSplit(u)) return null;
  return { kind: 'split', unitId: u.id, mode: 'half' };
}

/** « Détacher… » : `n` éléments (pile mixte : au prorata de chaque matériel). */
export function detachOrder(u: UnitView, n: number): Order | null {
  const count = Math.floor(n);
  if (!canSplit(u) || count < 1 || count >= (u.count ?? 0)) return null;
  return { kind: 'split', unitId: u.id, count };
}

/** Détacher des éléments précis par matériel. */
export function detachPartsOrder(u: UnitView, parts: StackPartView[]): Order | null {
  const own = new Map(stackParts(u).map((p) => [p.systemId, p.count]));
  const list = parts.filter((p) => p.count > 0);
  const total = list.reduce((a, p) => a + p.count, 0);
  if (!canSplit(u) || list.length === 0 || total >= (u.count ?? 0)) return null;
  if (list.some((p) => (own.get(p.systemId) ?? 0) < p.count)) return null;
  return { kind: 'split', unitId: u.id, parts: list.map((p) => ({ ...p })) };
}

/** « Séparer par type » : une pile par matériel. */
export function splitByTypeOrder(u: UnitView): Order | null {
  if (u.level !== 'own' || !isMixed(u)) return null;
  return { kind: 'split', unitId: u.id, mode: 'type' };
}

/** Raison d'un refus de fusion, vérifiée avant l'envoi (libellés : stacks.block.<raison>). */
export type MergeBlock = 'count' | 'owner' | 'moving' | 'distance' | 'domain';

/** Position d'une unité à l'instant `now`. */
function posAt(u: UnitView, now: GameTime): LngLat {
  return u.move ? positionAt(u.move, now) : u.pos;
}

/**
 * « Fusionner la sélection » : ordre `merge` si les piles sont à soi, à l'arrêt, à moins de
 * `stacks.mergeKm` et compatibles (même matériel, ou matériels d'une même classe de fusion).
 */
export function mergeOrder(
  units: UnitView[],
  catalog: Catalog,
  balance: Balance | null,
  now: GameTime,
): { order: Order | null; block: MergeBlock | null } {
  const sb = StacksBalanceSchema.parse(balance?.stacks ?? {});
  if (units.length < 2) return { order: null, block: 'count' };
  if (units.some((u) => u.level !== 'own')) return { order: null, block: 'owner' };
  if (units.some((u) => u.status === 'moving')) return { order: null, block: 'moving' };
  const p0 = posAt(units[0]!, now);
  if (units.some((u) => distanceKm(posAt(u, now), p0) > sb.mergeKm))
    return { order: null, block: 'distance' };
  const systems = new Set<SystemId>();
  for (const u of units) for (const p of stackParts(u)) systems.add(p.systemId);
  if (systems.size > 1) {
    const classes = new Set<string | null>();
    for (const id of systems) {
      const s = catalog[id];
      classes.add(s ? stackClassOf(s, sb.classes) : null);
    }
    if (classes.size !== 1 || classes.has(null)) return { order: null, block: 'domain' };
  }
  return { order: { kind: 'merge', unitIds: units.map((u) => u.id) }, block: null };
}
