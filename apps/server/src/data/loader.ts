import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  BalanceSchema,
  CatalogFileSchema,
  CellsFileSchema,
  DisputedAreaSchema,
  NationDefSchema,
  OrbatSchema,
  ProvinceDefSchema,
  ResearchFileSchema,
  RoutesFileSchema,
  ScenarioFileSchema as SharedScenarioFileSchema,
  StraitSchema,
  type Balance,
  type MapData,
  type NationDef,
  type Orbat,
  type ResearchNode,
  type ScenarioFile,
  type ScenarioSummary,
  type WeaponSystem,
} from '@redline/shared';
import type { FastifyBaseLogger } from 'fastify';

export type { ScenarioFile };

/**
 * Fichier de scénario (data/scenarios/*.json), schéma partagé. Tolérant : description vide et
 * « toutes les nations » par défaut pour les fichiers minimaux.
 */
export const ScenarioFileSchema = SharedScenarioFileSchema.extend({
  description: z.string().default(''),
  playableNations: z.union([z.literal('all'), z.array(z.string())]).default('all'),
});

export const DEFAULT_SCENARIO: ScenarioFile = {
  id: 'world-today',
  name: "Le monde d'aujourd'hui",
  description:
    'Toutes les nations du monde actuel. Choisissez la vôtre ; les autres sont tenues par des IA.',
  playableNations: 'all',
  year: 2025,
  orbatSet: '2025',
};

/** Manifeste des photos réelles (data/art/photos.json) : systemId → fichier, crédit, licence. */
export const PhotoEntrySchema = z
  .object({
    file: z.string(),
    credit: z.string(),
    license: z.string(),
    sourceUrl: z.string(),
  })
  .passthrough();
export const PhotoManifestSchema = z.record(z.string(), PhotoEntrySchema);
export type PhotoManifest = z.infer<typeof PhotoManifestSchema>;

export interface StaticAsset {
  body: Buffer;
  gzip: Buffer;
  etag: string;
}

export interface GameData {
  dataDir: string;
  map: MapData | null;
  mapError: string | null;
  nationsById: Map<string, NationDef>;
  balance: Balance | null;
  balanceHash: string | null;
  balanceError: string | null;
  /** Fiches des fichiers data/catalog/*.json (source du dépôt). */
  repoCatalog: WeaponSystem[];
  catalogErrors: string[];
  provincesGeojson: StaticAsset | null;
  scenarios: ScenarioFile[];
  // ——— Phases 2+ (fichiers facultatifs, produits par d'autres équipes) ———
  /** Nœuds de recherche (data/research/*.json). */
  research: ResearchNode[];
  /** ORBAT par jeu (data/orbat/<set>/*.json). */
  orbats: Record<string, Orbat[]>;
  /** Manifeste des photos (data/art/photos.json). */
  photos: PhotoManifest;
  /** Erreurs non bloquantes rencontrées au chargement (affichées dans le back-office). */
  warnings: string[];
}

function errMsg(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(' ; ');
  }
  return e instanceof Error ? e.message : String(e);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Accepte un tableau, ou un objet { <clé>: [...] }. */
function listOf<T>(raw: unknown, keys: string[], schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
  let arr: unknown = raw;
  if (!Array.isArray(raw) && raw && typeof raw === 'object') {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }
  return z.array(schema).parse(arr);
}

export function asset(body: Buffer): StaticAsset {
  return {
    body,
    gzip: gzipSync(body, { level: 6 }),
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
  };
}

export function hashJson(v: unknown): string {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

async function loadMap(dir: string): Promise<MapData> {
  const f = (n: string) => join(dir, n);
  const required = ['nations.json', 'provinces.json', 'cells.json'];
  const missing = required.filter((n) => !existsSync(f(n)));
  if (missing.length) throw new Error(`fichiers absents dans ${dir} : ${missing.join(', ')}`);
  const nations = listOf(await readJson(f('nations.json')), ['nations'], NationDefSchema);
  const provinces = listOf(await readJson(f('provinces.json')), ['provinces'], ProvinceDefSchema);
  const cells = CellsFileSchema.parse(await readJson(f('cells.json')));
  const straits = existsSync(f('straits.json'))
    ? listOf(await readJson(f('straits.json')), ['straits'], StraitSchema)
    : [];
  const disputed = existsSync(f('disputed.json'))
    ? listOf(await readJson(f('disputed.json')), ['disputed', 'areas'], DisputedAreaSchema)
    : [];
  // Réseau de routes des unités terrestres (sans lui : déplacement libre sur la grille).
  const routes = existsSync(f('routes.json'))
    ? RoutesFileSchema.parse(await readJson(f('routes.json')))
    : undefined;
  return { nations, provinces, cells, straits, disputed, ...(routes ? { routes } : {}) };
}

export async function loadGameData(dataDir: string, log: FastifyBaseLogger): Promise<GameData> {
  const data: GameData = {
    dataDir,
    map: null,
    mapError: null,
    nationsById: new Map(),
    balance: null,
    balanceHash: null,
    balanceError: null,
    repoCatalog: [],
    catalogErrors: [],
    provincesGeojson: null,
    scenarios: [],
    research: [],
    orbats: {},
    photos: {},
    warnings: [],
  };
  const warn = (msg: string) => {
    data.warnings.push(msg);
    log.warn(msg);
  };

  // Carte
  try {
    data.map = await loadMap(join(dataDir, 'map'));
    data.nationsById = new Map(data.map.nations.map((n) => [n.id, n]));
    log.info(
      { nations: data.map.nations.length, provinces: data.map.provinces.length },
      'carte chargée',
    );
  } catch (e) {
    data.mapError = `Carte indisponible : ${errMsg(e)}`;
    log.warn(data.mapError);
  }

  const geo = join(dataDir, 'map', 'provinces.geojson');
  if (existsSync(geo)) {
    try {
      data.provincesGeojson = asset(await readFile(geo));
    } catch (e) {
      log.warn(`provinces.geojson illisible : ${errMsg(e)}`);
    }
  }

  // Équilibrage
  const balancePath = join(dataDir, 'balance', 'default.json');
  try {
    if (!existsSync(balancePath)) throw new Error(`fichier absent : ${balancePath}`);
    data.balance = BalanceSchema.parse(await readJson(balancePath));
    data.balanceHash = hashJson(data.balance);
  } catch (e) {
    data.balanceError = `Équilibrage indisponible : ${errMsg(e)}`;
    log.warn(data.balanceError);
  }

  // Catalogue du dépôt
  const catDir = join(dataDir, 'catalog');
  if (existsSync(catDir)) {
    const files = (await readdir(catDir)).filter((n) => n.endsWith('.json')).sort();
    const seen = new Set<string>();
    for (const name of files) {
      try {
        const file = CatalogFileSchema.parse(await readJson(join(catDir, name)));
        for (const s of file.systems) {
          if (seen.has(s.id)) {
            data.catalogErrors.push(`${name} : identifiant en double ${s.id}`);
            continue;
          }
          seen.add(s.id);
          data.repoCatalog.push(s);
        }
      } catch (e) {
        data.catalogErrors.push(`${name} : ${errMsg(e)}`);
      }
    }
    for (const err of data.catalogErrors) log.warn(`catalogue : ${err}`);
  }

  // Scénarios
  const scDir = join(dataDir, 'scenarios');
  if (existsSync(scDir)) {
    const files = (await readdir(scDir)).filter((n) => n.endsWith('.json')).sort();
    for (const name of files) {
      try {
        const sc = ScenarioFileSchema.parse(await readJson(join(scDir, name)));
        if (data.scenarios.some((s) => s.id === sc.id)) warn(`scénario ${name} : id en double`);
        else data.scenarios.push(sc);
      } catch (e) {
        warn(`scénario ${name} ignoré : ${errMsg(e)}`);
      }
    }
  }
  if (data.scenarios.length === 0) data.scenarios.push(DEFAULT_SCENARIO);

  // Recherche
  const rsDir = join(dataDir, 'research');
  if (existsSync(rsDir)) {
    const seen = new Set<string>();
    for (const name of (await readdir(rsDir)).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const file = ResearchFileSchema.parse(await readJson(join(rsDir, name)));
        for (const n of file.nodes) {
          if (seen.has(n.id)) {
            warn(`recherche ${name} : nœud en double ${n.id}`);
            continue;
          }
          seen.add(n.id);
          data.research.push(n);
        }
      } catch (e) {
        warn(`recherche ${name} ignorée : ${errMsg(e)}`);
      }
    }
  }

  // ORBAT : data/orbat/<set>/<nation>.json
  const obDir = join(dataDir, 'orbat');
  if (existsSync(obDir)) {
    for (const set of (await readdir(obDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()) {
      const list: Orbat[] = [];
      for (const name of (await readdir(join(obDir, set)))
        .filter((n) => n.endsWith('.json'))
        .sort()) {
        try {
          list.push(OrbatSchema.parse(await readJson(join(obDir, set, name))));
        } catch (e) {
          warn(`ORBAT ${set}/${name} ignoré : ${errMsg(e)}`);
        }
      }
      data.orbats[set] = list;
    }
  }

  // Photos
  const photosPath = join(dataDir, 'art', 'photos.json');
  if (existsSync(photosPath)) {
    try {
      const raw = (await readJson(photosPath)) as Record<string, unknown>;
      // Accepte { photos: {...} } ou directement le dictionnaire.
      const dict =
        raw && typeof raw === 'object' && raw.photos && typeof raw.photos === 'object'
          ? raw.photos
          : raw;
      const parsed: PhotoManifest = {};
      for (const [id, v] of Object.entries(dict as Record<string, unknown>)) {
        const r = PhotoEntrySchema.safeParse(v);
        if (r.success) parsed[id] = r.data;
      }
      data.photos = parsed;
    } catch (e) {
      warn(`photos.json illisible : ${errMsg(e)}`);
    }
  }

  log.info(
    {
      research: data.research.length,
      orbatSets: Object.fromEntries(Object.entries(data.orbats).map(([k, v]) => [k, v.length])),
      photos: Object.keys(data.photos).length,
      scenarios: data.scenarios.length,
    },
    'données de jeu chargées',
  );
  return data;
}

export function scenarioSummary(s: ScenarioFile): ScenarioSummary {
  return { id: s.id, name: s.name, description: s.description, playableNations: s.playableNations };
}
