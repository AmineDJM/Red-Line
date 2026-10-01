import { z } from 'zod';
import { RESOURCES } from './catalog.js';
import { FrArticleSchema } from './french.js';

/** Bâtiments stratégiques génériques (jamais de sites réels nommés). */
export const BUILDING_TYPES = [
  'refinery',
  'power_plant',
  'port',
  'air_base',
  'military_base',
  'arms_factory',
  'research_center',
  // ——— Phases 2+ : bâtiments façon Conflict of Nations (tous génériques, jamais de sites réels) ———
  /** Production de ressources. */
  'oil_field',
  'mine',
  'farm',
  'electronics_plant',
  'local_industry',
  /** Militaires et défense. */
  'recruiting_office',
  'naval_base',
  'bunker',
  'air_defense_site',
  'coastal_battery',
  'radar_station',
  'missile_silo',
  'hospital',
  'secret_lab',
  'forward_base',
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const NationDefSchema = z.object({
  id: z.string(), // iso3 en minuscules, ou identifiant d'entité ("gaza", "pse")
  iso: z.string(), // ISO alpha-3 ou code d'entité
  name: z.string(),
  /** Article défini français (« le » Maroc, « l' » Algérie, « » pour Cuba) : voir french.ts. */
  article: FrArticleSchema.optional(),
  kind: z.enum(['state', 'entity']),
  /** Couleur de teinte, hex "#rrggbb". */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  capitalProvinceId: z.string(),
});
export type NationDef = z.infer<typeof NationDefSchema>;

export const ProvinceDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Propriétaire au début d'un scénario « monde actuel ». */
  nationId: z.string(),
  centroid: lngLat,
  /** Point de la ville principale : c'est là qu'on capture la province. */
  cityPoint: lngLat,
  isCapital: z.boolean().default(false),
  coastal: z.boolean().default(false),
  /** Production journalière par ressource, plus l'argent. */
  income: z.object({
    money: z.number().min(0),
    ...(Object.fromEntries(RESOURCES.map((r) => [r, z.number().min(0).optional()])) as Record<
      (typeof RESOURCES)[number],
      z.ZodOptional<z.ZodNumber>
    >),
  }),
  buildings: z.array(z.enum(BUILDING_TYPES)).default([]),
  neighbors: z.array(z.string()).default([]),
  /** Superficie approximative en km², pour l'équilibrage. */
  areaKm2: z.number().min(0),
  /** Nom de la ville principale (affiché sur la carte). */
  cityName: z.string().optional(),
  /** Rang de la ville : 1 capitale, 2 grande ville, 3 ville moyenne, 4 petite ville. */
  cityRank: z.number().int().min(1).max(4).optional(),
  /** Population estimée de la province (habitants). */
  population: z.number().min(0).optional(),
});
export type ProvinceDef = z.infer<typeof ProvinceDefSchema>;

/** Grille H3 : cellule terrestre → province. Toute cellule absente est de la mer. */
export const CellsFileSchema = z.object({
  res: z.number().int(),
  cells: z.record(z.string(), z.string()),
  /** Cellules terrestres sans propriétaire (Antarctique, zones tampons) : infranchissables. */
  impassable: z.array(z.string()).optional(),
});
export type CellsFile = z.infer<typeof CellsFileSchema>;

/** Détroits et canaux : cellules marines ajoutées à la grille de navigation navale. */
export const StraitSchema = z.object({
  id: z.string(),
  name: z.string(),
  seaCells: z.array(z.string()),
});
export type Strait = z.infer<typeof StraitSchema>;

export const DisputedAreaSchema = z.object({
  id: z.string(),
  name: z.string(),
  provinceIds: z.array(z.string()),
  claimants: z.array(z.string()),
  /** Jauge de tension de base, 0 à 100. */
  tension: z.number().min(0).max(100),
  /** Probabilité relative de révolte par jour de jeu (phase 4). */
  revoltRate: z.number().min(0),
});
export type DisputedArea = z.infer<typeof DisputedAreaSchema>;

/** Toutes les données statiques de la carte (sans géométrie des provinces). */
export interface MapData {
  nations: NationDef[];
  provinces: ProvinceDef[];
  cells: CellsFile;
  straits: Strait[];
  disputed: DisputedArea[];
}
