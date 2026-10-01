import {
  DAY,
  RESOURCES,
  destination,
  type NationId,
  type Order,
  type ProvinceId,
  type Resource,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { provincesOf, sortedSet, sysOf } from '../../state/access.js';
import { partsOf } from '../../state/stack.js';
import type { EngineState } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier, signal } from '../registry.js';
import type { ModuleIncome } from '../types.js';
import { health, power, provinceIncomeFactor, provinceResources } from './buildings.js';
import { cfg, effect } from './config.js';
import { eco, ecoNation, ecoRt, orbatOf } from './state.js';
import { budgetDay, upkeepFactor } from './upkeep.js';
import { eraOk, fail } from './util.js';

export { budgetDay };

/**
 * Revenu journalier en argent de chaque province, figé pour la partie : part provinciale du budget de
 * son propriétaire d'origine, au prorata de `income.money` (dollars) ; sans ORBAT, ancien calcul
 * (`income.money × incomeMultiplier`). Le moral et l'industrie locale s'appliquent par-dessus.
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

/** Revenu en dollars par jour d'une province pour son propriétaire actuel. */
export function provinceIncome(state: EngineState, pid: ProvinceId): number {
  return (provValues(state).get(pid) ?? 0) * provinceIncomeFactor(state, pid);
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

/** Ressource consommée par jour et par élément d'un système (null : aucune). */
function consumptionOf(state: EngineState, sys: WeaponSystem): [Resource, number] | null {
  const c = cfg(state.world).consumption;
  if (sys.category === 'infantry') return ['food', c.foodPerInfantry];
  if (sys.category === 'space') return ['electronics', c.electronicsPerSpace];
  if (sys.movement === 'sea') return ['oil', c.oilPerShip];
  if (sys.movement === 'air') return ['oil', c.oilPerAircraft];
  if (sys.movement === 'land') return ['oil', c.oilPerVehicle];
  return null;
}

export interface Breakdown {
  national: number;
  provincial: number;
  trade: number;
  mobilization: number;
  modifiers: number;
  total: number;
  production: Record<Resource, number>;
  consumption: Record<Resource, number>;
  upkeep: Record<string, number>;
  upkeepTotal: number;
  /** Entretien au prix catalogue (sans âge, coût local ni facteur national ; modificateurs compris). */
  upkeepCatalog: number;
}

/** Revenus, ressources et entretien prévus par jour, poste par poste (économie réelle). */
export function breakdown(state: EngineState, n: NationId): Breakdown {
  const c = cfg(state.world);
  const provs = provincesOf(state, n);
  let provincial = 0;
  for (const p of provs) provincial += provinceIncome(state, p);
  const national = orbatOf(state, n) ? budgetDay(state, n) * (1 - c.money.provinceShare) : 0;
  const gross = national + provincial;
  const sanction = board(state).sanctions[n] ?? 1;
  const t = c.money.tradeShare;
  const tradeF = 1 - t + t * sanction * openPortShare(state, n);
  const afterTrade = gross * tradeF;
  const mobilization = board(state).mobilized[n] ? -afterTrade * c.mobilization.incomePenalty : 0;
  const afterMob = afterTrade + mobilization;
  const mod = modifier(state, n, 'income.money');

  const production = {} as Record<Resource, number>;
  const consumption = {} as Record<Resource, number>;
  for (const r of RESOURCES) {
    production[r] = 0;
    consumption[r] = 0;
  }
  for (const p of provs) {
    const y = provinceResources(state, p);
    for (const r of RESOURCES) production[r] += y[r];
  }
  for (const r of RESOURCES) production[r] *= modifier(state, n, `income.${r}`);

  const upkeep: Record<string, number> = {};
  let upkeepTotal = 0;
  let upkeepCatalog = 0;
  const upMod = modifier(state, n, 'upkeep');
  for (const uid of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[uid];
    if (!u) continue;
    // Pile mixte : entretien et consommation de chacun de ses matériels (state/stack.ts).
    for (const p of u.mix ? partsOf(state, u) : [{ sys: sysOf(state, u), c: u.count }]) {
      const sys = p.sys;
      const cat = sys.upkeepPerDay * p.c * upMod;
      const v = cat * upkeepFactor(state, n, sys);
      upkeepCatalog += cat;
      if (v !== 0) {
        upkeep[sys.category] = (upkeep[sys.category] ?? 0) + v;
        upkeepTotal += v;
      }
      const cons = consumptionOf(state, sys);
      if (cons) consumption[cons[0]] += cons[1] * p.c;
    }
  }
  return {
    national,
    provincial,
    trade: gross * (tradeF - 1),
    mobilization,
    modifiers: afterMob * (mod - 1),
    total: afterMob * mod,
    production,
    consumption,
    upkeep,
    upkeepTotal,
    upkeepCatalog,
  };
}

/** Revenus en dollars (économie réelle) ; null hors économie réelle (calcul du cœur). */
export function ecoIncome(state: EngineState, n: NationId): ModuleIncome | null {
  if (!eco(state).live) return null;
  const b = breakdown(state, n);
  const res = {} as Record<Resource, number>;
  for (const r of RESOURCES) res[r] = b.production[r] - b.consumption[r];
  return { money: b.total, res, upkeep: b.upkeepTotal };
}

/** Argent de départ : `startingDays` jours de budget (nations dotées d'un ORBAT). */
export function startingMoney(state: EngineState, n: NationId): number | null {
  if (!orbatOf(state, n)) return null;
  return budgetDay(state, n) * cfg(state.world).money.startingDays;
}

/**
 * Tick journalier du module (après le versement du cœur) : grand livre, pénuries, moral.
 * Les revenus versés par le cœur sont ceux de `breakdown` (même état, même calcul).
 */
export function economyDaily(state: EngineState): void {
  const es = eco(state);
  if (!es.live) return;
  const c = cfg(state.world);
  const w = wi(state.world);
  const foodShort = new Set<NationId>();
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    const en = ecoNation(state, n);
    if (ns.alive) {
      const b = breakdown(state, n);
      const today = en.today;
      const add = (k: string, v: number) => {
        if (v !== 0) today[k] = (today[k] ?? 0) + v;
      };
      add('budgetNational', b.national);
      add('budgetProvincial', b.provincial);
      add('trade', b.trade);
      add('mobilization', b.mobilization);
      add('modifiers', b.modifiers);
      add('upkeep', -b.upkeepTotal);
      for (const r of RESOURCES) {
        if (ns.res[r] < 0) ns.res[r] = 0;
        if (ns.res[r] <= 0 && b.consumption[r] > b.production[r]) en.short[r] = true;
        else delete en.short[r];
      }
      if (en.short.food) foodShort.add(n);
    }
    let known = 0;
    for (const k of Object.keys(en.today)) known += en.today[k]!;
    const other = ns.money - en.lastMoney - known;
    en.lastDay = { ...en.today };
    // Nation illimitée : la remise à niveau de la réserve n'est pas un flux du grand livre.
    if (!state.unl?.[n] && Math.abs(other) > Math.max(1e-3, 1e-12 * Math.abs(ns.money))) {
      en.lastDay.other = other;
    }
    en.today = {};
    en.lastMoney = ns.money;
  }
  // Moral : retour vers la cible (départ, ou « occupée »), pénurie de nourriture.
  for (const pid of Object.keys(state.provinces).sort()) {
    const P = state.provinces[pid]!;
    const original = w.provById.get(pid)!.nationId === P.owner;
    const target = original ? c.morale.start : c.morale.occupied;
    let m = es.morale[pid] ?? c.morale.start;
    if (m < target) m = Math.min(target, m + c.morale.recoveryPerDay);
    else if (m > target) m = Math.max(target, m - c.morale.recoveryPerDay);
    if (foodShort.has(P.owner)) m -= c.morale.shortagePenalty;
    m = Math.max(0, Math.min(100, m));
    if (m === c.morale.start) delete es.morale[pid];
    else es.morale[pid] = m;
  }
}

/** Province conquise : moral d'occupation (sauf libération). */
export function moraleOnCapture(state: EngineState, pid: ProvinceId, to: NationId): void {
  const es = eco(state);
  if (!es.live) return;
  const c = cfg(state.world).morale;
  const original = wi(state.world).provById.get(pid)!.nationId === to;
  if (!original) {
    if (c.occupied === c.start) delete es.morale[pid];
    else es.morale[pid] = Math.min(es.morale[pid] ?? c.start, c.occupied);
  }
}

/** Soins quotidiens : hôpitaux (unités à l'arrêt dans la province) et bases navales (navires au port). */
export function healDaily(state: EngineState): void {
  if (!eco(state).live) return;
  const w = wi(state.world);
  const hosp = effect(state.world, 'hospital', 'healPerLevel', 0);
  const naval = effect(state.world, 'naval_base', 'healPerLevel', 0);
  if (hosp <= 0 && naval <= 0) return;
  for (const n of state.nationIds) {
    const navalPorts: { pt: [number, number]; p: number }[] = [];
    if (naval > 0)
      for (const pid of provincesOf(state, n)) {
        const p = power(state, pid, 'naval_base');
        const pt = w.seaSpawn.get(pid);
        if (p > 0 && pt) navalPorts.push({ pt, p });
      }
    for (const uid of sortedSet(state.rt.byNation.get(n))) {
      const u = state.units[uid]!;
      if (u.move || u.engaged) continue;
      const sys = sysOf(state, u);
      const cap = Math.min(u.maxHp, u.count * sys.hp);
      if (u.hp >= cap) continue;
      let rate = 0;
      if (sys.movement === 'sea') {
        for (const x of navalPorts)
          if (Math.abs(x.pt[0] - u.pos[0]) < 0.5 && Math.abs(x.pt[1] - u.pos[1]) < 0.5)
            rate = Math.max(rate, naval * x.p);
      } else {
        const pid = w.nav.cellProv.get(w.nav.cellOfPos(u.pos));
        if (pid && state.provinces[pid]?.owner === n) rate = hosp * power(state, pid, 'hospital');
      }
      if (rate > 0) u.hp = Math.min(cap, u.hp + rate * u.count * sys.hp);
    }
  }
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
    b.mobilized[n] = true;
    en.mobSince = state.time;
    const sysId = mobilizationInfantry(state, n);
    if (sysId) {
      const w = wi(state.world);
      const gc = state.world.balance.combat.groundContactKm;
      const perOffice = effect(state.world, 'recruiting_office', 'mobilizationPerLevel', 0);
      for (const pid of provincesOf(state, n)) {
        const city = w.provById.get(pid)!.cityPoint;
        const k =
          c.infantryPerProvince + Math.floor(perOffice * power(state, pid, 'recruiting_office'));
        for (let i = 0; i < k; i++) {
          let pos = city;
          const cand = destination(city, (i * 137.508 + 60) % 360, gc * 0.4);
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
