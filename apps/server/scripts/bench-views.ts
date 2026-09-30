// Coût de viewFor / diffViews / notificationsFor par nation (partie monde, après N heures de jeu).
//   pnpm --filter @redline/server exec tsx scripts/bench-views.ts [heures=12]
import { join } from 'node:path';
import pino from 'pino';
import * as E from '@redline/engine';
import { encodeMessage } from '@redline/shared';
import { loadGameData } from '../src/data/loader.js';
import { REPO_ROOT } from '../src/paths.js';

const HOUR = 3_600_000;
const hours = Number(process.argv[2] ?? 12);
const data = await loadGameData(join(REPO_ROOT, 'data'), pino({ level: 'warn' }) as never);
const world = E.buildWorld(data.map!, data.repoCatalog, data.balance!, {
  research: data.research,
  orbats: data.orbats,
});
const nations = data.map!.nations.map((n) => n.id);
const state = E.createGame(world, {
  seed: 5,
  players: nations.map((n) => ({ nationId: n, isAi: true })),
  scenario: data.scenarios.find((s) => s.id === 'world-today')!,
  speed: 16,
});
const prev = new Map(nations.map((n) => [n, E.viewFor(state, n)]));
E.advanceTo(state, hours * HOUR);
const rows: { n: string; view: number; diff: number; bytes: number; units: number }[] = [];
for (const n of nations) {
  let t = performance.now();
  const v = E.viewFor(state, n);
  const view = performance.now() - t;
  t = performance.now();
  const d = E.diffViews(prev.get(n)!, v);
  const diff = performance.now() - t;
  rows.push({
    n,
    view,
    diff,
    bytes: d ? encodeMessage({ t: 'diff', diff: d }).byteLength : 0,
    units: Object.keys(v.units).length,
  });
}
rows.sort((a, b) => b.view + b.diff - (a.view + a.diff));
const tot = (k: 'view' | 'diff') => rows.reduce((a, r) => a + r[k], 0);
console.log(`total viewFor ${tot('view').toFixed(0)} ms, diffViews ${tot('diff').toFixed(0)} ms`);
for (const r of rows.slice(0, 12)) {
  console.log(
    `${r.n.padEnd(4)} viewFor ${r.view.toFixed(1).padStart(6)} ms  diff ${r.diff.toFixed(1).padStart(6)} ms  ${String(r.units).padStart(5)} unités  diff ${(r.bytes / 1024).toFixed(1)} Kio`,
  );
}
let t = performance.now();
E.publicView(state);
console.log(`publicView ${(performance.now() - t).toFixed(1)} ms`);
t = performance.now();
E.stateHash(state);
console.log(`stateHash ${(performance.now() - t).toFixed(1)} ms`);
