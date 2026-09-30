// Banc d'essai hors suite (monde synthétique ≈ 5 000 unités, journée de guerre) :
//   cd packages/engine && npx tsx test/mil-bench-world.ts      (ajouter --cpu-prof pour profiler)
import { DAY, destination } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
import { BALANCE } from './fixtures.js';
import { MIL_CATALOG } from './mil-fixtures.js';
import { worldScaleMap } from './world-scale.js';

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
const world = buildWorld(map, MIL_CATALOG, { ...BALANCE, startingArmy: army, garrisonArmy: army });
const nations = map.nations.map((n) => n.id);
const s = createGame(world, {
  seed: 1,
  players: [
    { nationId: nations[0]!, isAi: false },
    { nationId: nations[10]!, isAi: true, aiLevel: 'hard' },
    { nationId: nations[20]!, isAi: true, aiLevel: 'hard' },
    { nationId: nations[30]!, isAi: true, aiLevel: 'normal' },
  ],
}) as EngineState;
let t = performance.now();
advanceTo(s, DAY);
console.log('jour calme', (performance.now() - t).toFixed(0), 'ms');
const rng = seedRng(9);
const ids = Object.keys(s.units).sort();
let moves = 0;
let patrols = 0;
let salvos = 0;
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
      applyOrder(s, u.owner, { kind: 'strike', unitIds: [id], target: { type: 'point', at: to } })
        .ok
    )
      salvos++;
  } else if (moves < 300) {
    if (applyOrder(s, u.owner, { kind: 'move', unitIds: [id], to }).ok) moves++;
  }
}
t = performance.now();
advanceTo(s, 2 * DAY);
console.log(
  'jour de guerre',
  (performance.now() - t).toFixed(0),
  'ms',
  Object.keys(s.wars).length,
  'guerres',
);
t = performance.now();
advanceTo(s, 3 * DAY);
console.log('jour suivant', (performance.now() - t).toFixed(0), 'ms');
