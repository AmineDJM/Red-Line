import { z } from 'zod';

/** Classes de cible : colonnes de la matrice de dégâts. */
export const TARGET_CLASSES = [
  'infantry',
  'armor',
  'aircraft',
  'helicopter',
  'drone',
  'ship',
  'submarine',
  'missile',
  'building',
] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

/** Catalogues (pas des camps) : États-Unis, Russie, Chine, Europe, fournisseurs secondaires. */
export const DOCTRINES = ['us', 'ru', 'cn', 'eu', 'other'] as const;
export type Doctrine = (typeof DOCTRINES)[number];

export const CATEGORIES = [
  'fighter',
  'bomber',
  'air_support',
  'helicopter',
  'drone',
  'tank',
  'ifv',
  'artillery',
  'air_defense',
  'strike_missile',
  'nuclear',
  'surface_ship',
  'submarine',
  'infantry',
  'space',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Milieu de déplacement : détermine la navigation (grille terre, grille mer, grand cercle direct). */
export const MOVEMENT_KINDS = ['land', 'sea', 'air', 'static'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const RESOURCES = ['oil', 'metals', 'electronics', 'food'] as const;
export type Resource = (typeof RESOURCES)[number];

const nonNeg = z.number().min(0);

export const DamageTableSchema = z.object(
  Object.fromEntries(TARGET_CLASSES.map((c) => [c, nonNeg])) as Record<TargetClass, typeof nonNeg>,
);
export type DamageTable = z.infer<typeof DamageTableSchema>;

export const ResourceCostSchema = z
  .object(
    Object.fromEntries(RESOURCES.map((r) => [r, nonNeg.optional()])) as Record<
      Resource,
      z.ZodOptional<typeof nonNeg>
    >,
  )
  .strict();

/** Caractéristiques affichées dans la fiche d'arme (texte libre ou nombres, null si sans objet). */
export const WeaponSheetSchema = z.object({
  engine: z.string().nullable(),
  lengthM: z.number().nullable(),
  wingspanM: z.number().nullable(),
  mtowKg: z.number().nullable(),
  warheadKg: z.number().nullable(),
  speedLabel: z.string().nullable(),
  rangeKm: z.number().nullable(),
});
export type WeaponSheet = z.infer<typeof WeaponSheetSchema>;

export const WeaponSystemSchema = z.object({
  id: z.string().regex(/^[a-z]{2,5}\.[a-z0-9-]+$/, 'format attendu : doctrine.nom-en-minuscules'),
  name: z.string().min(1),
  doctrine: z.enum(DOCTRINES),
  /** Pays d'origine, ISO 3166-1 alpha-2. */
  origin: z.string().length(2),
  category: z.enum(CATEGORIES),
  roles: z.array(z.string()).default([]),
  /** 1 (ancien, bon marché) à 5 (dernière génération). */
  generation: z.number().int().min(1).max(5),
  /** Colonne de la matrice de dégâts qui s'applique quand CE système est la cible. */
  targetClass: z.enum(TARGET_CLASSES),
  movement: z.enum(MOVEMENT_KINDS),
  /** Peut capturer une province (unités terrestres de manœuvre). */
  canCapture: z.boolean().default(false),
  cost: z.object({ money: nonNeg, resources: ResourceCostSchema.default({}) }),
  buildTimeH: nonNeg,
  upkeepPerDay: nonNeg,
  speedKmh: nonNeg,
  /** Rayon d'action pour les aéronefs (aller simple jusqu'à la cible), null sinon. */
  operationalRadiusKm: nonNeg.nullable(),
  weaponRangeKm: z.object({ min: nonNeg, max: nonNeg }),
  /** Dégâts par round et par élément, selon la classe de la cible. */
  damage: DamageTableSchema,
  /** Points de vie par élément. */
  hp: z.number().positive(),
  /** Réduction des dégâts reçus, 0 à 0,9. */
  armor: z.number().min(0).max(0.9),
  /** 0 = aucune furtivité, 1 = invisible sauf capteurs spécialisés. Réduit la portée de détection ennemie. */
  stealth: z.number().min(0).max(1),
  detectionRangeKm: nonNeg,
  ew: z.object({ jamming: z.number().min(0).max(1), jamResistance: z.number().min(0).max(1) }),
  payload: z.object({
    slots: z.number().int().min(0),
    transport: z.number().int().min(0).optional(),
  }),
  /** Nombre d'éléments dans une unité produite. */
  unitSize: z.number().int().min(1).default(1),
  requires: z.array(z.string()).default([]),
  licensable: z.boolean(),
  exportable: z.boolean(),
  icon: z.string(),
  illustration: z.string().optional(),
  sheet: WeaponSheetSchema,
  enabled: z.boolean().default(true),
});
export type WeaponSystem = z.infer<typeof WeaponSystemSchema>;
export type WeaponSystemInput = z.input<typeof WeaponSystemSchema>;

export const CatalogFileSchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  systems: z.array(WeaponSystemSchema),
});
export type CatalogFile = z.infer<typeof CatalogFileSchema>;
