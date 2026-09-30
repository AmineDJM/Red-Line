import { z } from 'zod';

/** Chiffres d'équilibrage globaux (data/balance/*.json). Tout est réglable par l'admin. */
export const BalanceSchema = z.object({
  version: z.number().int(),
  time: z.object({
    /** Vitesses proposées à la création d'une partie. */
    speeds: z.array(z.number().positive()).default([1, 2, 4, 8, 16]),
    /** Durée d'un round de combat, en minutes de jeu. */
    combatRoundMinutes: z.number().positive(),
    /** Temps d'occupation d'une ville sans défenseur pour capturer la province, en minutes de jeu. */
    captureMinutes: z.number().positive(),
    /** Période de réflexion des IA, en minutes de jeu. */
    aiThinkMinutes: z.number().positive(),
  }),
  combat: z.object({
    /** Variance des dégâts : multiplicateur tiré dans [1 - v, 1 + v]. */
    variance: z.number().min(0).max(1),
    /** Distance de contact entre deux unités terrestres, en km. */
    groundContactKm: z.number().positive(),
    /** Bonus du défenseur retranché dans une ville. */
    defenderCityBonus: z.number().min(0),
    /** Expérience nécessaire pour les niveaux de vétérance. */
    veterancyXp: z.array(z.number()),
    /** Bonus de dégâts par niveau de vétérance. */
    veterancyDamageBonus: z.number().min(0),
  }),
  movement: z.object({
    /** Facteur de vitesse d'une unité terrestre embarquée en mer. */
    embarkedSpeedFactor: z.number().positive(),
    /** Délai d'embarquement/débarquement, en minutes de jeu. */
    embarkMinutes: z.number().min(0),
  }),
  sensors: z.object({
    /** Couverture radar de base autour de la ville de chaque province possédée, en km. */
    provinceDetectionKm: z.number().min(0),
    /** Fractions de la portée de détection pour passer « identifiée » puis « précise ». */
    identifiedAtFraction: z.number().min(0).max(1),
    preciseAtFraction: z.number().min(0).max(1),
    /** Vitesse de croissance de l'incertitude d'une position non réobservée, en km/h de jeu. */
    uncertaintyGrowthKmh: z.number().min(0),
    /** Au-delà de cet âge (minutes de jeu), un contact perdu est oublié. */
    forgetAfterMinutes: z.number().positive(),
  }),
  economy: z.object({
    startingMoney: z.number().min(0),
    startingResources: z.record(z.string(), z.number()),
    /** Multiplicateur appliqué aux revenus des provinces. */
    incomeMultiplier: z.number().min(0),
  }),
  victory: z.object({
    /** Part des provinces du monde à contrôler pour gagner (0 à 1). */
    provinceShare: z.number().min(0).max(1),
    /** Ou contrôle de toutes les capitales ennemies. */
    allEnemyCapitals: z.boolean(),
  }),
  /** Armée de départ par nation jouable, posée autour de la capitale. */
  startingArmy: z.array(z.object({ systemId: z.string(), count: z.number().int().min(1) })),
  /** Armée de départ réduite pour les nations non jouées (IA neutres). */
  garrisonArmy: z.array(z.object({ systemId: z.string(), count: z.number().int().min(1) })),
});
export type Balance = z.infer<typeof BalanceSchema>;
