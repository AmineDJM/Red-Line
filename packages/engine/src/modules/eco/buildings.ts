import {
  BUILDING_TYPES,
  HOUR,
  RESOURCES,
  type BuildingType,
  type NationId,
  type Order,
  type ProvinceId,
  type Resource,
} from '@redline/shared';
import type { OrderResult, World } from '../../api.js';
import { notify, provincesOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { board, scheduleMod } from '../kit.js';
import { signal } from '../registry.js';
import type { StaticSite } from '../types.js';
import { cfg, effect, isLiveWorld } from './config.js';
import { eco, sortedIds, type BState } from './state.js';
import { book, fail } from './util.js';

const BUILDING_SET = new Set<string>(BUILDING_TYPES);

/** Bâtiments de ressources : ressource produite. */
export const RESOURCE_BUILDINGS: Partial<Record<BuildingType, Resource>> = {
  oil_field: 'oil',
  mine: 'metals',
  farm: 'food',
  electronics_plant: 'electronics',
};

/** Bâtiments fixes exposés au module militaire (board.sites). */
const SITE_TYPES = new Set([
  'air_defense_site',
  'coastal_battery',
  'radar_station',
  'missile_silo',
]);

// ——— Bâtiments de départ (carte + répartition déterministe des bâtiments de ressources) ———

const baseCache = new WeakMap<World, Map<ProvinceId, Map<BuildingType, number>>>();

/**
 * Bâtiments de départ et leur niveau : ceux de la carte (niveau 1), plus, en économie réelle, des
 * bâtiments de ressources répartis selon les rendements des provinces (les meilleurs producteurs ont
 * les niveaux les plus élevés) :
 *  - puits de pétrole chez tous les producteurs de pétrole ;
 *  - mines (60 % des producteurs de métaux), fermes (50 % des producteurs de nourriture),
 *    usines d'électronique (40 % des producteurs d'électronique) ;
 *  - industrie locale dans les capitales (niveau 3) et les grandes villes (niveau 2).
 */
export function baseBuildings(world: World): Map<ProvinceId, Map<BuildingType, number>> {
  let m = baseCache.get(world);
  if (m) return m;
  m = new Map();
  const w = wi(world);
  const put = (pid: ProvinceId, b: BuildingType, lvl: number) => {
    let pm = m!.get(pid);
    if (!pm) m!.set(pid, (pm = new Map()));
    pm.set(b, Math.max(pm.get(b) ?? 0, lvl));
  };
  for (const pid of w.provIds) for (const b of w.provById.get(pid)!.buildings) put(pid, b, 1);
  if (isLiveWorld(world) && cfg(world).buildings.distribute) {
    const rules: [Resource, BuildingType, number][] = [
      ['oil', 'oil_field', 1],
      ['metals', 'mine', 0.6],
      ['food', 'farm', 0.5],
      ['electronics', 'electronics_plant', 0.4],
    ];
    for (const [r, b, share] of rules) {
      const list = w.provIds
        .map((pid) => ({ pid, v: w.provById.get(pid)!.income[r] ?? 0 }))
        .filter((x) => x.v > 0)
        .sort((a, b2) => b2.v - a.v || (a.pid < b2.pid ? -1 : 1));
      const k = Math.ceil(list.length * share);
      for (let i = 0; i < k; i++) put(list[i]!.pid, b, 5 - Math.floor((5 * i) / k));
    }
    for (const pid of w.provIds) {
      const def = w.provById.get(pid)!;
      const rank = def.cityRank ?? (def.isCapital ? 1 : 4);
      if (rank <= 2) put(pid, 'local_industry', rank === 1 ? 3 : 2);
    }
  }
  baseCache.set(world, m);
  return m;
}

/** Bâtiments présents dans une province (départ + construits), triés. */
export function buildingsOf(state: EngineState, pid: ProvinceId): BuildingType[] {
  const base = baseBuildings(state.world).get(pid);
  const extra = eco(state).bld[pid];
  const out = new Set<BuildingType>(base ? [...base.keys()] : []);
  if (extra) for (const b of sortedIds(extra)) if (extra[b]!.add) out.add(b as BuildingType);
  return [...out].sort();
}

export function hasBuilding(state: EngineState, pid: ProvinceId, b: string): boolean {
  if (
    baseBuildings(state.world)
      .get(pid)
      ?.has(b as BuildingType)
  )
    return true;
  return !!eco(state).bld[pid]?.[b]?.add;
}

/** Niveau d'un bâtiment (0 s'il est absent). */
export function levelOf(state: EngineState, pid: ProvinceId, b: string): number {
  const s = eco(state).bld[pid]?.[b];
  if (s?.lvl !== undefined) return s.lvl;
  const base = baseBuildings(state.world)
    .get(pid)
    ?.get(b as BuildingType);
  if (base !== undefined) return base;
  return s?.add ? 1 : 0;
}

/** Santé 0..1 d'un bâtiment (0 s'il est absent). */
export function health(state: EngineState, pid: ProvinceId, b: string): number {
  if (!hasBuilding(state, pid, b)) return 0;
  return eco(state).bld[pid]?.[b]?.h ?? 1;
}

/** Puissance effective : niveau × santé. */
export function power(state: EngineState, pid: ProvinceId, b: string): number {
  return levelOf(state, pid, b) * health(state, pid, b);
}

function bstate(state: EngineState, pid: ProvinceId, b: string): BState {
  const es = eco(state);
  const m = (es.bld[pid] ??= {});
  return (m[b] ??= { h: 1, rep: null, rv: 0 });
}

/** Retire l'entrée si elle est revenue au défaut (état canonique). */
function tidy(state: EngineState, pid: ProvinceId, b: string): void {
  const es = eco(state);
  const m = es.bld[pid];
  const s = m?.[b];
  if (!m || !s) return;
  if (
    s.lvl !== undefined &&
    s.lvl ===
      baseBuildings(state.world)
        .get(pid)
        ?.get(b as BuildingType)
  )
    delete s.lvl;
  if (s.h >= 1 && s.rep === null && !s.add && s.lvl === undefined) delete m[b];
  if (Object.keys(m).length === 0) delete es.bld[pid];
}

// ——— Sites fixes exposés au module militaire ———

function siteRange(world: World, b: string, level: number): number {
  return effect(world, b, 'rangeKmPerLevel', 0) * level;
}

/** Met à jour board.sites pour un bâtiment et annonce le changement (static_defense, radar_station). */
export function syncSite(state: EngineState, pid: ProvinceId, b: string): void {
  if (!SITE_TYPES.has(b)) return;
  const sites = board(state).sites;
  const key = `${pid}:${b}`;
  const P = state.provinces[pid];
  const level = P ? levelOf(state, pid, b) : 0;
  const prev = sites[key];
  let next: StaticSite | undefined;
  if (P && level > 0) {
    next = {
      n: P.owner,
      pid,
      b: b as StaticSite['b'],
      level,
      h: health(state, pid, b),
      at: wi(state.world).provById.get(pid)!.cityPoint,
      rangeKm: siteRange(state.world, b, level),
    };
  }
  if (
    prev &&
    next &&
    prev.n === next.n &&
    prev.level === next.level &&
    prev.h === next.h &&
    prev.rangeKm === next.rangeKm
  )
    return;
  if (next) sites[key] = next;
  else if (prev) delete sites[key];
  else return;
  const data = {
    nation: next?.n ?? prev!.n,
    pid,
    building: b,
    level: next?.level ?? 0,
    health: next?.h ?? 0,
    at: next?.at ?? prev!.at,
    rangeKm: next?.rangeKm ?? 0,
  };
  signal(state, b === 'radar_station' ? 'radar_station' : 'static_defense', data);
}

function syncSites(state: EngineState, pid: ProvinceId): void {
  for (const b of buildingsOf(state, pid)) syncSite(state, pid, b);
}

// ——— Dégâts ———

/** Moral d'une province (0..100). */
export function moraleOf(state: EngineState, pid: ProvinceId): number {
  return eco(state).morale[pid] ?? cfg(state.world).morale.start;
}

export function setMorale(state: EngineState, pid: ProvinceId, v: number): void {
  const x = Math.max(0, Math.min(100, v));
  const es = eco(state);
  if (x === cfg(state.world).morale.start) delete es.morale[pid];
  else es.morale[pid] = x;
}

/** Dégâts sur un bâtiment (frappe, sabotage, explosion) : santé réduite, réparation interrompue. */
export function damageBuilding(
  state: EngineState,
  pid: ProvinceId,
  b: string,
  damage: number,
  by: NationId | null,
): void {
  if (!(damage > 0) || !hasBuilding(state, pid, b)) return;
  const P = state.provinces[pid];
  if (!P) return;
  const s = bstate(state, pid, b);
  const before = s.h;
  s.h = Math.max(0, s.h - Math.min(1, damage));
  if (s.rep !== null) {
    s.rep = null;
    s.rv++;
  }
  tidy(state, pid, b);
  if (eco(state).live)
    setMorale(
      state,
      pid,
      moraleOf(state, pid) - cfg(state.world).morale.hitPenalty * (before - s.h),
    );
  syncSite(state, pid, b);
  const aud = [P.owner];
  if (by && state.nations[by]) aud.push(by);
  notify(
    state,
    {
      kind: 'building_hit',
      time: state.time,
      at: wi(state.world).provById.get(pid)!.cityPoint,
      provinceId: pid,
      building: b as BuildingType,
      health: health(state, pid, b),
    },
    aud,
  );
}

/** Explosion nucléaire : bâtiments de la province détruits, voisins à moitié, moral effondré. */
export function nuclearDamage(state: EngineState, pid: ProvinceId, by: NationId | null): void {
  const def = wi(state.world).provById.get(pid);
  if (!def || !state.provinces[pid]) return;
  for (const b of buildingsOf(state, pid)) damageBuilding(state, pid, b, 1, by);
  for (const q of [...def.neighbors].sort()) {
    if (!state.provinces[q]) continue;
    for (const b of buildingsOf(state, q)) damageBuilding(state, q, b, 0.5, by);
  }
  if (eco(state).live)
    setMorale(state, pid, moraleOf(state, pid) - cfg(state.world).morale.nuclearPenalty);
}

// ——— Effets ———

/**
 * Bonus des centrales électriques pour une province : meilleure centrale de la province ou d'une
 * voisine de la même nation, `1 + (effet − 1) × niveau × santé`.
 */
function plantBoost(state: EngineState, pid: ProvinceId, key: string): number {
  const P = state.provinces[pid];
  if (!P) return 1;
  const def = wi(state.world).provById.get(pid)!;
  const e = effect(state.world, 'power_plant', key, 1);
  let best = 1;
  for (const q of [pid, ...def.neighbors]) {
    if (state.provinces[q]?.owner !== P.owner) continue;
    const p = power(state, q, 'power_plant');
    if (p > 0) best = Math.max(best, 1 + (e - 1) * p);
  }
  return best;
}

/**
 * Vitesse de production d'une province pour l'un des bâtiments acceptés (le meilleur) :
 * vitesse nominale × (1 + levelSpeed × (niveau − 1)) × (0,5 + 0,5 × santé) × centrales.
 * 0 si aucun bâtiment accepté n'est en état.
 */
export function provinceProductionSpeed(
  state: EngineState,
  pid: ProvinceId,
  accepted: readonly string[],
): number {
  let best = 0;
  for (const b of accepted) {
    const h = health(state, pid, b);
    if (h <= 0) continue;
    const lvl = levelOf(state, pid, b);
    const base = effect(state.world, b, 'productionSpeed', 1);
    const v = base * (1 + effect(state.world, b, 'levelSpeed', 0) * (lvl - 1)) * (0.5 + 0.5 * h);
    if (v > best) best = v;
  }
  return best * plantBoost(state, pid, 'productionSpeed');
}

/** Facteur de vitesse de recherche : centres de recherche (centrales voisines) et laboratoires secrets. */
export function researchBuildingFactor(state: EngineState, n: NationId): number {
  const per = effect(state.world, 'research_center', 'researchSpeed', 0);
  const lab = effect(state.world, 'secret_lab', 'researchSpeedPerLevel', 0);
  const cap = effect(state.world, 'research_center', 'researchSpeedCap', 1);
  let sum = 0;
  for (const pid of provincesOf(state, n)) {
    const p = power(state, pid, 'research_center');
    if (p > 0) sum += per * p * plantBoost(state, pid, 'researchSpeed');
    sum += lab * power(state, pid, 'secret_lab');
  }
  return 1 + Math.min(cap, sum);
}

/** Ressources produites par jour par une province (rendement de la carte × bâtiments). */
export function provinceResources(state: EngineState, pid: ProvinceId): Record<Resource, number> {
  const def = wi(state.world).provById.get(pid)!;
  const mult = state.world.balance.economy.incomeMultiplier;
  const out = {} as Record<Resource, number>;
  for (const r of RESOURCES) out[r] = (def.income[r] ?? 0) * mult;
  if (!eco(state).live) return out;
  for (const [b, r] of Object.entries(RESOURCE_BUILDINGS) as [BuildingType, Resource][]) {
    const p = power(state, pid, b);
    if (p <= 0) continue;
    out[r] +=
      (def.income[r] ?? 0) * mult * effect(state.world, b, 'yieldPerLevel', 0) * p +
      effect(state.world, b, 'flatPerLevel', 0) * p;
  }
  out.oil += effect(state.world, 'refinery', 'oilPerDay', 0) * power(state, pid, 'refinery');
  return out;
}

/** Multiplicateur de revenu d'une province : moral et industrie locale. */
export function provinceIncomeFactor(state: EngineState, pid: ProvinceId): number {
  if (!eco(state).live) return 1;
  const m = cfg(state.world).morale;
  const morale = Math.min(1, m.incomeFloor + moraleOf(state, pid) / 100);
  const ind =
    1 +
    effect(state.world, 'local_industry', 'incomePerLevel', 0) *
      power(state, pid, 'local_industry');
  return morale * ind;
}

/** Vitesse des chantiers d'une province (industrie locale). */
function constructionSpeed(state: EngineState, pid: ProvinceId): number {
  return (
    1 +
    effect(state.world, 'local_industry', 'buildSpeedPerLevel', 0) *
      power(state, pid, 'local_industry')
  );
}

/** Blindage des unités terrestres qui défendent une province à bunkers (× niveau × santé). */
export function bunkerArmor(state: EngineState, pid: ProvinceId): number {
  const p = power(state, pid, 'bunker');
  return p > 0 ? 1 + effect(state.world, 'bunker', 'armorPerLevel', 0) * p : 1;
}

/** Dépôts avancés (bases avancées) d'une nation. */
export function depotsOf(
  state: EngineState,
  n: NationId,
): { pid: ProvinceId; rangeKm: number; at: [number, number] }[] {
  const out: { pid: ProvinceId; rangeKm: number; at: [number, number] }[] = [];
  const w = wi(state.world);
  const r0 = effect(state.world, 'forward_base', 'rangeKm', 0);
  const per = effect(state.world, 'forward_base', 'rangePerLevel', 0);
  for (const pid of provincesOf(state, n)) {
    const h = health(state, pid, 'forward_base');
    if (h <= 0) continue;
    const lvl = levelOf(state, pid, 'forward_base');
    out.push({ pid, rangeKm: r0 * (1 + per * (lvl - 1)) * h, at: w.provById.get(pid)!.cityPoint });
  }
  return out;
}

// ——— Ordres : construire, améliorer, réparer ———

export function buildOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'build' }>,
): OrderResult {
  const es = eco(state);
  const P = state.provinces[order.provinceId];
  if (!P) return fail('invalid_target', 'Province inconnue.');
  if (P.owner !== n) return fail('not_owner');
  const kind = order.building;
  const pid = order.provinceId;
  for (const id of sortedIds(es.jobs)) {
    const j = es.jobs[id]!;
    if (j.pid === pid && j.kind === kind) return fail('not_allowed', 'Chantier déjà en cours.');
  }
  const c = cfg(state.world).buildings;
  let lvl: number;
  if (BUILDING_SET.has(kind)) {
    const cur = levelOf(state, pid, kind);
    if (cur >= c.maxLevel) return fail('capacity', 'Niveau maximal atteint.');
    if (cur > 0 && health(state, pid, kind) < 1)
      return fail('not_allowed', 'Réparer avant d’améliorer.');
    lvl = cur + 1;
  } else if (kind === 'fortification') {
    const max = effect(state.world, 'fortification', 'maxLevel', 3);
    lvl = (es.forts[pid] ?? 0) + 1;
    if (lvl > max) return fail('capacity', 'Fortification maximale.');
  } else return fail('invalid_target');
  const cost = (c.buildCostUsd[kind] ?? 0) * Math.pow(c.levelCostGrowth, lvl - 1);
  const hours =
    ((c.buildHours[kind] ?? 24) * (1 + c.levelTimeGrowth * (lvl - 1))) /
    constructionSpeed(state, pid);
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds');
  ns.money -= cost;
  const en = es.nations[n];
  if (en) en.spent += cost;
  book(state, n, 'buildings', -cost);
  const id = `k${++es.seq}`;
  const t = state.time + hours * HOUR;
  es.jobs[id] = { id, n, pid, kind, startedAt: state.time, completesAt: t, paid: cost, v: 1, lvl };
  scheduleMod(state, { t, m: 'eco', e: 'job', d: { id, v: 1 } });
  return { ok: true };
}

export function onJobDone(state: EngineState, d: { id: string; v: number }): void {
  const es = eco(state);
  const j = es.jobs[d.id];
  if (!j || j.v !== d.v) return;
  delete es.jobs[d.id];
  if (state.provinces[j.pid]?.owner !== j.n) return;
  if (BUILDING_SET.has(j.kind)) {
    const s = bstate(state, j.pid, j.kind);
    if (
      !baseBuildings(state.world)
        .get(j.pid)
        ?.has(j.kind as BuildingType)
    )
      s.add = true;
    s.lvl = j.lvl;
    if (j.lvl === 1) s.h = 1;
    tidy(state, j.pid, j.kind);
    syncSite(state, j.pid, j.kind);
  } else if (j.kind === 'fortification') {
    es.forts[j.pid] = Math.max(es.forts[j.pid] ?? 0, j.lvl);
  }
}

export function repairOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'repair' }>,
): OrderResult {
  const pid = order.provinceId;
  const P = state.provinces[pid];
  if (!P) return fail('invalid_target', 'Province inconnue.');
  if (P.owner !== n) return fail('not_owner');
  if (!hasBuilding(state, pid, order.building)) return fail('invalid_target', 'Bâtiment absent.');
  const h = health(state, pid, order.building);
  if (h >= 1) return fail('not_allowed', 'Bâtiment intact.');
  const s = bstate(state, pid, order.building);
  if (s.rep !== null) return fail('not_allowed', 'Réparation déjà en cours.');
  const c = cfg(state.world);
  const lvl = levelOf(state, pid, order.building);
  const cost =
    (c.buildings.buildCostUsd[order.building] ?? 0) *
    Math.pow(c.buildings.levelCostGrowth, lvl - 1) *
    (1 - h) *
    c.industry.repairCostFactor;
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds');
  ns.money -= cost;
  const en = eco(state).nations[n];
  if (en) en.spent += cost;
  book(state, n, 'buildings', -cost);
  s.rv++;
  s.rep = state.time + c.buildings.repairHours * (1 - h) * HOUR;
  scheduleMod(state, { t: s.rep, m: 'eco', e: 'rep', d: { pid, b: order.building, v: s.rv } });
  return { ok: true };
}

export function onRepairDone(state: EngineState, d: { pid: string; b: string; v: number }): void {
  const s = eco(state).bld[d.pid]?.[d.b];
  if (!s || s.rv !== d.v || s.rep === null) return;
  s.h = 1;
  s.rep = null;
  tidy(state, d.pid, d.b);
  syncSite(state, d.pid, d.b);
}

/** Accélère une réparation (id = "<province>:<bâtiment>"). */
export function accelerateRepair(state: EngineState, id: string, ms: number): boolean {
  const i = id.lastIndexOf(':');
  if (i < 0) return false;
  const pid = id.slice(0, i);
  const b = id.slice(i + 1);
  const s = eco(state).bld[pid]?.[b];
  if (!s || s.rep === null) return false;
  s.rv++;
  s.rep = Math.max(state.time, s.rep - ms);
  scheduleMod(state, { t: s.rep, m: 'eco', e: 'rep', d: { pid, b, v: s.rv } });
  return true;
}

export function accelerateJob(state: EngineState, id: string, ms: number): boolean {
  const j = eco(state).jobs[id];
  if (!j) return false;
  j.v++;
  j.completesAt = Math.max(state.time, j.completesAt - ms);
  scheduleMod(state, { t: j.completesAt, m: 'eco', e: 'job', d: { id, v: j.v } });
  return true;
}

/** Changement de propriétaire : chantiers perdus, réparations interrompues, sites réattribués. */
export function buildingsOnCapture(state: EngineState, pid: ProvinceId): void {
  const es = eco(state);
  for (const id of sortedIds(es.jobs)) if (es.jobs[id]!.pid === pid) delete es.jobs[id];
  const m = es.bld[pid];
  if (m) {
    for (const b of sortedIds(m)) {
      const s = m[b]!;
      if (s.rep !== null) {
        s.rep = null;
        s.rv++;
      }
      tidy(state, pid, b);
    }
  }
  syncSites(state, pid);
}
