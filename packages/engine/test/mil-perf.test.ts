import { describe, expect, it } from 'vitest';
import { DAY, destination } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  serializeState,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
import { BALANCE } from './fixtures.js';
import { MIL_CATALOG } from './mil-fixtures.js';
import { worldScaleMap } from './world-scale.js';

/**
 * Monde synthétique ≈ 5 000 unités (chasseurs à carburant au sol, avions radar, navires, radars,
 * défenses antimissiles, stocks de missiles) : une journée calme doit rester sous 500 ms.
 */
describe('performance du module militaire (monde entier ≈ 5 000 unités)', () => {
  it('un jour calme < 500 ms ; journée de guerre mesurée', { timeout: 300_000 }, () => {
    const log: string[] = [];
    const map = worldScaleMap();
    const army = [
      { systemId: 'tst.infantry', count: 3 },
      { systemId: 'tst.tank', count: 2 },
      { systemId: 'tst.artillery', count: 1 },
      { systemId: 'tst.sam', count: 1 },
      { systemId: 'tst.patriot', count: 1 },
      { systemId: 'tst.jet', count: 2 },
      { systemId: 'tst.awacs', count: 1 },
      { systemId: 'tst.destroyer', count: 1 },
      { systemId: 'tst.radar', count: 1 },
      { systemId: 'tst.cruise', count: 1 },
    ];
    const world = buildWorld(map, MIL_CATALOG, {
      ...BALANCE,
      startingArmy: army,
      garrisonArmy: army,
    });
    const nations = map.nations.map((n) => n.id);
    let t = performance.now();
    const s = createGame(world, {
      seed: 1,
      players: [
        { nationId: nations[0]!, isAi: false },
        { nationId: nations[10]!, isAi: true, aiLevel: 'hard' },
        { nationId: nations[20]!, isAi: true, aiLevel: 'hard' },
        { nationId: nations[30]!, isAi: true, aiLevel: 'normal' },
      ],
    }) as EngineState;
    const units = Object.keys(s.units).length;
    log.push(
      `createGame : ${(performance.now() - t).toFixed(0)} ms, ${units} unités, ${Object.keys(s.pairs).length} paires`,
    );
    expect(units).toBeGreaterThan(4500);

    t = performance.now();
    advanceTo(s, DAY);
    const calm = performance.now() - t;
    log.push(`advanceTo 1 jour calme : ${calm.toFixed(0)} ms`);

    // Journée de guerre : 300 déplacements, 60 patrouilles aériennes, 40 salves de missiles.
    const rng = seedRng(9);
    const ids = Object.keys(s.units).sort();
    let moves = 0;
    let patrols = 0;
    let salvos = 0;
    t = performance.now();
    for (let i = 0; i < 2000 && (moves < 300 || patrols < 60 || salvos < 40); i++) {
      const id = ids[Math.floor(nextFloat(rng) * ids.length)]!;
      const u = s.units[id];
      if (!u || u.off) continue;
      const to = destination(u.pos, nextFloat(rng) * 360, 150 + nextFloat(rng) * 350);
      if (u.sys === 'tst.jet' && patrols < 60) {
        if (applyOrder(s, u.owner, { kind: 'patrol', unitIds: [id], at: to, radiusKm: 100 }).ok)
          patrols++;
      } else if (u.sys === 'tst.cruise' && salvos < 40) {
        if (
          applyOrder(s, u.owner, {
            kind: 'strike',
            unitIds: [id],
            target: { type: 'point', at: to },
          }).ok
        )
          salvos++;
      } else if (moves < 300) {
        if (applyOrder(s, u.owner, { kind: 'move', unitIds: [id], to }).ok) moves++;
      }
    }
    log.push(
      `${moves} déplacements, ${patrols} patrouilles, ${salvos} salves : ${(performance.now() - t).toFixed(0)} ms`,
    );
    t = performance.now();
    advanceTo(s, 2 * DAY);
    const busy = performance.now() - t;
    log.push(
      `advanceTo 1 jour de guerre : ${busy.toFixed(0)} ms, ${Object.keys(s.wars).length} guerres`,
    );
    t = performance.now();
    advanceTo(s, 3 * DAY);
    log.push(`advanceTo jour suivant : ${(performance.now() - t).toFixed(0)} ms`);
    t = performance.now();
    for (let i = 0; i < 20; i++) viewFor(s, nations[i]!);
    log.push(`viewFor (moyenne sur 20 nations) : ${((performance.now() - t) / 20).toFixed(1)} ms`);
    t = performance.now();
    const bytes = serializeState(s);
    log.push(
      `serializeState : ${(performance.now() - t).toFixed(0)} ms, ${(bytes.length / 1024).toFixed(0)} Kio`,
    );
    console.log(log.join('\n'));
    expect(calm).toBeLessThan(500);
    // Journée de guerre : mesurée (dominée par l’IA stratégique et les trajets), borne large.
    expect(busy).toBeLessThan(60000);
  });
});
