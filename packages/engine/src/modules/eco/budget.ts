import {
  DAY,
  RESOURCES,
  destination,
  type NationId,
  type Order,
  type ProvinceId,
  type Resource,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { provincesOf, sortedSet, sysOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier, signal } from '../registry.js';
import type { ModuleIncome } from '../types.js';
import { health, refineryOil } from './buildings.js';
import { cfg } from './config.js';
import { eco, ecoNation, ecoRt, orbatOf } from './state.js';
import { eraOk, fail } from './util.js';

/** Budget de défense journalier d'une nation (dollars), 0 sans ORBAT. */
export function budgetDay(state: EngineState, n: NationId): number {
  const o = orbatOf(state, n);
  if (!o) return 0;
  const m = cfg(state.world).money;
  return o.defenseBudgetUsd * m.budgetPerDayFraction * m.budgetMultiplier;
}

/**
 * Revenu journalier en argent de chaque province, figé pour la partie : part provinciale du budget de
 * son propriétaire d'origine, au prorata de `income.money` (dollars) ; sans ORBAT, ancien calcul
 * (`income.money × incomeMultiplier`).
 */
export function provValues(state: EngineState): Map<ProvinceId, number> {
  const rt = ecoRt(state);
  if (rt.provValue) return rt.provValue;
  const w = wi(state.world);
  const share = cfg(state.world).money.provinceShare;
  const mult = state.world.balance.economy.incomeMultiplier;
  const out = new Map<ProvinceId, number>();
  for (const n of state.nationIds) {
    const provs = (w.provsByNation.get(n) ?? []).filter((p) => state.provinces[p]);
    if (provs.length === 0) continue;
    const bd = budgetDay(state, n);
    if (orbatOf(state, n)) {
      let total = 0;
      for (const p of provs) total += w.provById.get(p)!.income.money;
      for (const p of provs) {
        const f = total > 0 ? w.provById.get(p)!.income.money / total : 1 / provs.length;
        out.set(p, bd * share * f);
      }
    } else {
      for (const p of provs) out.set(p, w.provById.get(p)!.income.money * mult);
    }
  }
  rt.provValue = out;
  return out;
}

/** Part des ports de la nation qui ne sont pas sous blocus (1 sans port). */
function openPortShare(state: EngineState, n: NationId): number {
  const es = eco(state);
  let ports = 0;
  let open = 0;
  for (const pid of provincesOf(state, n)) {
    if (health(state, pid, 'port') <= 0) continue;
    ports++;
    if (!es.blockaded[pid]) open++;
  }
  return ports === 0 ? 1 : open / ports;
}

/** Revenus en dollars (économie réelle) ; null hors économie réelle (calcul du cœur). */
export function ecoIncome(state: EngineState, n: NationId): ModuleIncome | null {
  const es = eco(state);
  if (!es.live) return null;
  const c = cfg(state.world);
  const w = wi(state.world);
  const vals = provValues(state);
  const provs = provincesOf(state, n);
  let money = 0;
  for (const p of provs) money += vals.get(p) ?? 0;
  if (orbatOf(state, n)) money += budgetDay(state, n) * (1 - c.money.provinceShare);
  const sanction = board(state).sanctions[n] ?? 1;
  const trade = c.money.tradeShare;
  money *= 1 - trade + trade * sanction * openPortShare(state, n);
  if (board(state).mobilized[n]) money *= 1 - c.mobilization.incomePenalty;
  money *= modifier(state, n, 'income.money');

  const mult = state.world.balance.economy.incomeMultiplier;
  const res = {} as Record<Resource, number>;
  for (const r of RESOURCES) res[r] = 0;
  for (const p of provs) {
    const def = w.provById.get(p)!;
    for (const r of RESOURCES) res[r] += (def.income[r] ?? 0) * mult;
  }
  res.oil += refineryOil(state, n);
  for (const r of RESOURCES) res[r] *= modifier(state, n, `income.${r}`);

  let upkeep = 0;
  for (const uid of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[uid];
    if (u) upkeep += sysOf(state, u).upkeepPerDay * u.count;
  }
  upkeep *= modifier(state, n, 'upkeep');
  return { money, res, upkeep };
}

/** Argent de départ : `startingDays` jours de budget (nations dotées d'un ORBAT). */
export function startingMoney(state: EngineState, n: NationId): number | null {
  if (!orbatOf(state, n)) return null;
  return budgetDay(state, n) * cfg(state.world).money.startingDays;
}

// ——— Mobilisation générale ———

/** Système d'infanterie de mobilisation : celui de l'ORBAT, sinon le moins cher du catalogue. */
function mobilizationInfantry(state: EngineState, n: NationId): string | null {
  const year = eco(state).year;
  const o = orbatOf(state, n);
  if (o) {
    const ids = o.inventory
      .map((i) => i.systemId)
      .filter((id) => state.world.catalog.get(id)?.category === 'infantry')
      .sort();
    if (ids.length > 0) return ids[0]!;
  }
  let best: string | null = null;
  let bestCost = Infinity;
  for (const id of wi(state.world).systemIds) {
    const s = state.world.catalog.get(id)!;
    if (s.category !== 'infantry' || !s.enabled || !eraOk(s, year)) continue;
    if (s.cost.money < bestCost) {
      bestCost = s.cost.money;
      best = id;
    }
  }
  return best;
}

export function mobilizeOrder(
  state: EngineState,
  n: NationId,
  order: Extract<Order, { kind: 'mobilize' }>,
): OrderResult {
  const b = board(state);
  const en = ecoNation(state, n);
  const c = cfg(state.world).mobilization;
  if (order.on) {
    if (b.mobilized[n]) return fail('not_allowed', 'Déjà mobilisée.');
    if (!state.nations[n]!.alive) return fail('not_allowed');
    b.mobilized[n] = true;
    en.mobSince = state.time;
    const sysId = mobilizationInfantry(state, n);
    if (sysId && c.infantryPerProvince > 0) {
      const w = wi(state.world);
      const gc = state.world.balance.combat.groundContactKm;
      for (const pid of provincesOf(state, n)) {
        const city = w.provById.get(pid)!.cityPoint;
        for (let k = 0; k < c.infantryPerProvince; k++) {
          let pos = city;
          const cand = destination(city, (k * 137.508 + 60) % 360, gc * 0.4);
          if (w.nav.cellProv.get(w.nav.cellAt(cand)) === pid) pos = cand;
          spawnUnit(state, n, sysId, pos);
        }
      }
    }
    signal(state, 'stability', { nation: n, delta: c.stabilityPerDay, reason: 'mobilization' });
    return { ok: true };
  }
  if (!b.mobilized[n]) return fail('not_allowed', 'Pas de mobilisation en cours.');
  if (en.mobSince !== null && state.time - en.mobSince < c.minDays * DAY) return fail('cooldown');
  delete b.mobilized[n];
  en.mobSince = null;
  return { ok: true };
}

/** Coût quotidien de la mobilisation en stabilité. */
export function mobilizationDaily(state: EngineState): void {
  const b = board(state);
  const delta = cfg(state.world).mobilization.stabilityPerDay;
  for (const n of Object.keys(b.mobilized).sort()) {
    if (!state.nations[n]?.alive) continue;
    signal(state, 'stability', { nation: n, delta, reason: 'mobilization' });
  }
}
