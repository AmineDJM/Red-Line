import { MINUTE, type NationId, type UnitId } from '@redline/shared';
import { notify, sightLevel, sortedSet, unitPosAt } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';

/**
 * Brouillard de guerre. Chaque paire (observateur, cible) contribue un niveau 0..3 ; on tient, par nation
 * et par unité observée, le nombre d'observateurs à chaque niveau. Le niveau effectif est le plus haut.
 * Les transitions 0 → n et n → 0 créent / figent le contact (Contact) de la nation.
 */
export function detectionLevel(state: EngineState, dKm: number, r: number): number {
  if (r <= 0 || dKm > r) return 0;
  const s = state.world.balance.sensors;
  if (dKm <= r * s.preciseAtFraction) return 3;
  if (dKm <= r * s.identifiedAtFraction) return 2;
  return 1;
}

/** Rayons des trois niveaux de détection pour une portée effective (furtivité déjà comprise). */
export function detectionRadii(state: EngineState, r: number): number[] {
  if (r <= 0) return [];
  const s = state.world.balance.sensors;
  return [r, r * s.identifiedAtFraction, r * s.preciseAtFraction];
}

export function changeSight(
  state: EngineState,
  nation: NationId,
  uid: UnitId,
  oldLevel: number,
  newLevel: number,
): void {
  if (oldLevel === newLevel) return;
  const before = sightLevel(state, nation, uid);
  let byNation = state.sight[nation];
  if (!byNation) byNation = state.sight[nation] = {};
  let c = byNation[uid];
  if (!c) c = byNation[uid] = [0, 0, 0];
  if (oldLevel > 0) c[oldLevel - 1] = c[oldLevel - 1]! - 1;
  if (newLevel > 0) c[newLevel - 1] = c[newLevel - 1]! + 1;
  if (c[0] <= 0 && c[1] <= 0 && c[2] <= 0) {
    delete byNation[uid];
    if (Object.keys(byNation).length === 0) delete state.sight[nation];
  }
  const after = sightLevel(state, nation, uid);
  if (before === after) return;
  const u = state.units[uid];
  if (!u) return;
  if (before === 0) acquire(state, nation, u, after);
  else if (after === 0) lose(state, nation, u);
  else updateLevel(state, nation, u, after);
  if ((before === 0) !== (after === 0)) {
    // La permission de tir des unités de `nation` sur `uid` change.
    for (const key of sortedSet(state.rt.pairsOf.get(uid))) {
      if (key.includes('#')) continue;
      const [a, b] = key.split('|') as [UnitId, UnitId];
      const other = a === uid ? b : a;
      if (state.units[other]?.owner === nation) state.rt.dirtyCombat.add(other);
    }
  }
}

function acquire(state: EngineState, nation: NationId, u: Unit, lvl: number): void {
  let known = state.know[nation];
  if (!known) known = state.know[nation] = {};
  const prev = known[u.id];
  const t = state.time;
  const pos = unitPosAt(state, u, t);
  const forgotten =
    !prev || t - prev.lastSeen > state.world.balance.sensors.forgetAfterMinutes * MINUTE;
  known[u.id] = {
    owner: u.owner,
    lvl,
    seen: true,
    since: t,
    lastSeen: t,
    pos,
    sys: lvl >= 2 ? u.sys : forgotten ? null : (prev?.sys ?? null),
    count: null,
    hpr: null,
    status: null,
  };
  if (forgotten) {
    notify(state, { kind: 'unit_detected', time: t, at: pos, unitId: u.id }, [nation]);
  }
}

function lose(state: EngineState, nation: NationId, u: Unit): void {
  const c = state.know[nation]?.[u.id];
  if (!c) return;
  const t = state.time;
  c.seen = false;
  c.lastSeen = t;
  c.pos = unitPosAt(state, u, t);
  if (c.lvl >= 2) c.sys = u.sys;
  if (c.lvl >= 3) {
    c.count = u.count;
    c.hpr = u.hp / u.maxHp;
    c.status = u.move ? 'moving' : u.engaged ? 'combat' : 'idle';
  } else {
    c.count = null;
    c.hpr = null;
    c.status = null;
  }
}

function updateLevel(state: EngineState, nation: NationId, u: Unit, lvl: number): void {
  const c = state.know[nation]?.[u.id];
  if (!c) return;
  c.lvl = lvl;
  if (lvl >= 2) c.sys = u.sys;
}
