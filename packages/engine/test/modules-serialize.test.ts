import { describe, expect, it } from 'vitest';
import { deserializeState, serializeState, stateHash } from '../src/index.js';
import { board } from '../src/modules/kit.js';
import type { EngineState } from '../src/state/types.js';
import { sandbox, testWorld } from './fixtures.js';

describe('états des modules', () => {
  it('sont sérialisés et restaurés avec la partie', () => {
    const world = testWorld();
    const state = sandbox([]);
    const s = state;
    board(s).tension = 42;
    (s.mods as Record<string, unknown>).eco = { marker: 7 };
    const back = deserializeState(world, serializeState(state)) as unknown as EngineState;
    expect(board(back).tension).toBe(42);
    expect((back.mods as Record<string, unknown>).eco).toEqual({ marker: 7 });
    expect(stateHash(back)).toBe(stateHash(state));
  });
});
