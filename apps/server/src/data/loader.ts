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
  ProvinceDefSchema,
  StraitSchema,
  type Balance,
  type MapData,
  type NationDef,
  type ScenarioSummary,
  type WeaponSystem,
} from '@redline/shared';
import type { FastifyBaseLogger } from 'fastify';

/** Fichier de scénario (data/scenarios/*.json). Seuls id, name, description, playableNations sont exposés. */
export const ScenarioFileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    playableNations: z.union([z.literal('all'), z.array(z.string())]).default('all'),
    /** Sous-ensemble de nations de la partie (scénarios régionaux). Absent = toutes. */
    nationIds: z.array(z.string()).optional(),
  })
  .passthrough();
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export const DEFAULT_SCENARIO: ScenarioFile = {
  id: 'world-today',
  name: "Le monde d'aujourd'hui",
  description:
    'Toutes les nations du monde actuel. Choisissez la vôtre ; les autres sont tenues par des IA.',
  playableNations: 'all',
};

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
  return { nations, provinces, cells, straits, disputed };
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
        data.scenarios.push(ScenarioFileSchema.parse(await readJson(join(scDir, name))));
      } catch (e) {
        log.warn(`scénario ${name} ignoré : ${errMsg(e)}`);
      }
    }
  }
  if (data.scenarios.length === 0) data.scenarios.push(DEFAULT_SCENARIO);

  return data;
}

export function scenarioSummary(s: ScenarioFile): ScenarioSummary {
  return { id: s.id, name: s.name, description: s.description, playableNations: s.playableNations };
}
