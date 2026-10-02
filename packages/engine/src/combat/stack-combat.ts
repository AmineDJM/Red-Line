import type { TargetClass, WeaponSystem } from '@redline/shared';
import { targetClassOf } from '../encounters/profile.js';
import { vecDistKm } from '../geo/sphere.js';
import { sysOf, unitVecAt } from '../state/access.js';
import { partsOf } from '../state/stack.js';
import type { EngineState, StackPart, Unit } from '../state/types.js';

/**
 * Combat des piles mixtes (voir state/stack.ts) : dégâts = somme, sur les matériels de l'attaquant à
 * portée, de leurs dégâts contre chaque matériel de la cible pondérés par sa part des points de vie et
 * réduits par son blindage. Une pile simple contre une pile simple garde le calcul d'origine
 * (combat.ts) ; ces fonctions servent dès qu'un des deux côtés est mixte.
 */

interface Hit {
  cls: TargetClass;
  armor: number;
  w: number;
}

const hitCache = new WeakMap<Unit, { mix: StackPart[]; cls0: TargetClass; hits: Hit[] }>();

/** Matériels touchés d'une cible : classe, blindage et part des PV (en cache par composition). */
function hitParts(state: EngineState, tgt: Unit): Hit[] {
  const cls0 = targetClassOf(state, tgt);
  const mix = tgt.mix;
  if (!mix) return [{ cls: cls0, armor: sysOf(state, tgt).armor, w: 1 }];
  const hit = hitCache.get(tgt);
  if (hit && hit.mix === mix && hit.cls0 === cls0) return hit.hits;
  // État particulier de toute la pile (aéronefs au sol…) : la classe effective s'applique à tous.
  const lead = state.world.catalog.get(tgt.sys)!;
  const special = cls0 !== lead.targetClass;
  const parts = partsOf(state, tgt);
  let M = 0;
  for (const p of parts) M += p.m;
  const hits = parts.map((p) => ({
    cls: special ? cls0 : p.sys.targetClass,
    armor: p.sys.armor,
    w: M > 0 ? p.m / M : 1 / parts.length,
  }));
  hitCache.set(tgt, { mix, cls0, hits });
  return hits;
}

/** L'attaquant (fiche) peut-il blesser au moins un matériel de la cible ? */
export function canHarm(state: EngineState, sys: WeaponSystem, tgt: Unit): boolean {
  for (const h of hitParts(state, tgt)) if (sys.damage[h.cls] > 0) return true;
  return false;
}

/**
 * Dégâts d'un round avant vétérance, variance, modificateurs, bonus de ville et brouillage :
 * Σ (matériels à portée) effectif × Σ (matériels de la cible) part × dégâts × (1 − blindage).
 */
export function mixedBaseDamage(state: EngineState, u: Unit, tgt: Unit): number {
  const hits = hitParts(state, tgt);
  const fire = u.mix
    ? partsOf(state, u).map((p) => ({ s: p.sys, c: p.c }))
    : [{ s: sysOf(state, u), c: u.count }];
  const d = u.mix
    ? vecDistKm(unitVecAt(state, u, state.time), unitVecAt(state, tgt, state.time))
    : 0;
  let sum = 0;
  for (const f of fire) {
    // Tolérance : la distance des paires est évaluée aux franchissements de seuil.
    const w = f.s.weaponRangeKm;
    if (u.mix && !(w.max > 0 && d <= w.max + 1e-6 && d >= w.min - 1e-6)) continue;
    let per = 0;
    for (const h of hits) per += h.w * f.s.damage[h.cls] * (1 - h.armor);
    sum += f.c * per;
  }
  return sum;
}
