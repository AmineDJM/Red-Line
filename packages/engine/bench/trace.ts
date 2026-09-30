// Trace événement par événement depuis un instantané : temps passé par type d'événement.
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { HOUR } from '@redline/shared';
import { advanceTo, buildWorld, deserializeState } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { heapPeek } from '../src/queue/heap.js';
import { loadRealData } from './load.js';

const [file, hoursS = '1'] = process.argv.slice(2);
const d = loadRealData();
const world = buildWorld(d.map, d.catalog, d.balance, { research: d.research, orbats: d.orbats });
const s = deserializeState(world, readFileSync(file!)) as EngineState;
const end = s.time + Number(hoursS) * HOUR;
const byKind = new Map<string, { n: number; ms: number; max: number }>();
const PROF = process.env.PROF;
const BUDGET = Number(process.env.BUDGET_S ?? 1e9) * 1000;
const session = new Session();
if (PROF) {
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.setSamplingInterval', { interval: 500 });
  session.post('Profiler.start');
}
let lastPrint = performance.now();
const t0 = performance.now();
let slow: string[] = [];
while (performance.now() - t0 < BUDGET) {
  const top = heapPeek(s.queue);
  if (!top || top.t > end) break;
  const k = top.k === 'mod' ? `mod:${(top as any).m}:${(top as any).e}` : top.k;
  if (process.env.VERBOSE_FROM && top.t >= Number(process.env.VERBOSE_FROM) * HOUR)
    console.log('>', k, (top.t / HOUR).toFixed(4), JSON.stringify(top).slice(0, 200));
  const t = performance.now();
  advanceTo(s, top.t);
  const dt = performance.now() - t;
  const e = byKind.get(k) ?? { n: 0, ms: 0, max: 0 };
  e.n++;
  e.ms += dt;
  e.max = Math.max(e.max, dt);
  byKind.set(k, e);
  if (dt > 200) slow.push(`${k} @${(top.t / HOUR).toFixed(2)}h ${dt.toFixed(0)}ms`);
  if (performance.now() - lastPrint > 20000) {
    lastPrint = performance.now();
    console.log(
      `t=${(s.time / HOUR).toFixed(3)}h wall=${((lastPrint - t0) / 1000).toFixed(0)}s units=${Object.keys(s.units).length} q=${s.queue.length}`,
    );
    console.log(
      [...byKind]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 12)
        .map(([k, v]) => `  ${k}: n=${v.n} ${v.ms.toFixed(0)}ms max=${v.max.toFixed(0)}`)
        .join('\n'),
    );
    console.log(slow.slice(-10).join('\n'));
  }
}
if (PROF) {
  session.post('Profiler.stop', (err, res) => {
    if (err) throw err;
    writeFileSync(PROF, JSON.stringify(res.profile));
  });
}
console.log('FIN', ((performance.now() - t0) / 1000).toFixed(1), 's');
console.log(
  [...byKind]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 20)
    .map(([k, v]) => `  ${k}: n=${v.n} ${v.ms.toFixed(0)}ms max=${v.max.toFixed(0)}`)
    .join('\n'),
);
console.log(slow.slice(-30).join('\n'));
