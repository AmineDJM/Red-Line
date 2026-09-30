import {
  distanceKm,
  type LngLat,
  type NationId,
  type SupplyState,
} from '@redline/shared';
import { provincesOf, sortedSet, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier } from '../registry.js';
import { health } from './buildings.js';
import { cfg, effect } from './config.js';
import { eco, sortedIds } from './state.js';

/** Nations amies (elle-même et les membres de son alliance), triées. */
function friendsOf(state: EngineState, n: NationId): NationId[] {
  const b = board(state);
  const a = b.allianceOf[n];
  if (!a) return [n];
  return state.nationIds.filter((m) => m === n || b.allianceOf[m] === a);
}

/**
 * Ravitaillement d'une unité terrestre : ravitaillée en territoire ami, ou à moins de
 * `supplyRangeKm` (× modificateur supply.range) d'une ville amie, d'une base militaire
 * (× supplyRangeFactor) ou d'un dépôt avancé ; limitée jusqu'au double ; coupée au-delà.
 */
export function supplyOf(state: EngineState, u: Unit, friends?: NationId[]): SupplyState {
  if (sysOf(state, u).movement !== 'land') return 'supplied';
  const w = wi(state.world);
  const pos: LngLat = unitPosAt(state, u, state.time);
  const fr = friends ?? friendsOf(state, u.owner);
  const here = w.nav.cellProv.get(w.nav.cellAt(pos));
  if (here && fr.includes(state.provinces[here]?.owner ?? '')) return 'supplied';
  const R = cfg(state.world).logistics.supplyRangeKm * modifier(state, u.owner, 'supply.range');
  const baseF = effect(state.world, 'military_base', 'supplyRangeFactor', 1);
  let best = Infinity;
  for (const m of fr) {
    for (const pid of provincesOf(state, m)) {
      const d = distanceKm(w.provById.get(pid)!.cityPoint, pos);
      let r = d / R;
      if (health(state, pid, 'military_base') > 0) r = d / (R * baseF);
      if (r < best) best = r;
    }
  }
  const es = eco(state);
  for (const id of sortedIds(es.depots)) {
    const dep = es.depots[id]!;
    if (!fr.includes(dep.n)) continue;
    const r = distanceKm(dep.at, pos) / Math.max(1e-6, dep.rangeKm);
    if (r < best) best = r;
  }
  return best <= 1 ? 'supplied' : best <= 2 ? 'limited' : 'cut';
}

/** Réévalue le ravitaillement des unités des nations données (toutes si absent). */
export function evalSupply(state: EngineState, nations?: Iterable<NationId>): void {
  const es = eco(state);
  if (!es.live) return;
  const list = nations ? [...new Set(nations)].sort() : state.nationIds;
  for (const n of list) {
    const fr = friendsOf(state, n);
    for (const uid of sortedSet(state.rt.byNation.get(n))) {
      const u = state.units[uid];
      if (!u) continue;
      const s = supplyOf(state, u, fr);
      if (s === 'supplied') delete es.supply[uid];
      else es.supply[uid] = s;
    }
  }
}

export function supplyState(state: EngineState, uid: string): SupplyState {
  return eco(state).supply[uid] ?? 'supplied';
}

/** Efficacité au combat selon le ravitaillement. */
export function supplyEfficiency(state: EngineState, u: Unit): number {
  const s = eco(state).supply[u.id];
  if (!s) return 1;
  const c = cfg(state.world).logistics;
  return s === 'limited' ? c.limitedEfficiency : c.cutEfficiency;
}

/** Blindage apporté par la fortification de la province (défenseur à l'arrêt chez lui). */
export function fortificationArmor(state: EngineState, u: Unit): number {
  const es = eco(state);
  if (u.move) return 1;
  let any = false;
  for (const _ in es.forts) {
    any = true;
    break;
  }
  if (!any) return 1;
  const w = wi(state.world);
  const pid = w.nav.cellProv.get(w.nav.cellAt(u.pos));
  if (!pid || state.provinces[pid]?.owner !== u.owner) return 1;
  const lvl = es.forts[pid] ?? 0;
  if (lvl <= 0) return 1;
  return 1 + effect(state.world, 'fortification', 'armorPerLevel', 0) * lvl;
}
