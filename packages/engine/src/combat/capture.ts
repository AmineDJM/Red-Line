import { MINUTE, type NationId, type ProvinceId } from '@redline/shared';
import { atWar, isEmbarked, notify, schedule, sortedSet, sysOf } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../state/world.js';
import { provEntity, provinceOwnerChanged } from '../encounters/pairs.js';
import type { GameEvent } from '../queue/events.js';

/**
 * Capture : une unité `canCapture` d'une nation en guerre avec le propriétaire, arrêtée à ≤ 5 km du
 * point de ville, sans unité terrestre du propriétaire à ≤ groundContactKm, capture la province en
 * balance.time.captureMinutes. Réévaluée à chaque changement pertinent (paires de la ville, arrivées,
 * départs, guerres) ; interrompue dès que la condition tombe.
 */
export function evaluateCapture(state: EngineState, pid: ProvinceId): void {
  const P = state.provinces[pid];
  if (!P) return;
  const owner = P.owner;
  const gc = state.world.balance.combat.groundContactKm;
  const capturers: Unit[] = [];
  let defended = false;
  for (const key of sortedSet(state.rt.pairsOf.get(provEntity(pid)))) {
    const pair = state.pairs[key];
    if (!pair) continue;
    const U = state.units[key.slice(key.indexOf('#') + 1)];
    if (!U) continue;
    const sys = sysOf(state, U);
    if (
      pair.d <= CAPTURE_RADIUS_KM &&
      U.owner !== owner &&
      sys.canCapture &&
      U.move === null &&
      atWar(state, U.owner, owner) &&
      !isEmbarked(state, U, state.time)
    ) {
      capturers.push(U);
    }
    if (pair.d <= gc && U.owner === owner && sys.movement === 'land') defended = true;
  }
  if (capturers.length > 0 && !defended) {
    const nations = capturers.map((u) => u.owner);
    const by = P.capture && nations.includes(P.capture.by) ? P.capture.by : nations[0]!;
    if (P.capture && P.capture.by === by) return;
    P.capV++;
    const t = state.time;
    P.capture = {
      by,
      startedAt: t,
      completesAt: t + state.world.balance.time.captureMinutes * MINUTE,
      v: P.capV,
    };
    schedule(state, { k: 'cap', t: P.capture.completesAt, prov: pid, v: P.capV });
    notify(
      state,
      {
        kind: 'province_capture_started',
        time: t,
        at: wi(state.world).provById.get(pid)!.cityPoint,
        provinceId: pid,
        by,
      },
      [owner, by],
    );
  } else if (P.capture) {
    P.capture = null;
    P.capV++;
  }
}

export function handleCaptureComplete(
  state: EngineState,
  ev: Extract<GameEvent, { k: 'cap' }>,
): void {
  const P = state.provinces[ev.prov]!;
  const by = P.capture!.by;
  transferProvince(state, ev.prov, by);
}

export function transferProvince(state: EngineState, pid: ProvinceId, to: NationId): void {
  const P = state.provinces[pid]!;
  const from = P.owner;
  if (from === to) return;
  const t = state.time;
  P.owner = to;
  P.capture = null;
  P.capV++;
  const nf = state.nations[from]!;
  const nt = state.nations[to]!;
  nf.provinceCount--;
  nt.provinceCount++;
  nf.production = nf.production.filter((it) => it.provinceId !== pid);
  provinceOwnerChanged(state, pid, to);
  const at = wi(state.world).provById.get(pid)!.cityPoint;
  notify(state, { kind: 'province_captured', time: t, at, provinceId: pid, by: to, from }, null);
  if (nf.provinceCount <= 0 && nf.alive) {
    nf.alive = false;
    nf.production = [];
    notify(state, { kind: 'nation_defeated', time: t, nationId: from }, null);
  }
  state.rt.dirtyCapture.add(pid);
  for (const key of sortedSet(state.rt.pairsOf.get(provEntity(pid)))) {
    state.rt.dirtyCombat.add(key.slice(key.indexOf('#') + 1));
  }
  checkVictory(state);
}

/** Nation en tête (plus de provinces, départage par identifiant). */
export function leaderOf(state: EngineState): NationId | null {
  let best: NationId | null = null;
  let bestN = -1;
  for (const n of state.nationIds) {
    const c = state.nations[n]!.provinceCount;
    if (c > bestN) {
      bestN = c;
      best = n;
    }
  }
  return best;
}

export function checkVictory(state: EngineState): void {
  if (state.winner) return;
  const v = state.world.balance.victory;
  const total = state.totalProvinces;
  let winner: NationId | null = null;
  if (v.provinceShare > 0 && total > 0) {
    for (const n of state.nationIds) {
      const ns = state.nations[n]!;
      if (ns.alive && ns.provinceCount / total >= v.provinceShare) {
        winner = n;
        break;
      }
    }
  }
  if (!winner && v.allEnemyCapitals && state.nationIds.length > 1) {
    const w = wi(state.world);
    const capitals: { nation: NationId; prov: ProvinceId }[] = [];
    for (const n of state.nationIds) {
      const cap = w.nationById.get(n)?.capitalProvinceId;
      if (cap && state.provinces[cap]) capitals.push({ nation: n, prov: cap });
    }
    for (const n of state.nationIds) {
      if (!state.nations[n]!.alive) continue;
      const others = capitals.filter((c) => c.nation !== n);
      if (others.length > 0 && others.every((c) => state.provinces[c.prov]!.owner === n)) {
        winner = n;
        break;
      }
    }
  }
  if (winner) {
    state.winner = winner;
    notify(state, { kind: 'victory', time: state.time, winner }, null);
  }
}
