import type { LngLat, NationId, TargetClass, WeaponSystem } from '@redline/shared';
import { modifier, unitModifier } from '../modules/registry.js';
import { board } from '../modules/kit.js';
import { milBal, milOpt } from '../modules/mil/state.js';
import { atWar, sysOf, unitPosAt, warKey } from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { wi } from '../state/world.js';

/**
 * Profil effectif d'une unité pour les rencontres et le combat : portées d'arme et de détection,
 * classe de cible, furtivité face à un capteur donné. Dépend du catalogue et de l'état du module
 * militaire (aéronef au sol, embarqué, brouilleur actif, radars aveuglés, sous-marin repéré…).
 * Quand l'un de ces états change, le module recalcule les paires des unités concernées.
 */

export interface Range {
  min: number;
  max: number;
}

const NO_RANGE: Range = { min: 0, max: 0 };

/** Lanceur de missiles (tire par ordre de frappe, jamais en rounds de combat). */
export function isLauncher(sys: WeaponSystem): boolean {
  return !!sys.missile;
}

/** Radar au sens large (aveuglable, repérable par un missile antiradar, cible prioritaire). */
export function isRadarSensor(sys: WeaponSystem): boolean {
  const k = sys.sensor?.kind;
  return (
    k === 'radar' ||
    k === 'aew' ||
    k === 'early_warning' ||
    sys.category === 'air_defense' ||
    sys.category === 'radar'
  );
}

const OTH_ROLES = ['oth', 'over-the-horizon', 'over_the_horizon', 'transhorizon'];

/**
 * Radar transhorizon : très longue portée, faible précision. Il ne participe pas à la détection
 * continue ; il balaie périodiquement sa zone et ne donne que le niveau « détecté » (module mil).
 */
export function isOthRadar(state: EngineState, sys: WeaponSystem): boolean {
  const s = sys.sensor;
  if (!s || s.kind !== 'radar') return false;
  return (
    sys.roles.some((r) => OTH_ROLES.includes(r)) ||
    s.rangeKm >= milBal(state).sensors.othMinRangeKm
  );
}

/** Portée brute des capteurs de détection continue (catalogue), plafonnée. */
function rawDetectKm(state: EngineState, sys: WeaponSystem): number {
  let r = sys.detectionRangeKm;
  const s = sys.sensor;
  if (s && isOthRadar(state, sys)) r = Math.min(r, 150);
  else if (s && (s.kind === 'radar' || s.kind === 'aew' || s.kind === 'optical')) {
    r = Math.max(r, s.rangeKm);
  }
  return Math.min(r, milBal(state).sensors.maxPairKm);
}

/** Aéronef à carburant posé (sur une base au sol ou sur un porte-avions). */
export function isLanded(state: EngineState, u: Unit): boolean {
  const m = milOpt(state)?.ms[u.id];
  return !!m && m.fa && !m.up;
}

/** Brouilleur en émission (émet par défaut ; ordre `jam` pour l'éteindre). */
export function isEmitting(state: EngineState, u: Unit): boolean {
  if (u.off || u.role) return false;
  if (sysOf(state, u).ew.jamming <= 0) return false;
  if (isLanded(state, u)) return false;
  return !milOpt(state)?.jamOff[u.id];
}

/** Sous-marin en plongée et non repéré : seuls sonars et moyens ASM le voient. */
export function isHiddenSub(state: EngineState, u: Unit): boolean {
  const sys = sysOf(state, u);
  if (!sys.naval?.submerged) return false;
  const exp = milOpt(state)?.exposed[u.id];
  return !(exp !== undefined && exp > state.time);
}

function blinded(state: EngineState, n: NationId): boolean {
  const b = milOpt(state)?.blind[n];
  return b !== undefined && b > state.time;
}

/** Portée d'arme utilisable en rounds de combat (0 pour missiles, leurres, lanceurs, aéronefs posés). */
export function weaponRange(state: EngineState, u: Unit): Range {
  if (u.off || u.role) return NO_RANGE;
  const sys = sysOf(state, u);
  if (isLauncher(sys) || sys.category === 'space') return NO_RANGE;
  if (sys.weaponRangeKm.max <= 0) return NO_RANGE;
  if (sys.air && isLanded(state, u)) return NO_RANGE;
  return sys.weaponRangeKm;
}

export function inRange(r: Range, d: number): boolean {
  return r.max > 0 && d <= r.max && d >= r.min;
}

/** Classe de cible effective : missile en vol, aéronef au sol (vulnérable comme une installation). */
export function targetClassOf(state: EngineState, u: Unit): TargetClass {
  if (u.role === 'missile') return 'missile';
  const sys = sysOf(state, u);
  if (sys.air && isLanded(state, u)) return 'building';
  return sys.targetClass;
}

/** Portée de détection générale (radar, optique) ; les capteurs d'alerte et satellites sont à part. */
export function detectKm(state: EngineState, u: Unit): number {
  if (u.off || u.role) return 0;
  const sys = sysOf(state, u);
  if (sys.category === 'space') return 0;
  if (sys.air && isLanded(state, u)) return 0;
  let r = rawDetectKm(state, sys);
  if (isRadarSensor(sys)) {
    r *= modifier(state, u.owner, 'sensors.radarRange');
    if (blinded(state, u.owner)) r *= milBal(state).sensors.blindFactor;
  }
  return r;
}

/** Portée sonar / ASM (0 si aucun moyen de lutte anti-sous-marine). */
export function sonarKm(state: EngineState, u: Unit): number {
  if (u.off || u.role) return 0;
  const sys = sysOf(state, u);
  if (sys.air && isLanded(state, u)) return 0;
  let r = 0;
  if (sys.sensor?.kind === 'sonar') r = sys.sensor.rangeKm;
  const asw = sys.naval?.asw ?? 0;
  if (asw > 0) r = Math.max(r, sys.detectionRangeKm * asw);
  if (r <= 0) return 0;
  return r * modifier(state, u.owner, 'naval.sonar') * unitModifier(state, u, 'naval.sonar');
}

function stealthDetect(state: EngineState, obs: Unit): number {
  const sd = sysOf(state, obs).sensor?.stealthDetect ?? 0;
  if (sd <= 0) return 0;
  return Math.min(1, sd * modifier(state, obs.owner, 'sensors.stealthDetect'));
}

/** Portée à laquelle `obs` détecte `tgt` (furtivité, sonar, brouilleur en émission), 0 si jamais. */
export function sightRangeKm(state: EngineState, obs: Unit, tgt: Unit): number {
  if (tgt.off || obs.off) return 0;
  const ts = sysOf(state, tgt);
  if (isHiddenSub(state, tgt)) {
    const r = sonarKm(state, obs);
    if (r <= 0) return 0;
    return r * (1 - ts.stealth * (1 - stealthDetect(state, obs)));
  }
  const d = detectKm(state, obs);
  if (d <= 0) return 0;
  let r = ts.stealth > 0 ? d * (1 - ts.stealth * (1 - stealthDetect(state, obs))) : d;
  // Un brouilleur qui émet se trahit : il est repéré par quiconque se trouve dans sa zone d'effet.
  if (isEmitting(state, tgt)) r = Math.max(r, ts.detectionRangeKm);
  return r;
}

/** Couverture de base d'une province (radar autour de la ville) contre une unité. */
export function provSightRangeKm(state: EngineState, owner: NationId, tgt: Unit): number {
  if (tgt.off) return 0;
  if (isHiddenSub(state, tgt)) return 0;
  let r = state.world.balance.sensors.provinceDetectionKm * (1 - sysOf(state, tgt).stealth);
  if (blinded(state, owner)) r *= milBal(state).sensors.blindFactor;
  return r;
}

/** Marge de la zone indexée pour couvrir les bonus de portée (recherche, généraux). */
const ZONE_SLACK = 1.25;

/**
 * Rayon de la zone indexée d'une unité (détection, sonar, arme, émission). Ne dépend QUE du catalogue
 * et des champs sérialisés de l'unité (jamais des modificateurs ni de l'heure) : l'index reconstruit
 * après une désérialisation est ainsi identique, donc les paires candidates aussi (déterminisme).
 */
export function zoneKm(state: EngineState, u: Unit): number {
  if (u.off || u.role) return 0;
  const sys = sysOf(state, u);
  if (sys.category === 'space') return 0;
  let det = rawDetectKm(state, sys);
  if (sys.sensor?.kind === 'sonar') det = Math.max(det, sys.sensor.rangeKm);
  const w = isLauncher(sys) ? 0 : sys.weaponRangeKm.max;
  return Math.max(det * ZONE_SLACK, w);
}

/** Position de la base d'attache d'un aéronef à carburant (province ou unité porteuse), sinon null. */
export function airBasePos(state: EngineState, u: Unit): LngLat | null {
  const m = milOpt(state)?.ms[u.id];
  if (!m || !m.fa || !m.base) return null;
  if (m.bk === 'p') return wi(state.world).provById.get(m.base)?.cityPoint ?? null;
  const c = state.units[m.base];
  return c ? unitPosAt(state, c, state.time) : null;
}

/** Rayon d'action effectif (km) : fiche × recherche × général. */
export function airRadiusKm(state: EngineState, u: Unit): number {
  const r = sysOf(state, u).operationalRadiusKm;
  if (r === null) return Infinity;
  return r * modifier(state, u.owner, 'air.range') * unitModifier(state, u, 'air.range');
}

/** Cessez-le-feu en vigueur entre deux nations (tableau partagé, écrit par diplo). */
export function ceasefire(state: EngineState, a: NationId, b: NationId): boolean {
  const end = board(state).ceasefires[warKey(a, b)];
  return end !== undefined && end > state.time;
}

function hasNoFly(state: EngineState): boolean {
  for (const _ in board(state).noFly) return true;
  return false;
}

/** Aéronef en vol à l'intérieur d'une zone d'exclusion aérienne étrangère : province violée, sinon null. */
export function noFlyViolation(state: EngineState, u: Unit): string | null {
  if (u.off || u.role === 'missile') return null;
  if (!hasNoFly(state)) return null;
  const sys = sysOf(state, u);
  if (sys.movement !== 'air' || isLanded(state, u)) return null;
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellAt(unitPosAt(state, u, state.time)));
  if (!pid || !board(state).noFly[pid]) return null;
  const owner = state.provinces[pid]?.owner;
  if (!owner || owner === u.owner) return null;
  return pid;
}

/**
 * `u` peut-il tirer sur `o` ? Guerre sans cessez-le-feu, ou aéronef de `o` violant une zone
 * d'exclusion aérienne au-dessus d'une province de la nation de `u` (considéré hostile).
 */
export function hostile(state: EngineState, u: Unit, o: Unit): boolean {
  if (u.owner === o.owner) return false;
  if (atWar(state, u.owner, o.owner)) return !ceasefire(state, u.owner, o.owner);
  const pid = noFlyViolation(state, o);
  return !!pid && state.provinces[pid]?.owner === u.owner;
}
