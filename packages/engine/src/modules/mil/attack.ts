import { distanceKm, type Leg, type NationId, type Order, type TargetClass } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { clearTarget, requestChase, setTarget } from '../../combat/combat.js';
import { inWeaponRange, unitPairKey } from '../../encounters/pairs.js';
import { ceasefire, isLauncher, isRadarSensor, targetClassOf } from '../../encounters/profile.js';
import { setMovement } from '../../movement/movement.js';
import { planUnitMove } from '../../movement/plan-unit.js';
import { sightLevel, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { declareWar } from '../../state/war.js';
import { airFeasible, flyTo, missionOf, noFlyAt, startScan } from './air.js';
import { mil, milBal } from './state.js';
import { orderStrike } from './strike.js';
import { OK, fail, failR, isSatellite, launchCells, posOf } from './util.js';

/**
 * Ordre « attaquer une unité », aiguillé selon le matériel de chaque pile (comme dans Conflict of
 * Nations, un seul geste pour toutes les armes) :
 *  - munitions en stock (missiles, munitions rôdeuses) : tir d'une salve dimensionnée sur la cible
 *    (ordre de frappe, portée de frappe) ;
 *  - aéronefs à carburant contre une cible au sol ou en mer : mission de frappe aérienne (décollage,
 *    aller, frappe, retour) ; contre une cible aérienne : interception (veille autour de la cible et
 *    poursuite) ;
 *  - navires sans arme directe contre la cible mais dotés de cellules : missiles de croisière ;
 *  - autres unités : poursuite et tir en rounds de combat (comportement d'origine).
 * Les piles incapables de toucher la cible sont écartées avec leur raison ; si aucune ne peut agir,
 * l'ordre est refusé avec la raison la plus précise (défense antiaérienne contre une cible au sol,
 * cible hors de portée…). Atomique : tout est validé avant la moindre modification.
 */

const AIR_CLASSES: TargetClass[] = ['aircraft', 'helicopter', 'drone', 'missile'];

type Refusal = OrderResult & { ok: false };

function refuse(state: EngineState, u: Unit, tClass: TargetClass, air: boolean): Refusal {
  const s = sysOf(state, u);
  if (s.category === 'air_defense' && !air) {
    return failR(
      'invalid_target',
      'air_defense_air_only',
      `${s.name} : défense antiaérienne, cibles aériennes uniquement (avions, hélicoptères, drones, missiles).`,
      { name: s.name },
    ) as Refusal;
  }
  return failR(
    'invalid_target',
    'cannot_hit_class',
    `${s.name} ne peut pas toucher ce type de cible.`,
    { name: s.name, cls: tClass },
  ) as Refusal;
}

/** Missiles à tirer par une pile de munitions contre `t` (salve dimensionnée, au moins 1). */
function salvoFor(state: EngineState, u: Unit, t: Unit, tClass: TargetClass): number {
  const s = sysOf(state, u);
  const per = s.damage[tClass] * (1 - sysOf(state, t).armor);
  if (per <= 0) return u.count;
  const need = Math.ceil((t.hp / per) * milBal(state).strike.attackSalvoFactor);
  return Math.max(1, Math.min(u.count, need));
}

export function orderAttack(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'attack' }>,
): OrderResult {
  const m = mil(state);
  const units: Unit[] = [];
  for (const id of [...new Set(o.unitIds)].sort()) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    // Aéronefs embarqués : ils catapultent ; autres unités hors carte : indisponibles.
    if (u.role || (u.off && !m.ms[id]?.emb)) {
      return fail('not_allowed', `Unité indisponible pour cet ordre : ${id}`);
    }
    units.push(u);
  }
  const tgt = state.units[o.targetId];
  if (!tgt || tgt.off || tgt.role === 'missile') {
    return failR('invalid_target', 'target_invalid', 'Cible invalide.');
  }
  if (tgt.owner === n) return failR('invalid_target', 'target_friendly', 'Cible amie.');
  if (sightLevel(state, n, tgt.id) === 0) {
    return failR(
      'invalid_target',
      'target_not_visible',
      'Cible hors de vue : repérez-la d’abord (radar, reconnaissance, satellite).',
    );
  }
  if (ceasefire(state, n, tgt.owner)) {
    return failR('locked', 'ceasefire', 'Cessez-le-feu en vigueur.');
  }
  const tClass = targetClassOf(state, tgt);
  const air = AIR_CLASSES.includes(tClass);
  const tSys = sysOf(state, tgt);
  const aim = posOf(state, tgt);

  const strike: Unit[] = [];
  const counts = new Map<string, number>();
  const intercept: Unit[] = [];
  const combat: Unit[] = [];
  const plans = new Map<string, Leg[]>();
  const refused: Refusal[] = [];
  for (const u of units) {
    const s = sysOf(state, u);
    if (isSatellite(s)) {
      refused.push(refuse(state, u, tClass, air));
      continue;
    }
    if (isLauncher(s)) {
      const k = s.missile!.kind;
      if (
        s.damage[tClass] <= 0 ||
        (k === 'antiship' && tSys.movement !== 'sea') ||
        (k === 'antiradiation' && !isRadarSensor(tSys))
      ) {
        refused.push(refuse(state, u, tClass, air));
        continue;
      }
      strike.push(u);
      counts.set(u.id, salvoFor(state, u, tgt, tClass));
      continue;
    }
    const ms = m.ms[u.id];
    if (ms?.fa) {
      if (s.damage[tClass] <= 0) {
        refused.push(refuse(state, u, tClass, air));
        continue;
      }
      if (noFlyAt(state, n, aim)) return fail('locked', 'Zone d’exclusion aérienne.');
      if (air) {
        const err = airFeasible(state, u, aim);
        if (err) return err;
        intercept.push(u);
      } else strike.push(u);
      continue;
    }
    if (u.off) {
      refused.push(refuse(state, u, tClass, air));
      continue;
    }
    if (s.weaponRangeKm.max <= 0 || s.damage[tClass] <= 0) {
      if (s.movement === 'sea' && launchCells(s) > 0 && !air) {
        strike.push(u);
        continue;
      }
      refused.push(refuse(state, u, tClass, air));
      continue;
    }
    const pair = state.pairs[unitPairKey(u.id, tgt.id)];
    const d = pair ? pair.d : distanceKm(posOf(state, u), aim);
    if (inWeaponRange(state, u, d)) {
      combat.push(u);
      continue;
    }
    // Navire à cellules de lancement, cible de surface hors de portée de ses armes : missiles.
    if (s.movement === 'sea' && launchCells(s) > 0 && !air) {
      strike.push(u);
      continue;
    }
    const static_ = s.movement === 'static' || s.speedKmh <= 0 || !!m.fixedOf[u.id];
    // Défense antiaérienne : elle ne poursuit pas un avion ; hors de portée de tir = refus clair.
    if (static_ || (s.category === 'air_defense' && air)) {
      const r = s.weaponRangeKm;
      refused.push(
        failR(
          'out_of_range',
          'out_of_weapon_range',
          `${s.name} : cible hors de portée de tir (${Math.round(d)} km, portée ${Math.round(r.min)}–${Math.round(r.max)} km).`,
          { name: s.name, dist: Math.round(d), min: Math.round(r.min), max: Math.round(r.max) },
        ) as Refusal,
      );
      continue;
    }
    const plan = planUnitMove(state, u, aim);
    if ('error' in plan) {
      return fail(
        plan.error,
        plan.error === 'out_of_range' ? "Hors du rayon d'action." : 'Destination inaccessible.',
      );
    }
    combat.push(u);
    plans.set(u.id, plan.legs);
  }
  if (!strike.length && !intercept.length && !combat.length) {
    return refused[0] ?? failR('invalid_target', 'target_invalid', 'Cible invalide.');
  }

  // Frappes (munitions, aviation, cellules) : validées et appliquées d'un bloc par l'ordre de frappe.
  if (strike.length) {
    const r = orderStrike(
      state,
      n,
      {
        kind: 'strike',
        unitIds: strike.map((u) => u.id),
        target: { type: 'unit', unitId: tgt.id },
      },
      counts,
    );
    if (!r.ok) return r;
  }
  declareWar(state, n, tgt.owner);
  const radius = milBal(state).air.interceptRadiusKm;
  for (const u of intercept) {
    const ms = missionOf(state, u);
    ms.mis = 'patrol';
    ms.at = [aim[0], aim[1]];
    ms.r = radius;
    ms.tg = null;
    ms.ph = 'out';
    ms.retry = 0;
    ms.tk = null;
    startScan(state, u, ms);
    flyTo(state, u, aim);
    setTarget(state, u, tgt.id, 'order');
    requestChase(state, u.id, 0);
    state.rt.dirtyCombat.add(u.id);
  }
  for (const u of combat) {
    // Une patrouille (navire) ou une mission en cours ne doit pas ramener l'unité en arrière.
    const ms = m.ms[u.id];
    if (ms && !ms.fa && ms.mis !== 'none') {
      ms.mis = 'none';
      ms.ph = null;
      ms.sv++;
    }
    if (u.target) clearTarget(state, u);
    setTarget(state, u, tgt.id, 'order');
    const legs = plans.get(u.id);
    if (legs) setMovement(state, u, legs, { chasing: true });
    else state.rt.dirtyCombat.add(u.id);
  }
  if (refused.length) {
    const names = refused.map((r) => r.message).join(' ');
    return {
      ok: true,
      reason: 'partial',
      message: `Ordre transmis ; ${refused.length} pile(s) écartée(s) : ${names}`,
      params: { count: refused.length, detail: names },
    };
  }
  return OK;
}
