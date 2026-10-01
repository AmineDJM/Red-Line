import { z } from 'zod';
import { CATEGORIES, type WeaponSystem } from './catalog.js';

/**
 * Piles mixtes (section `stacks` de data/balance, optionnelle ; chaque valeur a un défaut).
 *
 * Une pile réunit des éléments de plusieurs matériels du même domaine (brigade interarmes, escadre
 * d'hélicoptères…). Sa puissance est la somme de ses éléments : chaque matériel tire avec ses propres
 * dégâts et sa propre portée, les dégâts reçus sont répartis au prorata des points de vie, la détection
 * est celle du meilleur capteur, la vitesse celle du plus lent, l'entretien la somme des entretiens.
 * Ne se mélangent jamais : munitions (missiles), intercepteurs, radars, satellites, navires,
 * ravitailleurs et avions radar, unités fixes.
 */
export const StacksBalanceSchema = z.object({
  /**
   * Classes de fusion : seuls des matériels d'une même classe peuvent partager une pile (fusion par
   * le joueur ou l'IA). Un matériel absent de toute classe ne fusionne qu'avec son propre type.
   */
  classes: z.record(z.string(), z.array(z.enum(CATEGORIES))).default({
    land: ['infantry', 'ifv', 'tank', 'artillery'],
    rotary: ['helicopter'],
    jet: ['fighter', 'bomber'],
    drone: ['drone'],
  }),
  /** Distance maximale entre deux piles fusionnées (km). */
  mergeKm: z.number().positive().default(10),
  /** Matériels différents au plus dans une pile (fusion refusée au-delà). */
  maxSystems: z.number().int().min(2).default(24),
  /** Regroupement des forces de départ (ORBAT et armée de repli). */
  start: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Groupes regroupés au départ : catégories réunies dans une même pile et taille maximale en
       * « modules » (un module = `startingForces.stackMax` éléments de la catégorie, ex. 60 chars).
       * Une nation reçoit ceil(modules / maxModules) piles du groupe, chacune avec une part de chaque
       * matériel, posées sur les sites du domaine (capitale, frontières menacées, bases, grandes villes).
       * Les avions de combat restent en escadrons d'un seul type (la classe `jet` sert aux fusions).
       */
      groups: z
        .array(
          z.object({
            id: z.string(),
            categories: z.array(z.enum(CATEGORIES)).min(1),
            maxModules: z.number().positive(),
          }),
        )
        .default([
          { id: 'land', categories: ['infantry', 'ifv', 'tank', 'artillery'], maxModules: 12 },
          { id: 'rotary', categories: ['helicopter'], maxModules: 6 },
          { id: 'drone', categories: ['drone'], maxModules: 4 },
        ]),
    })
    .default({}),
  /** Emploi des piles par l'IA (détachements et regroupements). */
  ai: z
    .object({
      /**
       * En guerre, nombre souhaité de piles terrestres mobiles : garnison de la capitale + ce multiple
       * de la taille de groupe d'offensive du niveau. En dessous, l'IA divise ses plus grosses piles.
       */
      warStacksPerGroup: z.number().min(0).default(2),
      /**
       * En guerre, piles terrestres souhaitées selon le front : min(warStacksPerProvince × provinces
       * possédées, warStacksPerEnemyProvince × provinces ennemies). Les piles proches du front sont
       * divisées les premières.
       */
      warStacksPerProvince: z.number().min(0).default(1),
      warStacksPerEnemyProvince: z.number().min(0).default(1),
      /** Au-delà de ce multiple du nombre souhaité, l'IA refond ses piles voisines à l'arrêt. */
      mergeAbove: z.number().min(1).default(2),
      /** En paix, piles terrestres souhaitées par province possédée (plus une) : au-delà, fusion. */
      peaceStacksPerProvince: z.number().min(0).default(0.25),
      /** En paix, regroupement tenté une réflexion tactique calme sur ce nombre. */
      peaceMergeEvery: z.number().int().min(1).default(4),
      /** Éléments minimum d'une pile pour être divisée (chaque moitié garde au moins la moitié). */
      minSplitElements: z.number().int().min(2).default(4),
      /** Divisions ou fusions au plus par réflexion et par nation. */
      maxOpsPerThink: z.number().int().min(0).default(6),
    })
    .default({}),
});
export type StacksBalance = z.infer<typeof StacksBalanceSchema>;

/**
 * Classe de fusion d'un matériel (`classes` de StacksBalance), null s'il ne se mélange jamais :
 * munitions, intercepteurs, satellites, navires (et hélicoptères embarqués), radars d'alerte et
 * avions radar, renseignement électronique, ravitailleurs, unités fixes. Les brouilleurs
 * d'autoprotection (chasseurs, hélicoptères) se mélangent : le brouillage d'une pile est celui de son
 * meilleur brouilleur, comme pour des unités côte à côte. Même règle pour le moteur et l'interface.
 */
export function stackClassOf(
  sys: WeaponSystem,
  classes: Record<string, readonly string[]>,
): string | null {
  const k = sys.sensor?.kind;
  if (
    sys.missile ||
    sys.interceptor ||
    sys.space ||
    sys.naval ||
    sys.movement === 'static' ||
    sys.speedKmh <= 0 ||
    (sys.air?.tankerFuelH ?? 0) > 0 ||
    k === 'aew' ||
    k === 'early_warning' ||
    k === 'satellite' ||
    k === 'sigint'
  )
    return null;
  for (const c of Object.keys(classes).sort()) if (classes[c]!.includes(sys.category)) return c;
  return null;
}
