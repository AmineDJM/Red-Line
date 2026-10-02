/**
 * Centre de commandement : sélecteurs purs (testés dans test/command.test.ts) — piles libres
 * groupées par milieu et par région, composition d'une armée, santé et logistique, estimation d'une
 * mission avant validation (rapport de force, durée, chances) et coût prévisionnel du général.
 */
import {
  distanceKm,
  generalRating,
  type ArmyView,
  type Category,
  type CommandGeneralView,
  type CommandView,
  type LngLat,
  type MissionDef,
  type NationId,
  type PlayerView,
  type ProvinceDef,
  type SupplyState,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { elementPrice, ownPiles, pileDomain, type PileDomain } from './armies.js';
import { nearestCity } from './location.js';
import { stackParts } from './stacks.js';

export type Domain = 'land' | 'air' | 'sea';

/** Mission en cours de saisie (assistant) ou confiée. */
export interface MissionLike {
  type?: string | null;
  provinceId?: string;
  nationId?: string;
  at?: LngLat;
  radiusKm?: number;
}

/** Armée du joueur à laquelle appartient une pile (null si libre). */
export function armyOfUnit(command: CommandView | undefined, id: UnitId): ArmyView | null {
  return command?.armies.find((a) => a.unitIds.includes(id)) ?? null;
}

export function generalOf(
  command: CommandView | undefined,
  id: string | null | undefined,
): CommandGeneralView | null {
  if (!id) return null;
  return command?.generals.find((g) => g.id === id) ?? null;
}

/** Valeur (prix catalogue) d'une pile, santé comprise. */
export function pileValue(u: UnitView, catalog: Record<string, WeaponSystem>): number {
  let v = 0;
  for (const p of stackParts(u)) v += elementPrice(catalog[p.systemId]) * p.count;
  return v * (u.hpRatio ?? 1);
}

/** Milieu d'une pile pour l'armée (les sites fixes comptent avec la terre). */
export function domainOf(u: UnitView, catalog: Record<string, WeaponSystem>): Domain {
  const d: PileDomain = pileDomain(u, catalog);
  return d === 'static' ? 'land' : d;
}

/**
 * Piles du joueur qui ne sont dans aucune armée et qu'un général peut commander (hors munitions en
 * vol, satellites et sites fixes).
 */
export function freePiles(
  view: PlayerView | null,
  me: NationId | null,
  catalog?: Record<string, WeaponSystem>,
): UnitView[] {
  const taken = new Set<UnitId>();
  for (const a of view?.command?.armies ?? []) for (const id of a.unitIds) taken.add(id);
  return ownPiles(view, me).filter((u) => {
    if (taken.has(u.id)) return false;
    const s = catalog && u.systemId ? catalog[u.systemId] : undefined;
    return !s || (s.speedKmh > 0 && s.category !== 'space' && s.movement !== 'static');
  });
}

/** Rapport de force lisible : « ×1,8 », « ×10+ ». */
export function ratioText(r: number, locale?: string): string {
  if (r >= 10) return '×10+';
  return `×${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(r)}`;
}

export interface PileGroup {
  domain: Domain;
  /** Région : province de la ville la plus proche (nom affiché). */
  region: string;
  regionId: string | null;
  piles: UnitView[];
  elements: number;
  value: number;
}

/**
 * Piles groupées par milieu puis par région (ville la plus proche) ; ordre : terre, air, mer, puis
 * régions les plus fournies d'abord.
 */
export function groupPiles(
  piles: UnitView[],
  catalog: Record<string, WeaponSystem>,
  provinces: Record<string, ProvinceDef>,
): PileGroup[] {
  const groups = new Map<string, PileGroup>();
  for (const u of piles) {
    const domain = domainOf(u, catalog);
    const c = nearestCity(provinces, u.pos);
    const key = `${domain}|${c?.pid ?? '-'}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        domain,
        region: c?.name ?? '—',
        regionId: c?.pid ?? null,
        piles: [],
        elements: 0,
        value: 0,
      };
      groups.set(key, g);
    }
    g.piles.push(u);
    g.elements += u.count ?? 1;
    g.value += pileValue(u, catalog);
  }
  const rank: Record<Domain, number> = { land: 0, air: 1, sea: 2 };
  return [...groups.values()]
    .map((g) => ({ ...g, piles: g.piles.sort((a, b) => (a.id < b.id ? -1 : 1)) }))
    .sort(
      (a, b) =>
        rank[a.domain] - rank[b.domain] ||
        b.elements - a.elements ||
        a.region.localeCompare(b.region, 'fr'),
    );
}

export interface CompositionRow {
  category: Category;
  domain: Domain;
  elements: number;
  piles: number;
  value: number;
}

/** Composition d'un ensemble de piles par catégorie de matériel (piles mixtes détaillées). */
export function composition(
  units: UnitView[],
  catalog: Record<string, WeaponSystem>,
): CompositionRow[] {
  const by = new Map<Category, CompositionRow>();
  for (const u of units) {
    const seen = new Set<Category>();
    for (const p of stackParts(u)) {
      const s = catalog[p.systemId];
      if (!s) continue;
      let r = by.get(s.category);
      if (!r) {
        r = {
          category: s.category,
          domain: s.movement === 'static' ? 'land' : (s.movement as Domain),
          elements: 0,
          piles: 0,
          value: 0,
        };
        by.set(s.category, r);
      }
      r.elements += p.count;
      r.value += elementPrice(s) * p.count * (u.hpRatio ?? 1);
      if (!seen.has(s.category)) {
        r.piles++;
        seen.add(s.category);
      }
    }
  }
  const rank: Record<Domain, number> = { land: 0, air: 1, sea: 2 };
  return [...by.values()].sort(
    (a, b) =>
      rank[a.domain] - rank[b.domain] || b.value - a.value || (a.category < b.category ? -1 : 1),
  );
}

/** Milieux présents (au moins une pile). */
export function domainsOf(units: UnitView[], catalog: Record<string, WeaponSystem>): Set<Domain> {
  return new Set(units.map((u) => domainOf(u, catalog)));
}

/** Piles d'une armée présentes dans la vue. */
export function armyUnits(army: ArmyView, view: PlayerView | null): UnitView[] {
  return army.unitIds.map((id) => view?.units[id]).filter((u): u is UnitView => !!u);
}

/** Santé moyenne pondérée par l'effectif (0..1). */
export function healthOf(units: UnitView[]): number {
  let w = 0;
  let h = 0;
  for (const u of units) {
    const n = u.count ?? 1;
    w += n;
    h += (u.hpRatio ?? 1) * n;
  }
  return w ? h / w : 1;
}

const SUPPLY_RANK: Record<SupplyState, number> = { cut: 0, limited: 1, supplied: 2 };

/** Ravitaillement le plus mauvais des piles (null si inconnu). */
export function supplyOf(units: UnitView[]): SupplyState | null {
  let s: SupplyState | null = null;
  for (const u of units)
    if (u.supply && (!s || SUPPLY_RANK[u.supply] < SUPPLY_RANK[s])) s = u.supply;
  return s;
}

/** Effectifs par rapport au lancement de la mission (0..1+, 1 sans mission). */
export function strengthOf(a: ArmyView): number {
  return a.strength.start > 0 ? a.strength.now / a.strength.start : 1;
}

export type Pill = 'good' | 'warn' | 'bad';

export function pill(v: number, warn = 0.7, bad = 0.4): Pill {
  return v >= warn ? 'good' : v >= bad ? 'warn' : 'bad';
}

export function supplyPill(s: SupplyState | null): Pill {
  return s === 'cut' ? 'bad' : s === 'limited' ? 'warn' : 'good';
}

/** Barycentre des piles (longitudes dépliées autour de la première). */
export function centroidOf(points: LngLat[]): LngLat | null {
  if (!points.length) return null;
  const ref = points[0]![0];
  let x = 0;
  let y = 0;
  for (const p of points) {
    let lng = p[0];
    if (lng - ref > 180) lng -= 360;
    else if (ref - lng > 180) lng += 360;
    x += lng;
    y += p[1];
  }
  let cx = x / points.length;
  if (cx > 180) cx -= 360;
  if (cx < -180) cx += 360;
  return [cx, y / points.length];
}

/** Missions des données, dans l'ordre d'affichage. */
export function missionList(command: CommandView | undefined): [string, MissionDef][] {
  return Object.entries(command?.missions ?? {}).sort(
    (a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1),
  );
}

/** Adéquation de la composition à la mission : tous les milieux attendus, une partie, aucun. */
export function domainFit(def: MissionDef, have: Set<Domain>): 'ok' | 'partial' | 'missing' {
  const want = def.domains;
  const hit = want.filter((d) => have.has(d)).length;
  // Une mission terrestre accepte une armée interarmes ; il suffit du milieu principal.
  if (hit === want.length || (hit > 0 && have.has(want[0]!))) return 'ok';
  return hit > 0 ? 'partial' : 'missing';
}

/** La mission a-t-elle sa cible ? */
export function targetReady(def: MissionDef, m: MissionLike): boolean {
  switch (def.target) {
    case 'province':
      return !!m.provinceId;
    case 'nation':
      return !!m.nationId || def.brain === 'hold_front';
    case 'zone':
      return !!m.at;
    default:
      return true;
  }
}

/** Compétence qui compte le plus pour une mission. */
export function keySkill(def: MissionDef): 'offense' | 'defense' | 'air' | 'naval' {
  switch (def.brain) {
    case 'conquer':
      return 'offense';
    case 'landing':
    case 'sea_control':
      return 'naval';
    case 'air_superiority':
    case 'air_defense':
    case 'deep_strike':
      return 'air';
    default:
      return 'defense';
  }
}

export interface Estimate {
  ratio: number;
  chance: number;
  etaHours: number | null;
  /** Force ennemie estimée (dollars) et source : contacts vus, estimation publique, aucune. */
  enemy: number;
  source: 'seen' | 'estimate' | 'none';
}

/**
 * Estimation avant validation (même logique que le général, avec ce que voit le joueur) : force de
 * l'armée / force ennemie (contacts identifiés près de l'objectif, sinon part de l'estimation
 * publique de la nation), chances selon la compétence clé et l'expérience, durée d'approche.
 */
export function previewEstimate(opts: {
  view: PlayerView;
  catalog: Record<string, WeaponSystem>;
  provinces: Record<string, ProvinceDef>;
  units: UnitView[];
  def: MissionDef;
  mission: MissionLike;
  general: CommandGeneralView | null;
  captureMinutes: number;
}): Estimate {
  const { view, catalog, provinces, units, def, mission, general } = opts;
  const air = def.brain === 'air_superiority' || def.brain === 'deep_strike';
  const mine = units
    .filter((u) => !air || domainOf(u, catalog) === 'air')
    .reduce((s, u) => s + pileValue(u, catalog), 0);
  const goal: LngLat | null =
    mission.at ??
    (mission.provinceId ? (provinces[mission.provinceId]?.cityPoint ?? null) : null) ??
    (mission.nationId
      ? (Object.values(provinces).find((p) => p.nationId === mission.nationId && p.isCapital)
          ?.cityPoint ?? null)
      : null);
  const radius =
    def.target === 'zone' ? (mission.radiusKm ?? def.radiusKm) : def.target === 'nation' ? 400 : 40;
  let enemy = 0;
  let source: Estimate['source'] = 'none';
  if (goal) {
    for (const u of Object.values(view.units)) {
      if (u.owner === view.me || u.level === 'own' || u.missile) continue;
      if (view.nations[u.owner]?.relation !== 'war' && def.brain !== 'conquer') continue;
      if (
        air &&
        domainOf(u, catalog) !== 'air' &&
        !(catalog[u.systemId ?? '']?.category === 'air_defense')
      )
        continue;
      if (distanceKm(u.pos, goal) > radius + (def.target === 'zone' ? 300 : 0)) continue;
      const s = u.systemId ? catalog[u.systemId] : undefined;
      enemy += s ? pileValue(u, catalog) : 0;
    }
    if (enemy > 0) source = 'seen';
  }
  const owner =
    mission.nationId ??
    (mission.provinceId ? (view.provinces[mission.provinceId]?.owner ?? null) : null);
  if (enemy <= 0 && owner && owner !== view.me) {
    const est = view.command?.estimates[owner];
    if (est) {
      const provs = Math.max(
        1,
        Object.values(view.provinces).filter((p) => p.owner === owner).length,
      );
      // Une province : un quart de la part moyenne (comme le général) ; une nation : le tout.
      enemy =
        def.target === 'nation' ? est : (est / provs) * 0.25 * (def.brain === 'landing' ? 1.5 : 1);
      source = 'estimate';
    }
  }
  const ratio = enemy > 0 ? Math.min(99, mine / enemy) : mine > 0 ? 99 : 0;
  const skill = general ? general.skills[keySkill(def)] : 30;
  const exp = general ? general.skills.experience : 20;
  const x = Math.min(ratio, 10) * (0.85 + (0.3 * skill) / 100) * (0.9 + (0.2 * exp) / 100);
  const audacity = general ? general.skills.audacity : 50;
  const need = Math.max(0.8, 1.5 + ((50 - audacity) / 100) * 0.6);
  const chance = Math.max(0.03, Math.min(0.97, (x * x) / (x * x + need * need * 0.64)));
  let etaHours: number | null = null;
  const at = centroidOf(units.map((u) => u.pos));
  if (goal && at) {
    let speed = Infinity;
    for (const u of units) {
      for (const p of stackParts(u)) {
        const s = catalog[p.systemId];
        if (!s || s.speedKmh <= 0) continue;
        if (!air && s.movement === 'air') continue;
        speed = Math.min(speed, s.speedKmh);
      }
    }
    if (Number.isFinite(speed)) {
      const d = Math.max(0, distanceKm(at, goal) - (def.target === 'zone' ? radius : 0));
      etaHours = (d * 1.3) / speed;
      if (def.brain === 'conquer' || def.brain === 'landing') etaHours += opts.captureMinutes / 60;
      etaHours = Math.round(etaHours * 10) / 10;
    }
  }
  return {
    ratio: Math.round(ratio * 100) / 100,
    chance: Math.round(chance * 100) / 100,
    etaHours,
    enemy,
    source,
  };
}

/** Coût prévisionnel : prime d'engagement (candidat) + solde sur la durée estimée (au moins un jour). */
export function missionCost(g: CommandGeneralView, etaHours: number | null): number {
  const days = Math.max(1, Math.ceil((etaHours ?? 24) / 24));
  return (g.status === 'candidate' ? g.hireCost : 0) + g.salaryPerDay * days;
}

/** Note globale (0..100) et grade en étoiles. */
export function ratingOf(g: CommandGeneralView): number {
  return Math.round(generalRating(g.skills));
}

/** Généraux recrutés libres (sans armée, en état de commander). */
export function availableGenerals(command: CommandView | undefined): CommandGeneralView[] {
  return (command?.generals ?? []).filter((g) => !g.armyId && g.status === 'active');
}

/** Premier numéro libre pour un nom d'armée par défaut (« 1re Armée », « 2e Armée »…). */
export function nextArmyNumber(
  command: CommandView | undefined,
  nameOf: (n: number) => string,
): number {
  const used = new Set((command?.armies ?? []).map((a) => a.name));
  let n = 1;
  while (used.has(nameOf(n))) n++;
  return n;
}

/** Milieu dominant (en valeur) d'un ensemble de piles. */
export function dominantDomain(units: UnitView[], catalog: Record<string, WeaponSystem>): Domain {
  const v: Record<Domain, number> = { land: 0, air: 0, sea: 0 };
  for (const u of units) v[domainOf(u, catalog)] += pileValue(u, catalog) || 1;
  return (Object.keys(v) as Domain[]).sort((a, b) => v[b] - v[a])[0]!;
}

/** Demandes du général en attente, toutes armées confondues. */
export function pendingRequests(command: CommandView | undefined): number {
  return (command?.armies ?? []).filter((a) => !!a.request).length;
}
