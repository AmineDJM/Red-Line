import type { NationId } from '@redline/shared';
import type { GameStats } from '../../api.js';
import { sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { board } from '../kit.js';
import { mil, milBal, type StatSt } from './state.js';

/** Statistiques de fin de partie : éliminations, pertes, victimes estimées, meilleures unités. */

export function statOf(state: EngineState, n: NationId): StatSt {
  const m = mil(state);
  let s = m.stats[n];
  if (!s) {
    s = { kills: 0, losses: 0, cas: 0, casInf: 0, bySys: {}, missiles: 0, intercepted: 0 };
    m.stats[n] = s;
  }
  return s;
}

/** Éléments perdus par `victim` (attribués à `by` si connu). Les missiles et leurres ne comptent pas. */
export function countLoss(state: EngineState, victim: Unit, lost: number, by: Unit | null): void {
  if (lost <= 0 || victim.role) return;
  const sys = sysOf(state, victim);
  const per = milBal(state).casualties[sys.category] ?? 0;
  const v = statOf(state, victim.owner);
  v.losses += lost;
  v.cas += lost * per;
  if (by && by.owner !== victim.owner) {
    const k = statOf(state, by.owner);
    k.kills += lost;
    k.casInf += lost * per;
    k.bySys[by.sys] = (k.bySys[by.sys] ?? 0) + lost;
    const vs = (k.vs ??= {});
    vs[victim.owner] =
      (vs[victim.owner] ?? 0) + lost * (sys.cost.money / Math.max(1, sys.unitSize));
  }
}

/** Éléments qu'une unité perd si elle tombe à `hp` points de vie. */
export function elementsLost(state: EngineState, u: Unit, hpAfter: number): number {
  const per = sysOf(state, u).hp;
  const after = hpAfter <= 1e-6 ? 0 : Math.max(1, Math.ceil(hpAfter / per - 1e-9));
  return Math.max(0, u.count - after);
}

export function fillStats(state: EngineState, out: GameStats): void {
  const m = mil(state);
  for (const n of Object.keys(out.nations).sort()) {
    const s = m.stats[n];
    if (!s) continue;
    const o = out.nations[n]!;
    o.kills += s.kills;
    o.losses += s.losses;
    o.bestUnits = Object.keys(s.bySys)
      .map((systemId) => ({ systemId, kills: s.bySys[systemId]! }))
      .sort((a, b) => b.kills - a.kills || (a.systemId < b.systemId ? -1 : 1))
      .slice(0, 5);
    o.casualties = Math.round(s.cas);
  }
  out.alertLevel = board(state).alertLevel;
}
