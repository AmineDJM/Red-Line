import { BalanceSchema, type MapData, type Order } from '@redline/shared';
import { applyOrder, buildWorld, type GameSetup, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { ds, type DiploState } from '../src/modules/diplo/state.js';
import { board } from '../src/modules/registry.js';
import { BALANCE, CATALOG, buildMap, sandbox } from './fixtures.js';

/** Monde de test avec surcharges d'équilibrage (sections diplomacy / stability validées par zod). */
export function diploWorld(over: Record<string, unknown> = {}, map?: MapData): World {
  const balance = BalanceSchema.parse({ ...BALANCE, ...over });
  return buildWorld(map ?? buildMap(), CATALOG, balance);
}

export function mapWithDisputed(area: {
  provinceIds: string[];
  claimants: string[];
  tension: number;
  revoltRate: number;
}): MapData {
  return { ...buildMap(), disputed: [{ id: 'zone', name: 'Zone disputée', ...area }] };
}

export function game(
  opts: {
    world?: World;
    units?: GameSetup['units'];
    players?: GameSetup['players'];
    seed?: number;
  } = {},
): EngineState {
  return sandbox(opts.units ?? [], {
    ...(opts.world ? { world: opts.world } : {}),
    ...(opts.players ? { players: opts.players } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  });
}

export function D(s: EngineState): DiploState {
  return ds(s);
}

export function B(s: EngineState) {
  return board(s);
}

/** Applique un ordre et exige son succès. */
export function ok(s: EngineState, n: string, o: Order): void {
  const r = applyOrder(s, n, o);
  if (!r.ok) throw new Error(`ordre refusé (${n} ${o.kind}) : ${r.error} ${r.message ?? ''}`);
}

export const CHARTER = { mutualDefense: true, intelSharing: true, passage: true };
