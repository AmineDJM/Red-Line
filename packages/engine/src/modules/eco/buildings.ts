import {
  BUILDING_TYPES,
  HOUR,
  type BuildingType,
  type NationId,
  type Order,
  type ProvinceId,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { notify, provincesOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { scheduleMod } from '../kit.js';
import { cfg, effect } from './config.js';
import { eco, ecoNation, nextId, sortedIds, type BState } from './state.js';
import { fail } from './util.js';

const BUILDING_SET = new Set<string>(BUILDING_TYPES);

/** Bâtiments présents dans une province (carte + construits en cours de partie), triés. */
export function buildingsOf(state: EngineState, pid: ProvinceId): BuildingType[] {
  const def = wi(state.world).provById.get(pid);
  const base = def?.buildings ?? [];
  const extra = eco(state).bld[pid];
  if (!extra) return [...base].sort();
  const out = new Set<BuildingType>(base);
  for (const b of sortedIds(extra)) if (extra[b]!.add) out.add(b as BuildingType);
  return [...out].sort();
}

export function hasBuilding(state: EngineState, pid: ProvinceId, b: string): boolean {
  const def = wi(state.world).provById.get(pid);
  if (def?.buildings.includes(b as BuildingType)) return true;
  return !!eco(state).bld[pid]?.[b]?.add;
}

/** Santé 0..1 d'un bâtiment (0 s'il est absent). */
export function health(state: EngineState, pid: ProvinceId, b: string): number {
  if (!hasBuilding(state, pid, b)) return 0;
  return eco(state).bld[pid]?.[b]?.h ?? 1;
}

function bstate(state: EngineState, pid: ProvinceId, b: string): BState {
  const es = eco(state);
  const m = (es.bld[pid] ??= {});
  return (m[b] ??= { h: 1, rep: null, rv: 0 });
}

/** Retire l'entrée si elle est revenue au défaut (économie de place, état canonique). */
function tidy(state: EngineState, pid: ProvinceId, b: string): void {
  const es = eco(state);
  const m = es.bld[pid];
  const s = m?.[b];
  if (!m || !s) return;
  if (s.h >= 1 && s.rep === null && !s.add) delete m[b];
  if (Object.keys(m).length === 0) delete es.bld[pid];
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
  s.h = Math.max(0, s.h - Math.min(1, damage));
  if (s.rep !== null) {
    s.rep = null;
    s.rv++;
  }
  tidy(state, pid, b);
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

/** Explosion nucléaire : bâtiments de la province détruits, voisins à moitié. */
export function nuclearDamage(state: EngineState, pid: ProvinceId, by: NationId | null): void {
  const def = wi(state.world).provById.get(pid);
  if (!def || !state.provinces[pid]) return;
  for (const b of buildingsOf(state, pid)) damageBuilding(state, pid, b, 1, by);
  for (const q of [...def.neighbors].sort()) {
    if (!state.provinces[q]) continue;
    for (const b of buildingsOf(state, q)) damageBuilding(state, q, b, 0.5, by);
  }
}

// ——— Effets ———

/**
 * Bonus d'une centrale électrique pour une province : meilleure centrale de la province ou d'une
 * province voisine de la même nation, `1 + (effet − 1) × santé`.
 */
function plantBoost(state: EngineState, pid: ProvinceId, key: string): number {
  const P = state.provinces[pid];
  if (!P) return 1;
  const def = wi(state.world).provById.get(pid)!;
  const e = effect(state.world, 'power_plant', key, 1);
  let best = 1;
  for (const q of [pid, ...def.neighbors]) {
    if (state.provinces[q]?.owner !== P.owner) continue;
    const h = health(state, q, 'power_plant');
    if (h > 0) best = Math.max(best, 1 + (e - 1) * h);
  }
  return best;
}

/** Vitesse de production d'une province pour un bâtiment requis (1 = nominale). */
export function provinceProductionSpeed(state: EngineState, pid: ProvinceId, b: string): number {
  const h = health(state, pid, b);
  const base = effect(state.world, b, 'productionSpeed', 1);
  return base * (0.5 + 0.5 * h) * plantBoost(state, pid, 'productionSpeed');
}

/** Facteur de vitesse de recherche dû aux centres de recherche (et centrales voisines). */
export function researchBuildingFactor(state: EngineState, n: NationId): number {
  const per = effect(state.world, 'research_center', 'researchSpeed', 0);
  const cap = effect(state.world, 'research_center', 'researchSpeedCap', 1);
  let sum = 0;
  for (const pid of provincesOf(state, n)) {
    const h = health(state, pid, 'research_center');
    if (h > 0) sum += per * h * plantBoost(state, pid, 'researchSpeed');
  }
  return 1 + Math.min(cap, sum);
}

/** Pétrole des raffineries possédées (par jour). */
export function refineryOil(state: EngineState, n: NationId): number {
  const per = effect(state.world, 'refinery', 'oilPerDay', 0);
  let sum = 0;
  for (const pid of provincesOf(state, n)) sum += per * health(state, pid, 'refinery');
  return sum;
}

// ——— Ordres : construire, réparer ———

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
    if (j.pid === pid && j.kind === kind) return fail('not_allowed', 'Construction déjà en cours.');
  }
  if (BUILDING_SET.has(kind)) {
    if (hasBuilding(state, pid, kind)) return fail('not_allowed', 'Bâtiment déjà présent.');
  } else if (kind === 'fortification') {
    const max = effect(state.world, 'fortification', 'maxLevel', 3);
    if ((es.forts[pid] ?? 0) >= max) return fail('capacity', 'Fortification maximale.');
  } else if (kind === 'forward_base') {
    for (const id of sortedIds(es.depots))
      if (es.depots[id]!.pid === pid) return fail('not_allowed', 'Dépôt déjà présent.');
  } else return fail('invalid_target');
  const c = cfg(state.world).buildings;
  const cost = c.buildCostUsd[kind] ?? 0;
  const hours = c.buildHours[kind] ?? 24;
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds');
  ns.money -= cost;
  ecoNation(state, n).spent += cost;
  const id = nextId(state, 'k');
  const t = state.time + hours * HOUR;
  es.jobs[id] = { id, n, pid, kind, startedAt: state.time, completesAt: t, paid: cost, v: 1 };
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
    s.add = true;
    s.h = 1;
  } else if (j.kind === 'fortification') {
    es.forts[j.pid] = (es.forts[j.pid] ?? 0) + 1;
  } else if (j.kind === 'forward_base') {
    const id = nextId(state, 'd');
    es.depots[id] = {
      id,
      n: j.n,
      pid: j.pid,
      at: wi(state.world).provById.get(j.pid)!.cityPoint,
      rangeKm: effect(state.world, 'forward_base', 'rangeKm', 400),
    };
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
  const cost =
    (c.buildings.buildCostUsd[order.building] ?? 0) * (1 - h) * c.industry.repairCostFactor;
  const ns = state.nations[n]!;
  if (ns.money < cost) return fail('insufficient_funds');
  ns.money -= cost;
  ecoNation(state, n).spent += cost;
  s.rv++;
  s.rep = state.time + c.buildings.repairHours * (1 - h) * HOUR;
  scheduleMod(state, {
    t: s.rep,
    m: 'eco',
    e: 'rep',
    d: { pid, b: order.building, v: s.rv },
  });
  return { ok: true };
}

export function onRepairDone(state: EngineState, d: { pid: string; b: string; v: number }): void {
  const s = eco(state).bld[d.pid]?.[d.b];
  if (!s || s.rv !== d.v || s.rep === null) return;
  s.h = 1;
  s.rep = null;
  tidy(state, d.pid, d.b);
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

/** Changement de propriétaire : chantiers et dépôts perdus, réparations interrompues. */
export function buildingsOnCapture(state: EngineState, pid: ProvinceId): void {
  const es = eco(state);
  for (const id of sortedIds(es.jobs)) if (es.jobs[id]!.pid === pid) delete es.jobs[id];
  for (const id of sortedIds(es.depots)) if (es.depots[id]!.pid === pid) delete es.depots[id];
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
}
