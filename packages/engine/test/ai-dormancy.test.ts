import { describe, expect, it } from 'vitest';
import { applySystem, serializeState, deserializeState } from '../src/index.js';
import { awakeNations } from '../src/ai/ai.js';
import { declareWar } from '../src/state/war.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, sandbox, worldWith } from './fixtures.js';

const world = worldWith({ time: { ...BALANCE.time, dormancyRadiusKm: 800 } });
const game = () =>
  sandbox([], {
    world,
    players: [
      { nationId: 'aaa', isAi: false },
      { nationId: 'bbb', isAi: true },
      { nationId: 'ccc', isAi: true },
      { nationId: 'ddd', isAi: true },
    ],
  });

describe('veille des IA lointaines (aucun joueur humain connecté)', () => {
  it('sans veille, toutes les IA réfléchissent', () => {
    expect(awakeNations(game())).toBeNull();
  });

  it('en veille : seules les IA proches du joueur ou en guerre avec lui réfléchissent', () => {
    const s = game();
    expect(applySystem(s, { kind: 'dormancy', on: true }).ok).toBe(true);
    let awake = awakeNations(s)!;
    expect(awake.has('ccc')).toBe(true); // voisins
    expect(awake.has('bbb')).toBe(true);
    expect(awake.has('ddd')).toBe(false); // île à plus de 800 km, en paix
    declareWar(s, 'ddd', 'aaa');
    awake = awakeNations(s)!;
    expect(awake.has('ddd')).toBe(true); // en guerre avec le joueur : jamais en veille
  });

  it('le drapeau survit à la sauvegarde et se lève au retour du joueur', () => {
    const s = game();
    applySystem(s, { kind: 'dormancy', on: true });
    const r = deserializeState(world, serializeState(s)) as EngineState;
    expect(awakeNations(r)).not.toBeNull();
    applySystem(r, { kind: 'dormancy', on: false });
    expect(awakeNations(r)).toBeNull();
  });
});
