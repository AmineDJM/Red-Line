// Banc d'essai du VRAI moteur sur les VRAIES données (partie monde, toutes les nations) :
// coût de buildWorld, createGame, advanceTo, viewFor, diffViews, serializeState, taille des instantanés.
//
//   pnpm --filter @redline/server exec tsx scripts/bench-engine.ts [joueurs=64] [heures=24] [vitesse=4]
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import pino from 'pino';
import * as E from '@redline/engine';
import { encodeMessage } from '@redline/shared';
import { loadGameData } from '../src/data/loader.js';
import { REPO_ROOT } from '../src/paths.js';

const HOUR = 3_600_000;
const players = Number(process.argv[2] ?? 64);
const hours = Number(process.argv[3] ?? 24);
const speed = Number(process.argv[4] ?? 4);

const log = pino({ level: 'warn' });
const data = await loadGameData(join(REPO_ROOT, 'data'), log as never);
const scenario = data.scenarios.find((s) => s.id === 'world-today')!;
const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;

let t = process.hrtime.bigint();
const world = E.buildWorld(data.map!, data.repoCatalog, data.balance!, {
  research: data.research,
  orbats: data.orbats,
});
console.log(`buildWorld            ${ms(t).toFixed(0)} ms`);

const nations = data.map!.nations.map((n) => n.id);
const humans = nations.slice(0, players);
t = process.hrtime.bigint();
const state = E.createGame(world, {
  seed: 42,
  players: nations.map((n) => ({ nationId: n, isAi: !humans.includes(n), aiLevel: 'normal' })),
  scenario,
  speed,
});
console.log(`createGame            ${ms(t).toFixed(0)} ms  (${nations.length} nations)`);

const heap = () => (process.memoryUsage().heapUsed / 1048576).toFixed(0);
console.log(`tas après création    ${heap()} Mio`);

t = process.hrtime.bigint();
let views = humans.map((n) => E.viewFor(state, n));
const vt = ms(t);
const welcome = encodeMessage({
  t: 'welcome',
  game: {} as never,
  me: humans[0]!,
  clock: { anchorGame: 0, anchorReal: 0, speed, paused: false },
  view: views[0]!,
});
console.log(
  `viewFor ×${humans.length}          ${vt.toFixed(0)} ms (${(vt / humans.length).toFixed(1)} ms/vue) ; welcome ${(welcome.byteLength / 1024).toFixed(0)} Kio (gzip ${(gzipSync(welcome).byteLength / 1024).toFixed(0)} Kio)`,
);

// Avance heure par heure : événements, pas le plus long, diffs.
let events = 0;
let worst = 0;
let advTotal = 0;
let diffBytes = 0;
let diffCount = 0;
let viewTotal = 0;
let diffTotal = 0;
for (let h = 1; h <= hours; h++) {
  const target = h * HOUR;
  while (true) {
    const next = E.nextEventTime(state);
    if (next === null || next > target) break;
    const s0 = process.hrtime.bigint();
    E.advanceTo(state, Math.max(next, state.time));
    const d = ms(s0);
    advTotal += d;
    worst = Math.max(worst, d);
    events++;
  }
  E.advanceTo(state, target);
  const v0 = process.hrtime.bigint();
  const next = humans.map((n) => E.viewFor(state, n));
  viewTotal += ms(v0);
  const d0 = process.hrtime.bigint();
  for (let i = 0; i < humans.length; i++) {
    const diff = E.diffViews(views[i]!, next[i]!);
    if (diff) {
      diffBytes += encodeMessage({ t: 'diff', diff }).byteLength;
      diffCount++;
    }
  }
  diffTotal += ms(d0);
  views = next;
}
console.log(
  `advance ${hours} h de jeu   ${advTotal.toFixed(0)} ms, ${events} pas, pas le plus long ${worst.toFixed(1)} ms`,
);
console.log(
  `vues+diffs horaires    viewFor ${(viewTotal / hours).toFixed(0)} ms/h, diffViews ${(diffTotal / hours).toFixed(0)} ms/h, diff moyen ${(diffBytes / Math.max(1, diffCount) / 1024).toFixed(1)} Kio`,
);
t = process.hrtime.bigint();
const bytes = E.serializeState(state);
const st = ms(t);
t = process.hrtime.bigint();
const gz = gzipSync(bytes);
const gt = ms(t);
t = process.hrtime.bigint();
E.deserializeState(world, bytes);
const dt = ms(t);
console.log(
  `instantané            ${(bytes.byteLength / 1048576).toFixed(2)} Mio brut, ${(gz.byteLength / 1024).toFixed(0)} Kio gzip ; serialize ${st.toFixed(0)} ms, gzip ${gt.toFixed(0)} ms, deserialize ${dt.toFixed(0)} ms`,
);
console.log(`tas final             ${heap()} Mio`);
