import { describe, expect, it } from 'vitest';
import { DAY, destination } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  stateHash,
  viewFor,
  serializeState,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, CATALOG } from './fixtures.js';
import { worldScaleMap } from './world-scale.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';

/**
 * Mesures à l'échelle du monde (~250 nations, ~1 800 provinces, ~1 000 unités). Les seuils des
 * assertions sont larges (machines de CI) ; les valeurs mesurées sont affichées.
 */
describe('performance (monde entier)', () => {
  it(
    'construction, chemin transcontinental, advanceTo d’un jour, viewFor',
    { timeout: 300_000 },
    () => {
      const log: string[] = [];
      let t = performance.now();
      const map = worldScaleMap();
      log.push(
        `carte synthétique : ${map.nations.length} nations, ${map.provinces.length} provinces, ${Object.keys(map.cells.cells).length} cellules terrestres (${(performance.now() - t).toFixed(0)} ms)`,
      );
      t = performance.now();
      const balance = {
        ...BALANCE,
        startingArmy: [
          { systemId: 'tst.infantry', count: 2 },
          { systemId: 'tst.tank', count: 1 },
          { systemId: 'tst.fighter', count: 1 },
        ],
        garrisonArmy: [
          { systemId: 'tst.infantry', count: 2 },
          { systemId: 'tst.sam', count: 1 },
          { systemId: 'tst.tank', count: 1 },
        ],
      };
      const world = buildWorld(map, CATALOG, balance);
      const tWorld = performance.now() - t;
      log.push(`buildWorld : ${tWorld.toFixed(0)} ms`);

      const nations = map.nations.map((n) => n.id);
      t = performance.now();
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
      expect(units).toBeGreaterThan(900);

      // Chemin transcontinental terrestre (≈ 6 000 km sur le grand continent de l'est).
      const u = s.units.u1!;
      s.units.u1 = { ...u, sys: 'tst.tank' };
      const from = [60, 35] as [number, number];
      const to = [115, 50] as [number, number];
      s.units.u1!.pos = from;
      const own = s.units.u1!.owner;
      s.rt.geom.delete('u1');
      t = performance.now();
      const r = applyOrder(s, own, { kind: 'move', unitIds: ['u1'], to });
      const tPath = performance.now() - t;
      log.push(
        `chemin transcontinental (${r.ok ? 'ok' : r.error}, ${s.units.u1!.move?.legs.length ?? 0} segments) : ${tPath.toFixed(1)} ms (1er appel, caches froids)`,
      );
      applyOrder(s, own, { kind: 'stop', unitIds: ['u1'] });
      t = performance.now();
      const r2 = applyOrder(s, own, { kind: 'move', unitIds: ['u1'], to: [112, 48] });
      const tPath2 = performance.now() - t;
      log.push(`chemin transcontinental (2e appel) : ${tPath2.toFixed(1)} ms`);
      expect(r.ok && r2.ok).toBe(true);
      expect(tPath2).toBeLessThan(150);
      // Chemin mixte intercontinental (embarquement, traversée océanique ≈ 7 000 km).
      applyOrder(s, own, { kind: 'stop', unitIds: ['u1'] });
      s.units.u1!.pos = [-95, 42];
      s.rt.geom.delete('u1');
      t = performance.now();
      const r3 = applyOrder(s, own, { kind: 'move', unitIds: ['u1'], to: [15, 50] });
      const tMixed = performance.now() - t;
      const media = [...new Set(s.units.u1!.move?.legs.map((l) => l.medium) ?? [])].join('+');
      log.push(
        `chemin intercontinental avec embarquement (${r3.ok ? 'ok' : r3.error}, ${media}, ${s.units.u1!.move?.legs.length ?? 0} segments) : ${tMixed.toFixed(0)} ms`,
      );
      expect(r3.ok).toBe(true);
      applyOrder(s, own, { kind: 'stop', unitIds: ['u1'] });

      // Une journée calme (IA, économie).
      t = performance.now();
      advanceTo(s, DAY);
      const tCalm = performance.now() - t;
      log.push(`advanceTo 1 jour calme : ${tCalm.toFixed(0)} ms`);

      // Une journée agitée : 200 unités reçoivent des ordres de mouvement (guerres, combats, captures).
      const rng = seedRng(4);
      const ids = Object.keys(s.units).sort();
      let accepted = 0;
      t = performance.now();
      for (let i = 0; i < 200; i++) {
        const id = ids[Math.floor(nextFloat(rng) * ids.length)]!;
        const unit = s.units[id];
        if (!unit) continue;
        const dest = destination(unit.pos, nextFloat(rng) * 360, 100 + nextFloat(rng) * 400);
        if (applyOrder(s, unit.owner, { kind: 'move', unitIds: [id], to: dest }).ok) accepted++;
      }
      const tOrders = performance.now() - t;
      log.push(`200 ordres de mouvement (${accepted} acceptés) : ${tOrders.toFixed(0)} ms`);
      t = performance.now();
      const notes = advanceTo(s, 2 * DAY);
      const tBusy = performance.now() - t;
      log.push(
        `advanceTo 1 jour agité : ${tBusy.toFixed(0)} ms, ${notes.length} notifications, ${Object.keys(s.wars).length} guerres`,
      );
      t = performance.now();
      advanceTo(s, 3 * DAY);
      log.push(`advanceTo jour suivant : ${(performance.now() - t).toFixed(0)} ms`);

      t = performance.now();
      const v = viewFor(s, nations[10]!);
      const tView = performance.now() - t;
      t = performance.now();
      for (let i = 0; i < 20; i++) viewFor(s, nations[i]!);
      const tView20 = (performance.now() - t) / 20;
      log.push(
        `viewFor : ${tView.toFixed(1)} ms (moyenne sur 20 nations : ${tView20.toFixed(1)} ms), ${Object.keys(v.units).length} unités visibles`,
      );
      t = performance.now();
      const bytes = serializeState(s);
      const h = stateHash(s);
      log.push(
        `serializeState + stateHash : ${(performance.now() - t).toFixed(0)} ms, ${(bytes.length / 1024).toFixed(0)} Kio (${h})`,
      );
      console.log(log.join('\n'));

      expect(tCalm).toBeLessThan(400);
      expect(tBusy).toBeLessThan(1500);
      expect(tView20).toBeLessThan(40);
    },
  );
});
