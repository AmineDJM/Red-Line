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

/** Restrictions liées au site (ressource, côte, ville) : le bâtiment n'est pas proposé du tout. */
export const SITE_RESTRICTIONS = ['no_resource', 'coastal_only', 'not_urban'] as const;
export type SiteRestriction = (typeof SITE_RESTRICTIONS)[number];

export interface BuildMenuGroup<T extends string> {
  id: string;
  /** Bâtiments proposés : constructibles ici, ou déjà présents (amélioration). */
  types: T[];
  /** Bâtiments absents et impossibles dans la province, par raison (ligne d'explication). */
  hidden: Partial<Record<SiteRestriction, T[]>>;
}

/**
 * Menu « Construire » d'une province : n'y figure que ce qui est ouvert pour elle. Un bâtiment
 * absent et interdit par le site (ressource, côte, pôle électronique) est retiré de la liste (et
 * compté dans `hidden`) ; un bâtiment déjà présent reste (amélioration). Une famille sans aucun
 * bâtiment proposé disparaît. Sans options du moteur, seule la règle côtière est connue du client.
 */
export function buildMenuGroups<T extends string>(
  groups: readonly { id: string; types: readonly T[] }[],
  ctx: {
    existing: readonly string[];
    options?: readonly { type: string; blocked?: BuildBlock }[] | undefined;
    coastal: boolean;
    coastalOnly: ReadonlySet<string>;
  },
): BuildMenuGroup<T>[] {
  const opts = new Map(ctx.options?.map((o) => [o.type, o]));
  const site = new Set<string>(SITE_RESTRICTIONS);
  const out: BuildMenuGroup<T>[] = [];
  for (const g of groups) {
    const types: T[] = [];
    const hidden: Partial<Record<SiteRestriction, T[]>> = {};
    for (const type of g.types) {
      if (ctx.existing.includes(type)) {
        types.push(type);
        continue;
      }
      const o = opts.get(type);
      const why: SiteRestriction | null =
        o?.blocked && site.has(o.blocked)
          ? (o.blocked as SiteRestriction)
          : !o && ctx.coastalOnly.has(type) && !ctx.coastal
            ? 'coastal_only'
            : null;
      if (why) (hidden[why] ??= []).push(type);
      else types.push(type);
    }
    if (types.length > 0) out.push({ id: g.id, types, hidden });
  }
  return out;
}
