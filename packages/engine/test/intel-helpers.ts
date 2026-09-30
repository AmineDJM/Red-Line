import {
  BalanceSchema,
  type BuildingType,
  type IntelOpKind,
  type IntelOpTarget,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  type GameSetup,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { ist } from '../src/modules/intel/state.js';
import { BALANCE, CATALOG, buildMap } from './fixtures.js';

/** Installations génériques ajoutées à la carte de test (provinces de bbb). */
export const BBB2: BuildingType[] = [
  'military_base',
  'air_base',
  'naval_base',
  'radar_station',
  'missile_silo',
  'refinery',
  'farm',
  'power_plant',
  'research_center',
];
export const BBB5: BuildingType[] = ['port', 'air_defense_site', 'oil_field', 'arms_factory'];

let cached: World | null = null;

/** Monde de test avec des installations et la section `intel` de l'équilibrage (valeurs par défaut). */
export function intelWorld(): World {
  if (cached) return cached;
  const map = buildMap();
  const provinces = map.provinces.map((p) =>
    p.id === 'bbb-2'
      ? { ...p, buildings: [...BBB2] }
      : p.id === 'bbb-5'
        ? { ...p, buildings: [...BBB5] }
        : p,
  );
  // Répartition des bâtiments de ressources du module eco désactivée : listes de bâtiments exactes.
  const balance = BalanceSchema.parse({
    ...BALANCE,
    intel: { flashBorderKm: 300 },
    buildings: { distribute: false },
  });
  cached = buildWorld({ ...map, provinces }, CATALOG, balance);
  return cached;
}

/** Partie de test : aaa et bbb humains, ccc et ddd IA ; tout le monde est riche. */
export function intelGame(
  units: GameSetup['units'] = [],
  opts: { seed?: number; players?: GameSetup['players'] } = {},
): EngineState {
  const s = createGame(intelWorld(), {
    seed: opts.seed ?? 7,
    players: opts.players ?? [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: false },
      { nationId: 'ccc', isAi: true },
      { nationId: 'ddd', isAi: true },
    ],
    units,
  }) as EngineState;
  for (const n of s.nationIds) s.nations[n]!.money = 1e10;
  return s;
}

/**
 * Lance une opération par ordre et fixe son issue (probabilité 1 ou 0) : test déterministe de chaque
 * branche sans dépendre du tirage.
 */
export function runOp(
  s: EngineState,
  n: string,
  op: IntelOpKind,
  target: IntelOpTarget,
  outcome: 'success' | 'failure' | 'natural' = 'success',
): string {
  const r = applyOrder(s, n, { kind: 'intelOp', op, target });
  if (!r.ok) throw new Error(`${op} refusée : ${r.message}`);
  const ops = ist(s).nations[n]!.ops;
  const o = ops[ops.length - 1]!;
  if (outcome !== 'natural') o.estimate = outcome === 'success' ? 1 : 0;
  advanceTo(s, o.completesAt);
  return o.id;
}

export function opStatus(s: EngineState, n: string, id: string): string | undefined {
  return ist(s).nations[n]!.ops.find((o) => o.id === id)?.status;
}
