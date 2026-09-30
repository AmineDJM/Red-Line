// Chargement des vraies données du dépôt (data/), comme le serveur (apps/server/src/data/loader.ts).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export interface RealData {
  map: MapData;
  catalog: WeaponSystem[];
  balance: Balance;
  research: ResearchNode[];
  orbats: Record<string, Orbat[]>;
  scenario: ScenarioFile;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, '../../../data');

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
  const balance = BalanceSchema.parse(j('balance/default.json'));
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
  const scenario = ScenarioFileSchema.parse(j(`scenarios/${scenarioId}.json`));
  return { map, catalog, balance, research, orbats, scenario };
}
