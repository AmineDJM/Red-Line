import type { NationId, WeaponSystem } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { cfg } from './config.js';
import { eco, ecoRt, orbatOf } from './state.js';

/**
 * Budget de défense journalier d'une nation (dollars du catalogue), 0 sans ORBAT : budget annuel de
 * l'ORBAT × fraction journalière × multiplicateur × conversion en dollars du catalogue (scénarios
 * historiques).
 */
export function budgetDay(state: EngineState, n: NationId): number {
  const o = orbatOf(state, n);
  if (!o) return 0;
  const m = cfg(state.world).money;
  return o.defenseBudgetUsd * m.budgetPerDayFraction * m.budgetMultiplier * m.budgetDollarFactor;
}

// ——— Entretien ajusté ———
//
// Entretien journalier d'un élément = prix catalogue (`upkeepPerDay`, dollars 2025, inchangé)
//   × facteur de génération (matériel ancien : moins d'heures de vol, pièces cannibalisées…)
//   × coût local : (1 − part locale) + part locale × indice de coût de la nation (soldes, carburant et
//     main-d'œuvre au niveau de prix du pays ; pièces et munitions importées au prix mondial)
//   × facteur national de départ : si l'entretien de l'ORBAT réel dépasse `maxStartShare` du budget
//     (armées anciennes et nombreuses entretenues à bas coût dans la réalité), toutes les unités de la
//     nation sont réduites d'autant ; calculé une fois à la création de la partie (EcoState.upk).

/** Indice de coût local d'une nation (ORBAT `costIndex`, sinon `upkeep.defaultCostIndex`). */
export function costIndexOf(state: EngineState, n: NationId): number {
  return orbatOf(state, n)?.costIndex ?? cfg(state.world).upkeep.defaultCostIndex;
}

/** Facteur d'âge et de coût local d'un système pour une nation (sans le facteur national). */
function baseFactor(state: EngineState, n: NationId, sys: WeaponSystem): number {
  const c = cfg(state.world).upkeep;
  const gen = c.generationExempt.includes(sys.category)
    ? 1
    : (c.generationFactor[String(sys.generation)] ?? 1);
  const ls = c.localShare[sys.category] ?? c.localShareDefault;
  return gen * (1 - ls + ls * costIndexOf(state, n));
}

/** Facteur national de départ (1 si absent). */
export function nationUpkeepFactor(state: EngineState, n: NationId): number {
  return eco(state).upk?.[n] ?? 1;
}

/** Facteur total appliqué au prix catalogue de l'entretien d'un système pour une nation. */
export function upkeepFactor(state: EngineState, n: NationId, sys: WeaponSystem): number {
  const rt = ecoRt(state);
  let m = rt.upkeep.get(n);
  if (!m) rt.upkeep.set(n, (m = new Map()));
  let f = m.get(sys.id);
  if (f === undefined) {
    f = eco(state).live ? baseFactor(state, n, sys) * nationUpkeepFactor(state, n) : 1;
    m.set(sys.id, f);
  }
  return f;
}

/**
 * Entretien journalier en dollars de `count` éléments d'un système pour une nation (âge, coût local et
 * facteur national compris ; hors modificateurs de recherche). Fonction pure : IA, interface, bancs.
 */
export function unitUpkeepPerDay(
  state: EngineState,
  n: NationId,
  sys: WeaponSystem,
  count = 1,
): number {
  return sys.upkeepPerDay * count * upkeepFactor(state, n, sys);
}

/** Entretien journalier de l'inventaire ORBAT d'une nation, avant le facteur national. */
function orbatUpkeep(state: EngineState, n: NationId): number {
  const o = orbatOf(state, n);
  if (!o) return 0;
  let raw = 0;
  for (const it of o.inventory) {
    const sys = state.world.catalog.get(it.systemId);
    if (!sys || it.count <= 0) continue;
    raw += sys.upkeepPerDay * it.count * baseFactor(state, n, sys);
  }
  return raw;
}

/**
 * Facteurs nationaux de départ (seules les valeurs ≠ 1 sont gardées) : l'entretien des forces réelles
 * (âge et coût local compris) est ramené dans [minStartShare, maxStartShare] du budget de défense.
 * Ne dépend que des données (ORBAT, catalogue, équilibrage) : identique à la création et à la
 * migration d'une sauvegarde antérieure.
 */
export function startUpkeepFactors(state: EngineState): Record<NationId, number> {
  const c = cfg(state.world).upkeep;
  const out: Record<NationId, number> = {};
  for (const n of [...state.nationIds].sort()) {
    const o = orbatOf(state, n);
    const bd = budgetDay(state, n);
    if (!o || bd <= 0) continue;
    const raw = orbatUpkeep(state, n);
    if (raw <= 0) continue;
    const share = raw / bd;
    const max = o.upkeepShare ?? c.maxStartShare;
    const min = Math.min(c.minStartShare, max);
    let f = 1;
    if (share > max) f = max / share;
    else if (min > 0 && share < min) f = min / share;
    if (f !== 1) out[n] = f;
  }
  return out;
}

/**
 * Part du budget de défense que l'entretien des forces de départ absorbe (après tous les facteurs) :
 * information pour l'IA, l'interface et les bancs (0 sans ORBAT).
 */
export function startUpkeepShare(state: EngineState, n: NationId): number {
  const bd = budgetDay(state, n);
  return bd > 0 ? (orbatUpkeep(state, n) * nationUpkeepFactor(state, n)) / bd : 0;
}
