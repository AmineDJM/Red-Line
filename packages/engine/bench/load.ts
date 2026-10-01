// Chargement des vraies données du dépôt (data/), comme le serveur (apps/server/src/data/loader.ts).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BalanceSchema,
  CatalogFileSchema,
  CellsFileSchema,
  DisputedAreaSchema,
  NationDefSchema,
  OrbatSchema,
  ProvinceDefSchema,
  ResearchFileSchema,
  ScenarioFileSchema,
  StraitSchema,
  type Balance,
  type MapData,
  type Orbat,
  type ResearchNode,
  type ScenarioFile,
  type WeaponSystem,
} from '@redline/shared';

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Fusion profonde (objets seulement ; tableaux et scalaires remplacés), comme le serveur. */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out as T;
}

export interface RealData {
  map: MapData;
  catalog: WeaponSystem[];
  balance: Balance;
  research: ResearchNode[];
  orbats: Record<string, Orbat[]>;
  scenario: ScenarioFile;
}

/** Dossier data/ du dépôt : REDLINE_DATA_DIR, sinon premier parent du répertoire courant qui le contient. */
function findDataDir(): string {
  if (process.env.REDLINE_DATA_DIR) return process.env.REDLINE_DATA_DIR;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'data/map/nations.json'))) return join(dir, 'data');
    const up = dirname(dir);
    if (up === dir) throw new Error('dossier data/ introuvable (REDLINE_DATA_DIR)');
    dir = up;
  }
}
export const DATA_DIR = findDataDir();

function listOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  return ((raw as Record<string, unknown>)[key] as unknown[]) ?? [];
}

export function loadRealData(scenarioId = 'world-today'): RealData {
  const root = DATA_DIR;
  const j = (p: string): unknown => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const map: MapData = {
    nations: listOf(j('map/nations.json'), 'nations').map((x) => NationDefSchema.parse(x)),
    provinces: listOf(j('map/provinces.json'), 'provinces').map((x) => ProvinceDefSchema.parse(x)),
    cells: CellsFileSchema.parse(j('map/cells.json')),
    straits: existsSync(join(root, 'map/straits.json'))
      ? listOf(j('map/straits.json'), 'straits').map((x) => StraitSchema.parse(x))
      : [],
    disputed: existsSync(join(root, 'map/disputed.json'))
      ? listOf(j('map/disputed.json'), 'disputed').map((x) => DisputedAreaSchema.parse(x))
      : [],
  };
  const catalog: WeaponSystem[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(join(root, 'catalog')).sort()) {
    if (!f.endsWith('.json')) continue;
    for (const s of CatalogFileSchema.parse(j(`catalog/${f}`)).systems) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      catalog.push(s);
    }
  }
  const scenario = ScenarioFileSchema.parse(j(`scenarios/${scenarioId}.json`));
  // Surcharges d'équilibrage du scénario, comme le serveur (game-host.ts, balanceFor).
  const balance = BalanceSchema.parse(
    deepMerge(BalanceSchema.parse(j('balance/default.json')), scenario.balanceOverrides),
  );
  // BENCH_STACKS=off : regroupement de départ désactivé (mesures « avant » : piles d'un seul matériel).
  if (process.env.BENCH_STACKS === 'off') {
    const st = (balance.stacks ?? {}) as { start?: Record<string, unknown> };
    balance.stacks = { ...st, start: { ...st.start, enabled: false } } as typeof balance.stacks;
  }
  const research: ResearchNode[] = [];
  for (const f of readdirSync(join(root, 'research')).sort()) {
    if (f.endsWith('.json')) research.push(...ResearchFileSchema.parse(j(`research/${f}`)).nodes);
  }
  const orbats: Record<string, Orbat[]> = {};
  for (const set of readdirSync(join(root, 'orbat')).sort()) {
    if (!statSync(join(root, 'orbat', set)).isDirectory()) continue;
    orbats[set] = readdirSync(join(root, 'orbat', set))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => OrbatSchema.parse(j(`orbat/${set}/${f}`)));
  }
  return { map, catalog, balance, research, orbats, scenario };
}
