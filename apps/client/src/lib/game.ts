/**
 * Aides de lecture de la vue du joueur (noms, inventaire, droits de production). Aucune règle de
 * jeu n'est décidée ici : le moteur valide chaque ordre ; ces aides ne servent qu'à l'affichage.
 */
import type {
  BuildingType,
  Category,
  NationId,
  PlayerView,
  ResearchNode,
  SystemId,
  UnitView,
  WeaponSystem,
} from '@redline/shared';
import { t } from '../i18n/index.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

export function nationName(id: NationId | null | undefined): string {
  if (!id) return '—';
  return (
    useGame.getState().view?.nations[id]?.name ??
    useWorld.getState().nations[id]?.name ??
    id.toUpperCase()
  );
}

export function nationColor(id: NationId): string {
  const { view, me } = useGame.getState();
  if (id === me) return 'var(--rl-violet)';
  return view?.nations[id]?.color ?? useWorld.getState().nations[id]?.color ?? '#5b6674';
}

export function provinceName(id: string | null | undefined): string {
  if (!id) return '—';
  const p = useWorld.getState().provinces[id];
  return p?.cityName ?? p?.name ?? id;
}

export function systemName(id: SystemId | undefined): string {
  if (!id) return t('game.selection.unknownType');
  return useWorld.getState().catalog[id]?.name ?? id;
}

export function researchName(id: string, nodes: Record<string, ResearchNode>): string {
  return (
    nodes[id]?.name ??
    t(`researchNodes.${id.replace(/^research\./, '').replace(/\./g, '_')}`, { defaultValue: id })
  );
}

/** Libellé court d'une unité : « Su-30MKA · u12 ». */
export function unitLabel(u: UnitView, catalog: Record<string, WeaponSystem>): string {
  const name = u.systemId ? (catalog[u.systemId]?.name ?? u.systemId) : t('game.legend.detected');
  return `${name} · ${u.id}`;
}

/** Nombre d'éléments possédés par système (unités du joueur encore en vie). */
export function ownedCounts(
  view: PlayerView | null,
  me: NationId | null,
): Record<SystemId, number> {
  const out: Record<SystemId, number> = {};
  if (!view || !me) return out;
  for (const u of Object.values(view.units)) {
    if (u.owner !== me || u.level !== 'own' || u.status === 'destroyed' || !u.systemId) continue;
    out[u.systemId] = (out[u.systemId] ?? 0) + (u.count ?? 1);
  }
  return out;
}

const CATEGORY_BUILDING: Record<Category, BuildingType> = {
  fighter: 'air_base',
  bomber: 'air_base',
  air_support: 'air_base',
  helicopter: 'air_base',
  drone: 'air_base',
  tank: 'arms_factory',
  ifv: 'arms_factory',
  artillery: 'arms_factory',
  air_defense: 'arms_factory',
  strike_missile: 'arms_factory',
  nuclear: 'arms_factory',
  surface_ship: 'port',
  submarine: 'port',
  infantry: 'military_base',
  space: 'research_center',
  logistics: 'military_base',
  radar: 'arms_factory',
};

/** Bâtiment nécessaire à la production (champ du catalogue, sinon déduit de la catégorie). */
export function requiredBuilding(s: WeaponSystem): BuildingType {
  return s.requiresBuilding ?? CATEGORY_BUILDING[s.category] ?? 'military_base';
}

export interface ProductionStatus {
  /** Toutes les recherches sont faites. */
  researched: boolean;
  /** Portes de recherche manquantes. */
  missing: string[];
  /** Licence achetée (production possible sans la R&D, selon le moteur). */
  licensed: boolean;
  /** Sous embargo : achats au catalogue interdits. */
  embargoed: boolean;
  /** Productible dans ses usines (recherche ou licence). */
  producible: boolean;
  /** Importable auprès du fournisseur (exportable, pas d'embargo). */
  importable: boolean;
  licensable: boolean;
}

export function productionStatus(
  s: WeaponSystem,
  view: PlayerView | null,
  me: NationId | null,
): ProductionStatus {
  const done = new Set(view?.research?.done ?? []);
  const missing = s.requires.filter((r) => !done.has(r));
  const licensed = !!view?.licences?.some((l) => l.systemId === s.id);
  const embargoed = !!(me && view?.market?.embargoed.includes(me));
  // Sans section recherche dans la vue (phase 1), tout est considéré comme maîtrisé.
  const researched = !view?.research || missing.length === 0;
  return {
    researched,
    missing: view?.research ? missing : [],
    licensed,
    embargoed,
    producible: researched || licensed,
    importable: s.exportable && !embargoed,
    licensable: s.licensable && !licensed,
  };
}

/** Prix d'une unité produite (dollars). */
export function systemPrice(s: WeaponSystem): number {
  return s.cost.money;
}

/** Entretien journalier total des forces du joueur (dollars). */
export function totalUpkeep(
  view: PlayerView | null,
  me: NationId | null,
  catalog: Record<string, WeaponSystem>,
): number {
  let sum = 0;
  for (const [id, n] of Object.entries(ownedCounts(view, me))) {
    const s = catalog[id];
    if (s) sum += (s.upkeepPerDay / Math.max(1, s.unitSize)) * n;
  }
  return sum;
}

/** Relation affichée avec une nation. */
export function relationOf(view: PlayerView | null, id: NationId) {
  return (
    view?.diplomacy?.relations.find((r) => r.nationId === id)?.relation ??
    view?.nations[id]?.relation ??
    'peace'
  );
}

/**
 * Autonomie restante d'un aéronef (heures de jeu) : `fuelH` vaut à l'instant `fuelAt` et baisse
 * d'une heure par heure de vol.
 */
export function fuelLeft(
  m: { fuelH?: number; fuelAt?: number; airborne?: boolean } | undefined,
  now: number,
): number | null {
  if (!m || m.fuelH === undefined) return null;
  if (!m.airborne || m.fuelAt === undefined) return m.fuelH;
  return Math.max(0, m.fuelH - (now - m.fuelAt) / 3_600_000);
}
