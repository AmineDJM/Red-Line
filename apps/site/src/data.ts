/**
 * Données du jeu lues au build depuis data/ (source du dépôt) : nations, provinces, ORBAT 2025, catalogue,
 * photos et scénarios. Les chiffres affichés (201 nations, 406 matériels…) en sont tous dérivés.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, type Category } from './content.js';
import { REPO } from './paths.js';

export interface Nation {
  id: string;
  iso: string;
  name: string;
  kind: string;
  capitalProvinceId?: string;
  /** Code ISO alpha-2 du drapeau (absent pour les entités sans drapeau). */
  iso2: string | null;
  budgetUsd: number | null;
  personnel: number | null;
  provinces: number;
}

export interface CatalogSystem {
  id: string;
  name: string;
  origin: string;
  category: Category;
  generation?: number;
  unitPriceUsd?: number;
  cost?: { money?: number };
  speedKmh?: number;
  era?: { introduced?: number };
  sheet?: { rangeKm?: number | null; speedLabel?: string | null };
  weaponRangeKm?: { max?: number };
  enabled?: boolean;
}

export interface Photo {
  file: string;
  thumb: string;
  credit: string;
  license: string;
  sourceUrl: string;
}

/** Entrée d'arsenal : matériels de même nom regroupés (versions génériques par doctrine). */
export interface ArsenalEntry {
  key: string;
  name: string;
  category: Category;
  origins: string[];
  generation: number | null;
  since: number | null;
  priceMin: number;
  priceMax: number;
  speedKmh: number | null;
  rangeKm: number | null;
  /** Nations qui l'alignent dans l'ORBAT 2025. */
  fielded: number;
  photo: Photo | null;
}

export interface GameData {
  nations: Nation[];
  /** Capitales (point de ville) par nation : animations de la carte d'accueil. */
  capitals: Record<string, [number, number]>;
  provinces: number;
  systems: number;
  scenarios: { id: string; year: number }[];
  arsenal: ArsenalEntry[];
  maxPlayers: number;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export function loadGameData(repo = REPO): GameData {
  const dataDir = join(repo, 'data');
  const nationsRaw = readJson<
    { id: string; iso: string; name: string; kind: string; capitalProvinceId?: string }[]
  >(join(dataDir, 'map/nations.json'));
  const flagCodes = readJson<Record<string, string>>(join(repo, 'packages/ui/src/flag-codes.json'));
  type Prov = {
    nationId: string;
    isCapital?: boolean;
    cityPoint?: [number, number];
    centroid?: [number, number];
  };
  const provRaw = readJson<{ provinces?: Prov[] } | Prov[]>(join(dataDir, 'map/provinces.json'));
  const provinces = Array.isArray(provRaw) ? provRaw : (provRaw.provinces ?? []);
  const provCount = new Map<string, number>();
  const capitals: Record<string, [number, number]> = {};
  for (const p of provinces) {
    provCount.set(p.nationId, (provCount.get(p.nationId) ?? 0) + 1);
    const pt = p.cityPoint ?? p.centroid;
    if (p.isCapital && pt) capitals[p.nationId] = pt;
  }

  // ORBAT 2025 : budgets, effectifs, et nations alignant chaque matériel.
  const orbatDir = join(dataDir, 'orbat/2025');
  const orbat = new Map<string, { budget: number | null; personnel: number | null }>();
  const fieldedBy = new Map<string, Set<string>>();
  if (existsSync(orbatDir)) {
    for (const f of readdirSync(orbatDir).filter((n) => n.endsWith('.json'))) {
      const o = readJson<{
        nationId: string;
        defenseBudgetUsd?: number;
        activePersonnel?: number;
        inventory?: { systemId: string; count: number }[];
      }>(join(orbatDir, f));
      orbat.set(o.nationId, {
        budget: o.defenseBudgetUsd ?? null,
        personnel: o.activePersonnel ?? null,
      });
      for (const it of o.inventory ?? []) {
        if (it.count <= 0) continue;
        const s = fieldedBy.get(it.systemId) ?? new Set<string>();
        s.add(o.nationId);
        fieldedBy.set(it.systemId, s);
      }
    }
  }

  const nations: Nation[] = nationsRaw.map((n) => ({
    id: n.id,
    iso: n.iso,
    name: n.name,
    kind: n.kind,
    ...(n.capitalProvinceId ? { capitalProvinceId: n.capitalProvinceId } : {}),
    iso2: flagCodes[n.id] ?? null,
    budgetUsd: orbat.get(n.id)?.budget ?? null,
    personnel: orbat.get(n.id)?.personnel ?? null,
    provinces: provCount.get(n.id) ?? 0,
  }));

  const photos = existsSync(join(dataDir, 'art/photos.json'))
    ? readJson<Record<string, Photo>>(join(dataDir, 'art/photos.json'))
    : {};
  const systems: CatalogSystem[] = [];
  for (const f of readdirSync(join(dataDir, 'catalog')).filter((n) => n.endsWith('.json'))) {
    const file = readJson<{ systems: CatalogSystem[] } | CatalogSystem[]>(
      join(dataDir, 'catalog', f),
    );
    for (const s of Array.isArray(file) ? file : file.systems) {
      if (s.enabled === false || !CATEGORIES.includes(s.category)) continue;
      systems.push(s);
    }
  }

  const groups = new Map<string, CatalogSystem[]>();
  for (const s of systems) {
    const k = `${s.category}|${s.name}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const arsenal: ArsenalEntry[] = [...groups.entries()].map(([key, list]) => {
    const prices = list.map((s) => s.unitPriceUsd ?? s.cost?.money ?? 0).filter((p) => p > 0);
    const first = list[0]!;
    const nationsFielding = new Set<string>();
    for (const s of list) for (const n of fieldedBy.get(s.id) ?? []) nationsFielding.add(n);
    const photo = list.map((s) => photos[s.id]).find(Boolean) ?? null;
    const years = list.map((s) => s.era?.introduced).filter((y): y is number => !!y);
    return {
      key,
      name: first.name,
      category: first.category,
      origins: [...new Set(list.map((s) => s.origin))],
      generation: first.generation ?? null,
      since: years.length ? Math.min(...years) : null,
      priceMin: prices.length ? Math.min(...prices) : 0,
      priceMax: prices.length ? Math.max(...prices) : 0,
      speedKmh: first.speedKmh && first.speedKmh < 30000 ? first.speedKmh : null,
      rangeKm: first.sheet?.rangeKm ?? first.weaponRangeKm?.max ?? null,
      fielded: nationsFielding.size,
      photo,
    };
  });

  const scenarios = readdirSync(join(dataDir, 'scenarios'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson<{ id: string; year: number }>(join(dataDir, 'scenarios', n)))
    .map((s) => ({ id: s.id, year: s.year }))
    .sort((a, b) => (a.id === 'world-today' ? -1 : b.id === 'world-today' ? 1 : b.year - a.year));

  return {
    nations,
    capitals,
    provinces: provinces.length,
    systems: systems.length,
    scenarios,
    arsenal,
    maxPlayers: 64,
  };
}
