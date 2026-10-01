// Ordres donnés par les IA pendant un pas depuis un instantané (genre → réussis / refusés).
//   node bench/run.mjs ai-orders <instantané.bin> [heures=24]
import { readFileSync } from 'node:fs';
import { HOUR } from '@redline/shared';
import { advanceTo, buildWorld, deserializeState, stateHash } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { setAiTracer } from '../src/ai/trace.js';
import { mil } from '../src/modules/mil/state.js';
import { loadRealData } from './load.js';

const [file, hoursS = '24'] = process.argv.slice(2);
if (!file) throw new Error('usage : ai-orders.ts <instantané.bin> [heures]');
const d = loadRealData();
const world = buildWorld(d.map, d.catalog, d.balance, { research: d.research, orbats: d.orbats });
const s = deserializeState(world, readFileSync(file)) as EngineState;
const orders: Record<string, [number, number]> = {};
setAiTracer((_st, _n, o, r) => {
  const k = o.kind === 'intelOp' ? `intel:${String(o.op)}` : o.kind;
  (orders[k] ??= [0, 0])[r.ok ? 0 : 1]++;
});
let airborne = 0;
const end = s.time + Number(hoursS) * HOUR;
while (s.time < end) {
  advanceTo(s, Math.min(end, s.time + HOUR));
  const ms = mil(s).ms;
  for (const id of Object.keys(ms)) if (ms[id]!.up) airborne++;
}
setAiTracer(null);
console.log(JSON.stringify(orders));
console.log('aéronefs en vol (somme horaire)', airborne, 'empreinte', stateHash(s));
