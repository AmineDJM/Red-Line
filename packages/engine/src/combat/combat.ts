import { callHook, modifier, unitModifier } from '../modules/registry.js';
import { MINUTE, positionAt, type UnitId } from '@redline/shared';
import { nextFloat } from '../rng/rng.js';
import {
  atWar,
  currentLeg,
  isEmbarked,
  nationUnits,
  notify,
  schedule,
  sightLevel,
  sortedKeys,
  sortedSet,
  sysOf,
  unitPosAt,
  unitVecAt,
  veterancyLevel,
} from '../state/access.js';
import { addToIndex, removeFromIndex } from '../state/runtime.js';
import type { EngineState, Unit } from '../state/types.js';
import { inWeaponRange, otherOf, removeUnitPairs } from '../encounters/pairs.js';
import { vecDistKm } from '../geo/sphere.js';
import { setMovement } from '../movement/movement.js';
import { planUnitMove } from '../movement/plan-unit.js';
import type { GameEvent } from '../queue/events.js';

/**
 * Combat par rounds. Une unité « engagée » tire à chaque round (balance.time.combatRoundMinutes) sur
 * une cible valide : nation en guerre, à portée d'arme (min..max), visible par sa nation, dégâts non
 * nuls contre sa classe, et autorisée par la posture ('hold' ne tire que sur sa cible d'ordre).
 * Les contre-mesures découlent de la matrice de dégâts et du brouillage.
 */

function roundMs(state: EngineState): number {
  return state.world.balance.time.combatRoundMinutes * MINUTE;
}

interface TargetCand {
  unit: Unit;
  d: number;
}

function validTargets(state: EngineState, u: Unit): TargetCand[] {
  const sys = sysOf(state, u);
  if (sys.weaponRangeKm.max <= 0) return [];
  if (isEmbarked(state, u, state.time)) return [];
  const out: TargetCand[] = [];
  for (const key of sortedSet(state.rt.pairsOf.get(u.id))) {
    if (key.includes('#')) continue;
    const pair = state.pairs[key];
    if (!pair) continue;
    const o = state.units[otherOf(key, u.id)];
    if (!o) continue;
    if (!atWar(state, u.owner, o.owner)) continue;
    if (!inWeaponRange(sys, pair.d)) continue;
    const os = sysOf(state, o);
    if (sys.damage[os.targetClass] <= 0) continue;
    if (sightLevel(state, u.owner, o.id) === 0) continue;
    if (u.stance === 'hold' && u.target !== o.id) continue;
    out.push({ unit: o, d: pair.d });
  }
  return out;
}

function chooseTarget(state: EngineState, u: Unit, list: TargetCand[]): Unit | null {
  if (list.length === 0) return null;
  if (u.target) {
    const t = list.find((c) => c.unit.id === u.target);
    if (t) return t.unit;
  }
  const sys = sysOf(state, u);
  let best: Unit | null = null;
  let bestScore = -Infinity;
  for (const c of list) {
    const os = sysOf(state, c.unit);
    const score = sys.damage[os.targetClass] * (1 - os.armor);
    if (score > bestScore) {
      bestScore = score;
      best = c.unit;
    }
  }
  return best;
}

export function setTarget(state: EngineState, u: Unit, tid: UnitId, mode: 'order' | 'auto'): void {
  if (u.target) removeFromIndex(state.rt.chasers, u.target, u.id);
  u.target = tid;
  u.tmode = mode;
  addToIndex(state.rt.chasers, tid, u.id);
}

export function clearTarget(state: EngineState, u: Unit): void {
  if (u.target) removeFromIndex(state.rt.chasers, u.target, u.id);
  u.target = null;
  u.tmode = null;
  if (u.chasing && u.move) setMovement(state, u, null);
  u.chasing = false;
}

function canMove(state: EngineState, u: Unit): boolean {
  const s = sysOf(state, u);
  return s.movement !== 'static' && s.speedKmh > 0;
}

/** Réévalue la situation de combat d'une unité (appelé via l'ensemble « dirty »). */
export function refreshCombat(state: EngineState, uid: UnitId): void {
  const u = state.units[uid];
  if (!u) return;
  if (u.target && !state.units[u.target]) clearTarget(state, u);
  const list = validTargets(state, u);
  const pick = chooseTarget(state, u, list);
  if (pick) {
    if (u.stance === 'aggressive' && !u.target) setTarget(state, u, pick.id, 'auto');
    if (!u.engaged) {
      u.engaged = true;
      u.cv++;
      schedule(state, { k: 'round', t: state.time, u: u.id, v: u.cv });
      if (!(pick.engaged && pick.target === u.id)) {
        notify(
          state,
          {
            kind: 'combat_started',
            time: state.time,
            at: unitPosAt(state, u, state.time),
            unitIds: [u.id, pick.id],
          },
          [u.owner, pick.owner],
        );
      }
    }
    // Poursuite terminée : la cible est à portée, on s'arrête pour tirer.
    if (u.chasing && u.move && u.target && list.some((c) => c.unit.id === u.target)) {
      setMovement(state, u, null);
    }
    return;
  }
  if (u.engaged) {
    u.engaged = false;
    u.cv++;
  }
  if (u.target) {
    const tgt = state.units[u.target]!;
    const visible = sightLevel(state, u.owner, tgt.id) > 0;
    if (visible && canMove(state, u) && !u.chasing) requestChase(state, u.id, 0);
    else if (!visible && !u.move) clearTarget(state, u);
  }
}

export function requestChase(state: EngineState, uid: UnitId, delayMs: number): void {
  const u = state.units[uid];
  if (!u || u.chaseEv !== 0) return;
  u.chaseEv = schedule(state, { k: 'chase', t: state.time + delayMs, u: uid });
}

export function handleChase(state: EngineState, ev: Extract<GameEvent, { k: 'chase' }>): void {
  const u = state.units[ev.u]!;
  u.chaseEv = 0;
  if (!u.target) return;
  const tgt = state.units[u.target];
  if (!tgt) {
    clearTarget(state, u);
    return;
  }
  if (sightLevel(state, u.owner, tgt.id) === 0) {
    if (!u.move) clearTarget(state, u);
    return;
  }
  if (validTargets(state, u).some((c) => c.unit.id === tgt.id)) return;
  if (!canMove(state, u)) return;
  // Point visé : position prévue de la cible sur son segment courant (seule partie observée).
  const now = state.time;
  const here = unitVecAt(state, u, now);
  const there = unitVecAt(state, tgt, now);
  const speed = sysOf(state, u).speedKmh;
  const etaMs = speed > 0 ? (vecDistKm(here, there) / speed) * 3_600_000 : 0;
  const leg = currentLeg(tgt, now);
  const aim = leg
    ? positionAt({ legs: [leg] }, Math.min(now + etaMs, leg.t1))
    : unitPosAt(state, tgt, now);
  const plan = planUnitMove(state, u, aim);
  if ('error' in plan || plan.legs.length === 0) {
    // Inatteignable, ou déjà au plus près sans être à portée : on abandonne la cible.
    clearTarget(state, u);
    return;
  }
  setMovement(state, u, plan.legs, { chasing: true });
}

/** Round de combat : l'unité tire une fois sur sa meilleure cible valide. */
export function handleRound(state: EngineState, ev: Extract<GameEvent, { k: 'round' }>): void {
  const u = state.units[ev.u]!;
  const list = validTargets(state, u);
  const pick = chooseTarget(state, u, list);
  if (!pick) {
    u.engaged = false;
    u.cv++;
    state.rt.dirtyCombat.add(u.id);
    return;
  }
  fire(state, u, pick);
  if (state.units[u.id] && u.engaged) {
    schedule(state, { k: 'round', t: state.time + roundMs(state), u: u.id, v: u.cv });
  }
}

/** Dégâts d'un round (exporté pour les tests). */
export function roundDamage(state: EngineState, u: Unit, tgt: Unit, varianceRoll: number): number {
  const b = state.world.balance.combat;
  const sys = sysOf(state, u);
  const ts = sysOf(state, tgt);
  const vet = veterancyLevel(state, u.xp);
  let dmg =
    sys.damage[ts.targetClass] * u.count * (1 + vet * b.veterancyDamageBonus) * varianceRoll;
  dmg *= modifier(state, u.owner, 'combat.damage') / modifier(state, tgt.owner, 'combat.armor');
  dmg *= unitModifier(state, u, 'combat.damage') / unitModifier(state, tgt, 'combat.armor');
  dmg *= 1 - ts.armor;
  if (inOwnCity(state, tgt)) dmg /= 1 + b.defenderCityBonus;
  const jam = jammingFor(state, tgt);
  dmg *= 1 - jam * (1 - sys.ew.jamResistance);
  return Math.max(0, dmg);
}

function fire(state: EngineState, u: Unit, tgt: Unit): void {
  const v = state.world.balance.combat.variance;
  const roll = 1 + v * (2 * nextFloat(state.rng) - 1);
  const dmg = roundDamage(state, u, tgt, roll);
  if (dmg <= 0) return;
  const ts = sysOf(state, tgt);
  tgt.hp -= dmg;
  tgt.lastHit = state.time;
  u.xp += dmg;
  callHook('onDamage', state, u, tgt, dmg);
  if (tgt.hp <= 1e-6) {
    destroyUnit(state, tgt, u);
    return;
  }
  tgt.count = Math.max(1, Math.ceil(tgt.hp / ts.hp - 1e-9));
  state.rt.dirtyCombat.add(tgt.id);
}

/** Le défenseur est-il dans une ville de sa nation (≤ groundContactKm du point de ville) ? */
export function inOwnCity(state: EngineState, u: Unit): boolean {
  const gc = state.world.balance.combat.groundContactKm;
  for (const key of sortedSet(state.rt.pairsOf.get(u.id))) {
    const h = key.indexOf('#');
    if (h < 0) continue;
    const pair = state.pairs[key];
    if (!pair || pair.d > gc) continue;
    if (state.provinces[key.slice(0, h)]?.owner === u.owner) return true;
  }
  return false;
}

/** Brouillage : le plus fort brouilleur allié dont la portée de détection couvre l'unité. */
export function jammingFor(state: EngineState, u: Unit): number {
  let best = 0;
  const here = unitVecAt(state, u, state.time);
  for (const id of nationUnits(state, u.owner)) {
    const j = state.units[id]!;
    const s = sysOf(state, j);
    if (s.ew.jamming <= best) continue;
    const d = id === u.id ? 0 : vecDistKm(here, unitVecAt(state, j, state.time));
    if (d <= s.detectionRangeKm) best = s.ew.jamming;
  }
  return best;
}

/**
 * Supprime une unité détruite. `quiet` : retrait sans destruction (porteur arrivé, unité cédée) — ni
 * crochet onUnitDestroyed, ni notification.
 */
export function destroyUnit(
  state: EngineState,
  u: Unit,
  killer: Unit | null,
  opts: { quiet?: boolean } = {},
): void {
  if (!opts.quiet) callHook('onUnitDestroyed', state, u, killer);
  const t = state.time;
  const at = unitPosAt(state, u, t);
  const seers: string[] = [];
  for (const n of sortedKeys(state.sight)) if (sightLevel(state, n, u.id) > 0) seers.push(n);
  if (!opts.quiet) notify(
    state,
    { kind: 'unit_destroyed', time: t, at, unitId: u.id, owner: u.owner, systemId: u.sys },
    [u.owner, ...(killer ? [killer.owner] : []), ...seers],
  );
  removeUnitPairs(state, u.id);
  for (const n of seers) {
    const k = state.know[n];
    if (k) {
      delete k[u.id];
      if (Object.keys(k).length === 0) delete state.know[n];
    }
  }
  for (const n of sortedKeys(state.sight)) {
    const s = state.sight[n]!;
    if (s[u.id]) {
      delete s[u.id];
      if (Object.keys(s).length === 0) delete state.sight[n];
    }
  }
  for (const c of sortedSet(state.rt.chasers.get(u.id))) {
    const cu = state.units[c];
    if (cu) {
      clearTarget(state, cu);
      state.rt.dirtyCombat.add(c);
    }
  }
  state.rt.chasers.delete(u.id);
  if (u.target) removeFromIndex(state.rt.chasers, u.target, u.id);
  removeFromIndex(state.rt.byNation, u.owner, u.id);
  state.rt.geom.delete(u.id);
  state.rt.dirtyCombat.delete(u.id);
  delete state.units[u.id];
}
