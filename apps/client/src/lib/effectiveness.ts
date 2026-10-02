import { useMemo } from 'react';
import {
  effectAgainst,
  effectivenessContext,
  mixEffectiveness,
  type Balance,
  type EffectScores,
  type EffectTarget,
  type EffectivenessContext,
  type SystemId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { useWorld } from '../store/world.js';
import { stackParts } from './stacks.js';

/**
 * Notes d'efficacité par catégorie de cible (logique pure, sans rendu) : contexte de notation mémorisé
 * par catalogue et équilibrage, notes d'une pile (mixte : moyenne pondérée par sa composition) et
 * note contre une cible désignée. Calcul partagé : packages/shared/src/effectiveness.ts.
 */

type Catalog = Record<SystemId, WeaponSystem>;

const memo = new WeakMap<Catalog, Map<Balance | null, EffectivenessContext>>();

/** Contexte de notation d'un catalogue (équilibrage absent : valeurs par défaut des schémas). */
export function effectContextFor(catalog: Catalog, balance: Balance | null): EffectivenessContext {
  let m = memo.get(catalog);
  if (!m) memo.set(catalog, (m = new Map()));
  let c = m.get(balance);
  if (!c) {
    c = effectivenessContext(Object.values(catalog), balance);
    m.set(balance, c);
  }
  return c;
}

export function useEffectContext(): EffectivenessContext {
  const catalog = useWorld((s) => s.catalog);
  const balance = useWorld((s) => s.balance);
  return useMemo(() => effectContextFor(catalog, balance), [catalog, balance]);
}

function partsOf(u: UnitView, catalog: Catalog) {
  return stackParts(u)
    .map((p) => ({ system: catalog[p.systemId]!, count: p.count }))
    .filter((p) => !!p.system);
}

/** Notes d'une pile (null : matériel inconnu). */
export function unitEffect(
  u: UnitView,
  catalog: Catalog,
  ctx: EffectivenessContext,
): EffectScores | null {
  const parts = partsOf(u, catalog);
  return parts.length > 0 ? mixEffectiveness(parts, ctx) : null;
}

/** Note de la sélection contre une cible désignée (null : cible sans catégorie ou inconnue). */
export function selectionEffectAgainst(
  units: UnitView[],
  target: UnitView,
  catalog: Catalog,
  ctx: EffectivenessContext,
): { target: EffectTarget; score: number } | null {
  const tsys = target.systemId ? catalog[target.systemId] : undefined;
  if (!tsys || target.level === 'detected') return null;
  const parts = units.flatMap((u) => partsOf(u, catalog));
  if (parts.length === 0) return null;
  return effectAgainst(parts, tsys, ctx, { inFlight: !!target.missile });
}
