/**
 * « Mes armées » et « Arsenal de guerre » : sélecteurs purs (testés dans test/armies.test.ts).
 *
 * Une armée est un groupe de piles du joueur réunies sur la carte : même milieu (terre, air, mer),
 * à moins de `ARMY_RADIUS_KM` les unes des autres, et même destination si elles se déplacent
 * (une colonne qui part se détache de la garnison). Les piles embarquées suivent la flotte.
 * Le numéro (« Armée 3 », « Escadre 2 », « Flotte 1 ») suit l'ancienneté de la pile de tête, qui
 * sert aussi de clé au nom donné par le joueur.
 */
import {
  distanceKm,
  movementEnd,
  positionAt,
  type BattleReportSummary,
  type Category,
  type GameTime,
  type LngLat,
  type MissionKind,
  type NationId,
  type PlayerView,
  type ProvinceDef,
  type SupplyState,
  type SystemId,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { nearestCity, unitLocation, type UnitLocation } from './location.js';

/** Rayon de regroupement d'une armée (km). */
export const ARMY_RADIUS_KM = 30;

/** Milieu d'une armée : les sites fixes (radars, batteries) rejoignent l'armée de terre. */
export type ArmyDomain = 'land' | 'air' | 'sea';
/** Milieu d'une pile (catalogue). */
export type PileDomain = 'land' | 'air' | 'sea' | 'static';

export type ArmyState = 'combat' | 'moving' | 'resupply' | 'embarked' | 'idle';
export const ARMY_STATES: ArmyState[] = ['combat', 'moving', 'resupply', 'embarked', 'idle'];

export type ArmyOrder =
  | { kind: 'move'; to: LngLat; eta: GameTime }
  | { kind: 'attack'; targetId: UnitId }
  | { kind: 'mission'; mission: MissionKind }
  | { kind: 'delegated'; directive: string }
  | { kind: 'none' };

export interface Army {
  /** Identifiant de la pile de tête (la plus ancienne). */
  id: UnitId;
  domain: ArmyDomain;
  /** Numéro dans son milieu (1, 2, 3…). */
  number: number;
  units: UnitView[];
  unitIds: UnitId[];
  piles: number;
  elements: number;
  /** Éléments par milieu de pile (terre, air, mer, fixes). */
  byDomain: Record<PileDomain, number>;
  /** Santé moyenne pondérée par l'effectif (0..1). */
  hp: number;
  state: ArmyState;
  /** Position actuelle (barycentre des piles). */
  at: LngLat;
  /** Rayon occupé (km). */
  spreadKm: number;
  order: ArmyOrder;
  supply: SupplyState | null;
  /** Vétérance maximale (0..3). */
  veterancy: number;
  generalId: string | null;
  /** Valeur au prix catalogue (dollars). */
  value: number;
}

export interface ArmyLocation extends UnitLocation {
  provinceId?: string;
  province?: string;
}

const STATE_RANK: Record<ArmyState, number> = {
  combat: 0,
  moving: 1,
  resupply: 2,
  embarked: 3,
  idle: 4,
};

const SUPPLY_RANK: Record<SupplyState, number> = { cut: 0, limited: 1, supplied: 2 };

export function pileDomain(u: UnitView, catalog: Record<string, WeaponSystem>): PileDomain {
  return (u.systemId ? catalog[u.systemId]?.movement : undefined) ?? 'land';
}

function armyDomain(u: UnitView, catalog: Record<string, WeaponSystem>): ArmyDomain {
  if (u.status === 'embarked') return 'sea';
  const d = pileDomain(u, catalog);
  return d === 'static' ? 'land' : d;
}

/** Numéro d'une unité (`u12` → 12) pour l'ordre d'ancienneté. */
function seqOf(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function byAge(a: { id: string }, b: { id: string }): number {
  return seqOf(a.id) - seqOf(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function moving(u: UnitView, now: GameTime): boolean {
  return !!u.move && u.move.legs.length > 0 && movementEnd(u.move) > now;
}

function posAt(u: UnitView, now: GameTime): LngLat {
  return u.move && u.move.legs.length ? positionAt(u.move, now) : u.pos;
}

function destOf(u: UnitView, now: GameTime): LngLat | null {
  if (!moving(u, now)) return null;
  return u.move!.legs[u.move!.legs.length - 1]!.to;
}

/** Valeur d'un élément au prix catalogue (prix unitaire réel, sinon prix du lot / taille du lot). */
export function elementPrice(s: WeaponSystem | undefined): number {
  if (!s) return 0;
  return s.unitPriceUsd ?? s.cost.money / Math.max(1, s.unitSize);
}

/** Piles du joueur engagées dans les armées (hors munitions en vol et unités détruites). */
export function ownPiles(view: PlayerView | null, me: NationId | null): UnitView[] {
  if (!view || !me) return [];
  return Object.values(view.units).filter(
    (u) => u.owner === me && u.level === 'own' && u.status !== 'destroyed' && !u.missile,
  );
}

/**
 * Regroupe les piles en armées. Déterministe : même entrée, même sortie (ordre, numéros).
 */
export function groupArmies(
  units: UnitView[],
  catalog: Record<string, WeaponSystem>,
  now: GameTime,
  view?: Pick<PlayerView, 'generals'> | null,
  radiusKm = ARMY_RADIUS_KM,
): Army[] {
  const list = [...units].sort(byAge);
  const pos = list.map((u) => posAt(u, now));
  const dest = list.map((u) => destOf(u, now));
  const dom = list.map((u) => armyDomain(u, catalog));
  // Union-find sur les voisinages (grille de 1° ; 30 km < 1° de latitude).
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const cell = (p: LngLat) => `${Math.floor(p[0])}|${Math.floor(p[1])}`;
  const grid = new Map<string, number[]>();
  list.forEach((_, i) => {
    const p = pos[i]!;
    const cx = Math.floor(p[0]);
    const cy = Math.floor(p[1]);
    // Une case de 1° en longitude rétrécit vers les pôles : on élargit le voisinage.
    const span = Math.min(
      180,
      Math.ceil(radiusKm / (111 * Math.max(0.05, Math.cos((p[1] * Math.PI) / 180)))),
    );
    for (let dx = -span; dx <= span; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const x = ((((cx + dx + 180) % 360) + 360) % 360) - 180;
        for (const j of grid.get(`${x}|${cy + dy}`) ?? []) {
          if (dom[j] !== dom[i]) continue;
          const a = dest[i];
          const b = dest[j];
          if (!!a !== !!b) continue;
          if (a && b && distanceKm(a, b) > radiusKm) continue;
          if (distanceKm(pos[j]!, p) > radiusKm) continue;
          parent[find(i)] = find(j);
        }
      }
    const k = cell(p);
    const l = grid.get(k) ?? [];
    l.push(i);
    grid.set(k, l);
  });
  const clusters = new Map<number, number[]>();
  list.forEach((_, i) => {
    const r = find(i);
    const l = clusters.get(r) ?? [];
    l.push(i);
    clusters.set(r, l);
  });
  const generalOf = new Map<UnitId, string>();
  for (const g of view?.generals ?? []) for (const id of g.unitIds) generalOf.set(id, g.id);
  const armies: Army[] = [];
  for (const idx of clusters.values()) {
    idx.sort((a, b) => a - b);
    const us = idx.map((i) => list[i]!);
    const lead = us[0]!;
    const byDomain: Record<PileDomain, number> = { land: 0, air: 0, sea: 0, static: 0 };
    let elements = 0;
    let hpw = 0;
    let lng = 0;
    let lat = 0;
    let value = 0;
    let veterancy = 0;
    let supply: SupplyState | null = null;
    const states = new Set<ArmyState>();
    const generals = new Map<string, number>();
    const missions = new Map<MissionKind, number>();
    let target: UnitId | null = null;
    // Barycentre : longitudes dépliées autour de la pile de tête (antiméridien).
    const ref = pos[idx[0]!]![0];
    for (const i of idx) {
      const u = list[i]!;
      const n = u.count ?? 1;
      const s = u.systemId ? catalog[u.systemId] : undefined;
      elements += n;
      byDomain[pileDomain(u, catalog)] += n;
      hpw += (u.hpRatio ?? 1) * n;
      let x = pos[i]![0];
      if (x - ref > 180) x -= 360;
      else if (ref - x > 180) x += 360;
      lng += x;
      lat += pos[i]![1];
      value += elementPrice(s) * n;
      veterancy = Math.max(veterancy, u.veterancy ?? 0);
      if (u.supply && (supply === null || SUPPLY_RANK[u.supply] < SUPPLY_RANK[supply]))
        supply = u.supply;
      if (u.status === 'combat') states.add('combat');
      else if (u.status === 'embarked') states.add('embarked');
      else if (dest[i] || u.status === 'moving') states.add('moving');
      else if (u.mission?.readyAt && u.mission.readyAt > now) states.add('resupply');
      else states.add('idle');
      const gid = u.generalId ?? generalOf.get(u.id);
      if (gid) generals.set(gid, (generals.get(gid) ?? 0) + 1);
      const mk = u.mission?.kind;
      if (mk && mk !== 'none') missions.set(mk, (missions.get(mk) ?? 0) + 1);
      if (u.targetId && !target) target = u.targetId;
    }
    let state: ArmyState = 'idle';
    for (const s of states) if (STATE_RANK[s] < STATE_RANK[state]) state = s;
    // Tout embarqué : « embarquée » ; une partie seulement : l'état de la flotte prime.
    if (states.has('embarked') && states.size > 1 && state === 'embarked') state = 'idle';
    let cx = lng / idx.length;
    if (cx > 180) cx -= 360;
    else if (cx < -180) cx += 360;
    const at: LngLat = [cx, lat / idx.length];
    let spreadKm = 0;
    for (const i of idx) spreadKm = Math.max(spreadKm, distanceKm(at, pos[i]!));
    const generalId = [...generals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const general = generalId ? view?.generals?.find((g) => g.id === generalId) : undefined;
    const d0 = idx.map((i) => dest[i]).find(Boolean);
    let order: ArmyOrder = { kind: 'none' };
    if (target) order = { kind: 'attack', targetId: target };
    else if (d0) {
      let eta = 0;
      for (const u of us) if (u.move && moving(u, now)) eta = Math.max(eta, movementEnd(u.move));
      order = { kind: 'move', to: d0, eta };
    } else if (missions.size)
      order = {
        kind: 'mission',
        mission: [...missions.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      };
    else if (general?.directive) order = { kind: 'delegated', directive: general.directive };
    armies.push({
      id: lead.id,
      domain: dom[idx[0]!]!,
      number: 0,
      units: us,
      unitIds: us.map((u) => u.id),
      piles: us.length,
      elements,
      byDomain,
      hp: elements ? hpw / elements : 1,
      state,
      at,
      spreadKm,
      order,
      supply,
      veterancy,
      generalId,
      value,
    });
  }
  // Numérotation par milieu, dans l'ordre d'ancienneté de la pile de tête.
  armies.sort((a, b) => byAge(a, b));
  const counters: Record<ArmyDomain, number> = { land: 0, air: 0, sea: 0 };
  for (const a of armies) a.number = ++counters[a.domain];
  return armies;
}

/** Localisation lisible d'une armée : ville, province, « en mer », « en vol », « embarquée ». */
export function armyLocation(
  a: Army,
  catalog: Record<string, WeaponSystem>,
  provinces: Record<string, ProvinceDef>,
  now: GameTime,
): ArmyLocation {
  const flying =
    a.domain === 'air' &&
    a.units.some((u) => {
      const s = u.systemId ? catalog[u.systemId] : undefined;
      return s?.movement === 'air' && (u.mission?.airborne ?? moving(u, now));
    });
  // Pile fictive au barycentre, du milieu de l'armée (une flotte qui porte des troupes est en mer).
  const l = unitLocation(
    { status: a.state === 'embarked' ? 'embarked' : 'idle' } as UnitView,
    { movement: a.domain } as WeaponSystem,
    a.at,
    provinces,
    flying,
  );
  const c = nearestCity(provinces, a.at);
  return c ? { ...l, provinceId: c.pid, province: provinces[c.pid]?.name } : l;
}

export interface ArmySummary {
  armies: number;
  piles: number;
  elements: number;
  byDomain: Record<PileDomain, { piles: number; elements: number }>;
  byState: Record<ArmyState, number>;
  inCombat: number;
  value: number;
}

export function summarizeArmies(
  armies: Army[],
  catalog: Record<string, WeaponSystem>,
): ArmySummary {
  const byDomain: ArmySummary['byDomain'] = {
    land: { piles: 0, elements: 0 },
    air: { piles: 0, elements: 0 },
    sea: { piles: 0, elements: 0 },
    static: { piles: 0, elements: 0 },
  };
  const byState = { combat: 0, moving: 0, resupply: 0, embarked: 0, idle: 0 };
  let piles = 0;
  let elements = 0;
  let value = 0;
  for (const a of armies) {
    byState[a.state]++;
    piles += a.piles;
    elements += a.elements;
    value += a.value;
    for (const u of a.units) {
      const d = pileDomain(u, catalog);
      byDomain[d].piles++;
      byDomain[d].elements += u.count ?? 1;
    }
  }
  return {
    armies: armies.length,
    piles,
    elements,
    byDomain,
    byState,
    inCombat: byState.combat,
    value,
  };
}

export interface ArmyFilter {
  domain: ArmyDomain | 'all';
  state: ArmyState | 'all';
  /** Texte (nom, matériel, ville, identifiant de pile). */
  query: string;
}

export function filterArmies(
  armies: Army[],
  f: ArmyFilter,
  text: (a: Army) => string,
  normalize: (s: string) => string = (s) => s.toLowerCase(),
): Army[] {
  const q = normalize(f.query.trim());
  return armies.filter(
    (a) =>
      (f.domain === 'all' || a.domain === f.domain) &&
      (f.state === 'all' || a.state === f.state) &&
      (!q || normalize(text(a)).includes(q)),
  );
}

/** Groupes de piles fusionnables dans une armée (même matériel, à l'arrêt, hors embarquées). */
export function mergeGroups(a: Army, catalog: Record<string, WeaponSystem>): UnitId[][] {
  const by = new Map<SystemId, UnitView[]>();
  for (const u of a.units) {
    if (!u.systemId || u.move?.legs.length || u.status === 'moving' || u.status === 'embarked')
      continue;
    if (pileDomain(u, catalog) === 'static') continue;
    const l = by.get(u.systemId) ?? [];
    l.push(u);
    by.set(u.systemId, l);
  }
  const out: UnitId[][] = [];
  for (const l of by.values()) {
    // Fusion du moteur : piles à moins de 10 km de la première.
    const first = l[0]!;
    const near = l.filter((u) => distanceKm(u.pos, first.pos) <= 10);
    if (near.length >= 2) out.push(near.map((u) => u.id));
  }
  return out;
}

// ——— Arsenal de guerre : inventaire par matériel ———

export interface InventoryRow {
  systemId: SystemId;
  category: Category;
  /** Éléments en service. */
  elements: number;
  piles: number;
  /** Éléments disponibles (à l'arrêt, hors combat, remise en œuvre et embarquement). */
  available: number;
  /** Éléments engagés (combat). */
  engaged: number;
  /** Éléments en mouvement ou en mission. */
  deployed: number;
  /** Éléments en production (file), y compris importations. */
  inProduction: number;
  /** Éléments perdus au combat (rapports de bataille). */
  losses: number;
  /** Valeur des éléments en service (dollars, prix catalogue). */
  value: number;
  /** Santé moyenne pondérée (0..1). */
  hp: number;
}

/** Pertes par matériel d'après les rapports de bataille où la nation est engagée. */
export function lossesBySystem(
  reports: BattleReportSummary[] | undefined,
  me: NationId,
): Record<SystemId, number> {
  const out: Record<SystemId, number> = {};
  for (const r of reports ?? [])
    for (const side of [r.attacker, r.defender]) {
      if (!side.nations.includes(me)) continue;
      for (const l of side.losses) out[l.systemId] = (out[l.systemId] ?? 0) + l.count;
    }
  return out;
}

export function inventory(
  view: PlayerView | null,
  me: NationId | null,
  catalog: Record<string, WeaponSystem>,
  now: GameTime,
): InventoryRow[] {
  if (!view || !me) return [];
  const rows = new Map<SystemId, InventoryRow & { hpw: number }>();
  const row = (id: SystemId) => {
    let r = rows.get(id);
    if (!r) {
      const s = catalog[id];
      r = {
        systemId: id,
        category: s?.category ?? 'infantry',
        elements: 0,
        piles: 0,
        available: 0,
        engaged: 0,
        deployed: 0,
        inProduction: 0,
        losses: 0,
        value: 0,
        hp: 1,
        hpw: 0,
      };
      rows.set(id, r);
    }
    return r;
  };
  for (const u of ownPiles(view, me)) {
    if (!u.systemId) continue;
    const r = row(u.systemId);
    const n = u.count ?? 1;
    r.elements += n;
    r.piles++;
    r.hpw += (u.hpRatio ?? 1) * n;
    r.value += elementPrice(catalog[u.systemId]) * n;
    if (u.status === 'combat') r.engaged += n;
    else if (
      moving(u, now) ||
      u.status === 'moving' ||
      u.status === 'embarked' ||
      (u.mission && u.mission.kind !== 'none') ||
      (u.mission?.readyAt && u.mission.readyAt > now)
    )
      r.deployed += n;
    else r.available += n;
  }
  for (const p of view.economy.production) {
    const s = catalog[p.systemId];
    row(p.systemId).inProduction += p.count ?? s?.unitSize ?? 1;
  }
  for (const [id, n] of Object.entries(lossesBySystem(view.battleReports, me))) row(id).losses += n;
  return [...rows.values()].map(({ hpw, ...r }) => ({
    ...r,
    hp: r.elements ? hpw / r.elements : 1,
  }));
}
