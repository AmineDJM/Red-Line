import { describe, expect, it } from 'vitest';
import { DAY } from '@redline/shared';
import { advanceTo, createGame, viewFor, stateHash } from '../src/index.js';
import { testWorld } from './fixtures.js';

describe('smoke', () => {
  it('crée une partie et avance d’un jour', () => {
    const t0 = performance.now();
    const w = testWorld();
    const t1 = performance.now();
    const s = createGame(w, { seed: 42, players: [{ nationId: 'aaa', isAi: false }, { nationId: 'bbb', isAi: true, aiLevel: 'hard' }] });
    const t2 = performance.now();
    const notes = advanceTo(s, DAY);
    const t3 = performance.now();
    console.log('world', t1 - t0, 'create', t2 - t1, 'advance', t3 - t2, notes.length, Object.keys((s as any).units).length);
    const v = viewFor(s, 'aaa');
    expect(Object.keys(v.provinces).length).toBe(11);
    expect(stateHash(s)).toMatch(/^[0-9a-f]{16}$/);
  });
});
