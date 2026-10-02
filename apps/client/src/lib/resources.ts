import type { BuildBlock, BuildingType, Resource } from '@redline/shared';

/** Bâtiment d'extraction → ressource exigée (data/balance resources.extraction, défaut du moteur). */
export function extractionResource(
  balance: { resources?: { extraction?: Record<string, Resource> } } | null | undefined,
  type: string,
): Resource | undefined {
  const map = balance?.resources?.extraction ?? { oil_field: 'oil', mine: 'metals', farm: 'food' };
  return map[type as BuildingType];
}

/** Bonus de revenu des provinces « argent seulement » (data/balance, défaut 10 %). */
export function servicesBonusPct(
  balance: { resources?: { servicesIncomeBonus?: number } } | null | undefined,
): number {
  return Math.round((balance?.resources?.servicesIncomeBonus ?? 0.1) * 100);
}

/** Raisons de blocage d'un chantier : toutes traduites (buildings.ui.blocked.<raison>). */
export const BUILD_BLOCKS: BuildBlock[] = [
  'in_progress',
  'damaged',
  'max_level',
  'no_resource',
  'coastal_only',
  'not_urban',
];
