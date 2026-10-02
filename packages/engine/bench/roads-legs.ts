// Banc : nombre de segments et coût de calcul des trajets terrestres, avec / sans réseau de routes.
//   node bench/run.mjs roads-legs   (REDLINE_NO_ROUTES=1 : grille libre)
import { distanceKm } from '@redline/shared';
import { buildWorld, createGame } from '../src/index.js';
import { planUnitMove } from '../src/movement/plan-unit.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { loadRealData } from './load.js';

const data = loadRealData();
const world = buildWorld(data.map, data.catalog, data.balance, {
  research: data.research,
  orbats: data.orbats,
});
const s = createGame(world, {
  seed: 2025,
  players: [{ nationId: 'fra', isAi: false }],
  aiLevel: 'normal',
  scenario: data.scenario,
  speed: 1,
}) as EngineState;
const w = wi(world);
let plans = 0;
let legs = 0;
let fails = 0;
let km = 0;
const errors: Record<string, number> = {};
const t0 = performance.now();
const ids = Object.keys(s.units).sort();
for (const id of ids) {
  const u = s.units[id]!;
  const sys = world.catalog.get(u.sys)!;
  if (sys.movement !== 'land' || sys.speedKmh <= 0) continue;
  const provs = w.provsByNation.get(u.owner) ?? [];
  for (let k = 0; k < 3 && k < provs.length; k++) {
    const pid = provs[(id.length * 7 + k * 13) % provs.length]!;
    const to = w.provById.get(pid)!.cityPoint;
    const p = planUnitMove(s, u, to);
    plans++;
    if ('error' in p) {
      fails++;
      errors[p.error] = (errors[p.error] ?? 0) + 1;
      continue;
    }
    legs += p.legs.length;
    for (const l of p.legs) km += distanceKm(l.from, l.to);
  }
  if (plans > 3000) break;
}
const ms = performance.now() - t0;
console.log(
  `${plans} trajets, ${fails} échecs ${JSON.stringify(errors)}, ${(legs / Math.max(1, plans - fails)).toFixed(1)} segments en moyenne, ` +
    `${(km / Math.max(1, legs)).toFixed(1)} km par segment, ${ms.toFixed(0)} ms (${(ms / plans).toFixed(2)} ms par trajet)`,
);
