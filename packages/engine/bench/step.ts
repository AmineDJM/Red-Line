// Rejoue une étape isolée à partir d'un instantané écrit par `BENCH_SAVE=<dossier> … bench/real.ts` :
//   node --import tsx bench/step.ts <instantané.bin> [heures=24] [pas en heures=24]
//   node --cpu-prof --import tsx bench/step.ts …        (profil de cette étape seulement)
// Affiche la durée de chaque pas et l'empreinte finale (comparaison avant / après optimisation).
import { readFileSync } from 'node:fs';
import { HOUR } from '@redline/shared';
import { advanceTo, buildWorld, deserializeState, stateHash } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { loadRealData } from './load.js';

const [file, hoursS = '24', stepS = '24'] = process.argv.slice(2);
if (!file) throw new Error('usage : step.ts <instantané.bin> [heures] [pas]');
const d = loadRealData();
const world = buildWorld(d.map, d.catalog, d.balance, { research: d.research, orbats: d.orbats });
const s = deserializeState(world, readFileSync(file)) as EngineState;
console.log('départ', s.time / HOUR, 'h', stateHash(s));
const end = s.time + Number(hoursS) * HOUR;
const step = Number(stepS) * HOUR;
const t0 = performance.now();
while (s.time < end) {
  const t = performance.now();
  const notes = advanceTo(s, Math.min(end, s.time + step));
  console.log(
    `  → ${(s.time / HOUR).toFixed(0)} h : ${(performance.now() - t).toFixed(0)} ms, ` +
      `${notes.length} notifications, ${Object.keys(s.units).length} unités, ` +
      `${Object.keys(s.pairs).length} paires, ${s.queue.length} événements`,
  );
}
console.log('total', (performance.now() - t0).toFixed(0), 'ms', 'empreinte', stateHash(s));
