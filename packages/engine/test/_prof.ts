import { DAY, destination } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { BALANCE, CATALOG } from './fixtures.js';
import { worldScaleMap } from './world-scale.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
const map = worldScaleMap();
const world = buildWorld(map, CATALOG, { ...BALANCE });
const nations = map.nations.map((n) => n.id);
const s = createGame(world, {
  seed: 1,
  players: [
    { nationId: nations[0]!, isAi: false },
    { nationId: nations[10]!, isAi: true, aiLevel: 'hard' },
  ],
}) as EngineState;
let t = performance.now();
advanceTo(s, DAY);
console.log('calme', performance.now() - t);
const rng = seedRng(4);
const ids = Object.keys(s.units).sort();
for (let i = 0; i < 200; i++) {
  const id = ids[Math.floor(nextFloat(rng) * ids.length)]!;
  const unit = s.units[id];
  if (!unit) continue;
  const dest = destination(unit.pos, nextFloat(rng) * 360, 100 + nextFloat(rng) * 400);
  applyOrder(s, unit.owner, { kind: 'move', unitIds: [id], to: dest });
}
t = performance.now();
advanceTo(s, 2 * DAY);
console.log('agité', performance.now() - t, Object.keys(s.wars).length);
t = performance.now();
advanceTo(s, 10 * DAY);
console.log('8 jours de plus', performance.now() - t, Object.keys(s.wars).length);
const d = (s.mods as any).diplo;
console.log('news', d.news.length, 'alliances', Object.keys(d.alliances).length, 'proposals', Object.keys(d.proposals).length);
console.log(d.news.slice(-15).map((n: any) => `${n.category}: ${n.headline}`).join('\n'));
