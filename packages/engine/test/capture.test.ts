import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, movementEnd } from '@redline/shared';
import { advanceTo, applyOrder, createGame, viewFor } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { atWar } from '../src/state/access.js';
import { cityOf, sandbox, worldWith } from './fixtures.js';

describe('capture de province', () => {
  it('de bout en bout : entrée, guerre, arrivée, capture en captureMinutes', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.7, 40] },
      { owner: 'aaa', systemId: 'tst.tank', pos: [4.7, 40.1] },
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('bbb-4') }).ok).toBe(true);
    const arrival = movementEnd(s.units.u1!.move!);
    let notes = advanceTo(s, arrival + 1);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    const started = notes.find((n) => n.kind === 'province_capture_started');
    expect(started).toMatchObject({ provinceId: 'bbb-4', by: 'aaa' });
    expect(s.provinces['bbb-4']!.capture!.completesAt).toBe(arrival + 60 * MINUTE);
    const v = viewFor(s, 'aaa');
    expect(v.provinces['bbb-4']!.capture).toMatchObject({ by: 'aaa' });
    expect(viewFor(s, 'ccc').provinces['bbb-4']!.capture).toBeNull();
    notes = advanceTo(s, arrival + 61 * MINUTE);
    expect(notes.find((n) => n.kind === 'province_captured')).toMatchObject({
      provinceId: 'bbb-4',
      by: 'aaa',
      from: 'bbb',
    });
    expect(s.provinces['bbb-4']!.owner).toBe('aaa');
    expect(s.nations.aaa!.provinceCount).toBe(4);
    expect(s.nations.bbb!.provinceCount).toBe(4);
  });

  it('interrompue quand un défenseur terrestre arrive, reprise ensuite', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.7, 40] },
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.7, 40] },
    ]);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('bbb-4') });
    const arrival = movementEnd(s.units.u1!.move!);
    advanceTo(s, arrival + 10 * MINUTE);
    expect(s.provinces['bbb-4']!.capture).not.toBeNull();
    // Le défenseur passe en posture 'hold' pour ne pas se battre, et rentre en ville.
    applyOrder(s, 'bbb', { kind: 'stance', unitIds: ['u2'], stance: 'hold' });
    applyOrder(s, 'aaa', { kind: 'stance', unitIds: ['u1'], stance: 'hold' });
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: [7.55, 40] });
    advanceTo(s, arrival + 2 * HOUR);
    expect(s.provinces['bbb-4']!.owner).toBe('bbb');
    expect(s.provinces['bbb-4']!.capture).toBeNull();
    // Le défenseur repart : la capture recommence.
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: [9.5, 41] });
    advanceTo(s, arrival + 5 * HOUR);
    expect(s.provinces['bbb-4']!.owner).toBe('aaa');
  });

  it('pas de capture sans guerre, ni par une unité en mouvement, ni par une unité non capturante', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.sam', pos: cityOf('bbb-4') },
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.7, 40] },
    ]);
    advanceTo(s, 3 * HOUR);
    expect(s.provinces['bbb-4']!.capture).toBeNull(); // pas en guerre
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u2'], to: [9.9, 40] }); // traverse la ville
    advanceTo(s, 10 * HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(s.provinces['bbb-4']!.owner).toBe('bbb'); // SAM non capturant, infanterie passée
  });

  it('victoire et défaite d’une nation', () => {
    const w = worldWith({ victory: { provinceShare: 0.7, allEnemyCapitals: false } });
    const s = createGame(w, {
      seed: 3,
      players: [{ nationId: 'aaa', isAi: false }],
      nationIds: ['aaa', 'ddd'],
      units: [{ owner: 'aaa', systemId: 'tst.infantry', pos: [24.2, 43.5] }],
    }) as EngineState;
    expect(s.totalProvinces).toBe(4);
    expect(Object.keys(viewFor(s, 'aaa').nations).sort()).toEqual(['aaa', 'ddd']);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('ddd-1') });
    const notes = advanceTo(s, DAY);
    expect(notes.find((n) => n.kind === 'nation_defeated')).toMatchObject({ nationId: 'ddd' });
    expect(notes.find((n) => n.kind === 'victory')).toMatchObject({ winner: 'aaa' });
    expect(s.nations.ddd!.alive).toBe(false);
    expect(viewFor(s, 'aaa').victory).toMatchObject({ winner: 'aaa', leader: 'aaa' });
    expect(applyOrder(s, 'aaa', { kind: 'stop', unitIds: ['u1'] })).toMatchObject({ error: 'game_over' });
  });

  it('victoire par les capitales ennemies', () => {
    const w = worldWith({ victory: { provinceShare: 0.99, allEnemyCapitals: true } });
    const s = createGame(w, {
      seed: 3,
      players: [{ nationId: 'aaa', isAi: false }],
      nationIds: ['aaa', 'ccc'],
      units: [{ owner: 'aaa', systemId: 'tst.infantry', pos: [5.2, 47.8] }],
    }) as EngineState;
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('ccc-1') });
    const notes = advanceTo(s, DAY);
    expect(s.provinces['ccc-1']!.owner).toBe('aaa');
    expect(s.nations.ccc!.alive).toBe(true);
    expect(notes.find((n) => n.kind === 'victory')).toMatchObject({ winner: 'aaa' });
  });
});
