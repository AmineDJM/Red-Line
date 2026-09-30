import {
  RESOURCES,
  type LedgerKey,
  type NationId,
  type OrderErrorCode,
  type Resource,
  type WeaponSystem,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { ecoNation, type Paid } from './state.js';

const MESSAGES: Partial<Record<OrderErrorCode, string>> = {
  insufficient_funds: 'Fonds insuffisants.',
  insufficient_resources: 'Ressources insuffisantes.',
  research_required: 'Recherche requise (ou licence de production).',
  not_owner: 'Cette province ne vous appartient pas.',
  invalid_target: 'Cible invalide.',
  not_allowed: 'Action impossible.',
  capacity: "File d'attente pleine.",
  locked: 'Bloqué (embargo ou blocus).',
  cooldown: 'Délai minimal non écoulé.',
};

export function fail(error: OrderErrorCode, message?: string): OrderResult {
  return { ok: false, error, message: message ?? MESSAGES[error] ?? error };
}

/** Arme nucléaire (jamais exportable, jamais vendue). */
export function isNuclear(sys: WeaponSystem): boolean {
  return sys.category === 'nuclear' || sys.missile?.warhead === 'nuclear';
}

/** Le système existe-t-il (en service ou produit) à l'année du scénario ? */
export function eraOk(sys: WeaponSystem, year: number): boolean {
  if (!sys.era) return true;
  if (sys.era.introduced > year) return false;
  return sys.era.retired === undefined || sys.era.retired > year;
}

/** Prix unitaire en dollars d'un élément. */
export function unitPrice(sys: WeaponSystem): number {
  return sys.unitPriceUsd ?? sys.cost.money / Math.max(1, sys.unitSize);
}

export function canPay(state: EngineState, n: NationId, p: Paid): OrderErrorCode | null {
  const ns = state.nations[n]!;
  if (ns.money < p.money) return 'insufficient_funds';
  for (const r of RESOURCES) if ((p.res[r] ?? 0) > ns.res[r]) return 'insufficient_resources';
  return null;
}

/** Inscrit un flux signé au grand livre du jour (recette > 0, dépense < 0). */
export function book(state: EngineState, n: NationId, key: LedgerKey, amount: number): void {
  if (amount === 0 || !state.nations[n]) return;
  const en = ecoNation(state, n);
  en.today[key] = (en.today[key] ?? 0) + amount;
}

export function pay(state: EngineState, n: NationId, p: Paid, key: LedgerKey): void {
  const ns = state.nations[n]!;
  ns.money -= p.money;
  for (const r of RESOURCES) ns.res[r] -= p.res[r] ?? 0;
  ecoNation(state, n).spent += p.money;
  book(state, n, key, -p.money);
}

export function refund(
  state: EngineState,
  n: NationId,
  p: Paid,
  share: number,
  key: LedgerKey,
): void {
  const ns = state.nations[n];
  if (!ns) return;
  ns.money += p.money * share;
  for (const r of RESOURCES) ns.res[r] += (p.res[r] ?? 0) * share;
  ecoNation(state, n).spent -= p.money * share;
  book(state, n, key, p.money * share);
}

export function scaledRes(
  res: Partial<Record<Resource, number | undefined>>,
  k: number,
): Partial<Record<Resource, number>> {
  const out: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    const v = res[r];
    if (v) out[r] = v * k;
  }
  return out;
}
