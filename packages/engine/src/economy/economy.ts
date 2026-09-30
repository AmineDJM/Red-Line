import {
  DAY,
  HOUR,
  MINUTE,
  RESOURCES,
  type NationId,
  type OrderErrorCode,
  type ProvinceId,
  type Resource,
  type WeaponSystem,
} from '@redline/shared';
import { notify, schedule, sortedKeys, sortedSet, sysOf } from '../state/access.js';
import type { EngineState } from '../state/types.js';
import { wi } from '../state/world.js';
import { spawnUnit } from '../state/units.js';
import type { GameEvent } from '../queue/events.js';

export interface DailyIncome {
  money: number;
  res: Record<Resource, number>;
  upkeep: number;
}

export function emptyResources(): Record<Resource, number> {
  const r = {} as Record<Resource, number>;
  for (const k of RESOURCES) r[k] = 0;
  return r;
}

/** Revenus bruts journaliers des provinces possédées (× incomeMultiplier) et entretien des unités. */
export function dailyIncomeAll(state: EngineState): Map<NationId, DailyIncome> {
  const mult = state.world.balance.economy.incomeMultiplier;
  const w = wi(state.world);
  const out = new Map<NationId, DailyIncome>();
  for (const n of state.nationIds) out.set(n, { money: 0, res: emptyResources(), upkeep: 0 });
  for (const pid of sortedKeys(state.provinces)) {
    const inc = out.get(state.provinces[pid]!.owner);
    if (!inc) continue;
    const def = w.provById.get(pid)!;
    inc.money += def.income.money * mult;
    for (const r of RESOURCES) inc.res[r] += (def.income[r] ?? 0) * mult;
  }
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    const inc = out.get(u.owner);
    if (inc) inc.upkeep += sysOf(state, u).upkeepPerDay;
  }
  return out;
}

export function dailyIncomeOf(state: EngineState, n: NationId): DailyIncome {
  const mult = state.world.balance.economy.incomeMultiplier;
  const w = wi(state.world);
  const inc: DailyIncome = { money: 0, res: emptyResources(), upkeep: 0 };
  for (const pid of w.provIds) {
    const P = state.provinces[pid];
    if (!P || P.owner !== n) continue;
    const def = w.provById.get(pid)!;
    inc.money += def.income.money * mult;
    for (const r of RESOURCES) inc.res[r] += (def.income[r] ?? 0) * mult;
  }
  for (const uid of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[uid];
    if (u) inc.upkeep += sysOf(state, u).upkeepPerDay;
  }
  return inc;
}

/** Tick journalier : revenus − entretien, puis oubli des contacts trop anciens. */
export function handleDailyTick(state: EngineState): void {
  const all = dailyIncomeAll(state);
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive) continue;
    const inc = all.get(n)!;
    ns.money += inc.money - inc.upkeep;
    for (const r of RESOURCES) ns.res[r] += inc.res[r];
  }
  const forgetMs = state.world.balance.sensors.forgetAfterMinutes * MINUTE;
  for (const n of sortedKeys(state.know)) {
    const k = state.know[n]!;
    for (const uid of sortedKeys(k)) {
      const c = k[uid]!;
      if (!c.seen && state.time - c.lastSeen > forgetMs) delete k[uid];
    }
    if (Object.keys(k).length === 0) delete state.know[n];
  }
  schedule(state, { k: 'day', t: state.time + DAY });
}

export function canAfford(state: EngineState, n: NationId, sys: WeaponSystem): boolean {
  const ns = state.nations[n]!;
  if (ns.money < sys.cost.money) return false;
  for (const r of RESOURCES) if ((sys.cost.resources[r] ?? 0) > ns.res[r]) return false;
  return true;
}

/** Ordre 'produce' : débite le coût et programme la fin de production. */
export function startProduction(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  systemId: string,
): OrderErrorCode | null {
  const P = state.provinces[pid];
  if (!P) return 'invalid_target';
  if (P.owner !== n) return 'not_owner';
  const sys = state.world.catalog.get(systemId);
  if (!sys || !sys.enabled) return 'invalid_target';
  if (sys.movement === 'sea' && !wi(state.world).seaSpawn.get(pid)) return 'not_allowed';
  if (!canAfford(state, n, sys)) return 'insufficient_funds';
  const ns = state.nations[n]!;
  ns.money -= sys.cost.money;
  for (const r of RESOURCES) ns.res[r] -= sys.cost.resources[r] ?? 0;
  const id = `b${++state.nextProd}`;
  const item = {
    id,
    provinceId: pid,
    systemId,
    startedAt: state.time,
    completesAt: state.time + sys.buildTimeH * HOUR,
  };
  ns.production.push(item);
  schedule(state, { k: 'prod', t: item.completesAt, n, id });
  return null;
}

export function handleProductionComplete(
  state: EngineState,
  ev: Extract<GameEvent, { k: 'prod' }>,
): void {
  const ns = state.nations[ev.n]!;
  const idx = ns.production.findIndex((it) => it.id === ev.id);
  const item = ns.production[idx]!;
  ns.production.splice(idx, 1);
  const P = state.provinces[item.provinceId];
  if (!P || P.owner !== ev.n) return;
  const sys = state.world.catalog.get(item.systemId)!;
  const w = wi(state.world);
  const pos =
    sys.movement === 'sea'
      ? w.seaSpawn.get(item.provinceId)
      : w.provById.get(item.provinceId)!.cityPoint;
  if (!pos) return;
  const u = spawnUnit(state, ev.n, item.systemId, pos);
  notify(
    state,
    { kind: 'production_complete', time: state.time, at: pos, unitId: u.id, systemId: u.sys },
    [ev.n],
  );
}
