import type { GameNotification, NationId, Order, PlayerView } from '@redline/shared';
import type { GameStats, OrderResult, SystemCommand } from '../api.js';
import type { EngineState } from '../state/types.js';
import type { EngineModule, ModEvent, ModuleHooks, ModuleId, ModuleIncome } from './types.js';
import { ecoModule } from './eco/index.js';
import { milModule } from './mil/index.js';
import { intelModule } from './intel/index.js';
import { diploModule } from './diplo/index.js';
import { cmdModule } from './command/index.js';

/** Ordre fixe (déterminisme) : les crochets sont appelés dans cet ordre. */
export const MODULES: readonly EngineModule[] = [
  ecoModule,
  milModule,
  intelModule,
  diploModule,
  cmdModule,
];

export function moduleById(id: ModuleId): EngineModule | undefined {
  return MODULES.find((m) => m.id === id);
}

export { board, modState, scheduleMod } from './kit.js';

type HookName = keyof ModuleHooks;
type HookArgs<K extends HookName> = Parameters<NonNullable<ModuleHooks[K]>>;

/** Appelle un crochet sur tous les modules, dans l'ordre. */
export function callHook<K extends HookName>(name: K, ...args: HookArgs<K>): void {
  for (const m of MODULES) {
    const fn = m.hooks?.[name] as ((...a: HookArgs<K>) => unknown) | undefined;
    if (fn) fn(...args);
  }
}

/** Premier code d'erreur renvoyé par un module (canProduce). */
export function firstError(
  ...args: HookArgs<'canProduce'>
): ReturnType<NonNullable<ModuleHooks['canProduce']>> {
  for (const m of MODULES) {
    const r = m.hooks?.canProduce?.(...args);
    if (r) return r;
  }
  return null;
}

/** Produit des multiplicateurs des modules pour une clé (1 si aucun). */
export function modifier(state: EngineState, n: NationId, key: string): number {
  let f = 1;
  for (const m of MODULES) {
    const v = m.hooks?.modifier?.(state, n, key);
    if (typeof v === 'number' && Number.isFinite(v)) f *= v;
  }
  return f;
}

/** Produit des multiplicateurs par unité. */
export function unitModifier(
  state: EngineState,
  u: Parameters<NonNullable<ModuleHooks['unitModifier']>>[1],
  key: string,
): number {
  let f = 1;
  for (const m of MODULES) {
    const v = m.hooks?.unitModifier?.(state, u, key);
    if (typeof v === 'number' && Number.isFinite(v)) f *= v;
  }
  return f;
}

/** Revenus journaliers fournis par un module (null = calcul du cœur). */
export function moduleIncome(state: EngineState, n: NationId): ModuleIncome | null {
  for (const m of MODULES) {
    const r = m.hooks?.income?.(state, n);
    if (r) return r;
  }
  return null;
}

export function canImport(state: EngineState, n: NationId, systemId: string) {
  for (const m of MODULES) {
    const r = m.hooks?.canImport?.(state, n, systemId);
    if (r) return r;
  }
  return null;
}

/** Émet un signal vers tous les modules (ordre fixe). */
export function signal(state: EngineState, name: string, data: Record<string, unknown>): void {
  for (const m of MODULES) m.hooks?.onSignal?.(state, name, data);
}

export function placeStartingForces(state: EngineState, n: NationId): boolean {
  for (const m of MODULES) if (m.hooks?.placeStartingForces?.(state, n)) return true;
  return false;
}

export function dispatchModEvent(state: EngineState, ev: ModEvent): void {
  moduleById(ev.m)?.onEvent?.(state, ev);
}

export function moduleOrder(state: EngineState, n: NationId, order: Order): OrderResult | null {
  for (const m of MODULES) {
    const h = m.orders?.[order.kind];
    if (h) return h(state, n, order);
  }
  return null;
}

/** Premier module qui prend en charge un ordre du cœur (interceptOrder), sinon null. */
export function moduleIntercept(state: EngineState, n: NationId, order: Order): OrderResult | null {
  for (const m of MODULES) {
    const r = m.hooks?.interceptOrder?.(state, n, order);
    if (r) return r;
  }
  return null;
}

export function moduleSystem(state: EngineState, cmd: SystemCommand): OrderResult | null {
  for (const m of MODULES) {
    const h = m.system?.[cmd.kind];
    if (h) return h(state, cmd);
  }
  return null;
}

export function moduleViews(state: EngineState, nation: NationId, view: PlayerView): void {
  for (const m of MODULES) m.view?.(state, nation, view);
}

export function modulePublicViews(state: EngineState, view: PlayerView): void {
  for (const m of MODULES) m.publicView?.(state, view);
}

export function moduleAudience(
  state: EngineState,
  nation: NationId,
  note: GameNotification,
): boolean {
  for (const m of MODULES) {
    const r = m.hooks?.audience?.(state, nation, note);
    if (r !== undefined) return r;
  }
  return false;
}

export function moduleStats(state: EngineState, out: GameStats): void {
  for (const m of MODULES) m.hooks?.stats?.(state, out);
}
