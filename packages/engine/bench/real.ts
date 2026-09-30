// Banc d'essai sur la vraie partie (carte, catalogue, équilibrage, recherche, ORBAT 2025, scénario
// « world-today »), chargés comme le fait le serveur (apps/server/src/data/loader.ts).
//
//   pnpm --filter @redline/engine bench                 (depuis la racine du dépôt)
//   cd packages/engine && npx tsx bench/real.ts         (idem)
//   BENCH_DAYS=10 … : nombre de jours consécutifs mesurés à la fin (défaut 10)
//   BENCH_JSON=1 …  : ajoute une ligne JSON des mesures (comparaisons automatisées)
//   node --cpu-prof --import tsx bench/real.ts         (profil du fil principal)
//
// Les empreintes (stateHash) affichées permettent de vérifier qu'une optimisation ne change pas le
// comportement : même graine + mêmes ordres ⇒ mêmes empreintes, avant comme après.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY, destination, type NationId, type Order, type PlayerView } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  diffViews,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { unitPosAt } from '../src/state/access.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
import { loadRealData } from './load.js';

/** BENCH_SAVE=<dossier> : instantanés J1 (après les ordres) et J3, pour profiler une étape isolée. */
const SAVE = process.env.BENCH_SAVE;
function save(name: string): void {
  if (!SAVE) return;
  mkdirSync(SAVE, { recursive: true });
  writeFileSync(join(SAVE, `${name}.bin`), serializeState(s));
}

const rows: [string, string][] = [];
const metrics: Record<string, number | string> = {};
function row(label: string, ms: number | null, extra = '', key?: string): void {
  rows.push([
    label,
    (ms === null ? '' : `${ms.toFixed(ms < 100 ? 1 : 0)} ms`) + (extra ? `  ${extra}` : ''),
  ]);
  if (key && ms !== null) metrics[key] = Math.round(ms * 10) / 10;
  console.log(label.padEnd(34), rows[rows.length - 1]![1]);
}
const now = (): number => performance.now();
const mib = (b: number): string => `${(b / 1048576).toFixed(1)} Mio`;
function heap(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
}

// ——— Chargement des données (comme le serveur) ———
let t = now();
const { map, catalog, balance, research, orbats, scenario } = loadRealData();
const elements = (orbats['2025'] ?? []).reduce(
  (a, o) => a + o.inventory.reduce((b, i) => b + i.count, 0),
  0,
);
row(
  'chargement des données',
  now() - t,
  `${map.nations.length} nations, ${map.provinces.length} provinces, ${catalog.length} systèmes, ` +
    `${research.length} nœuds, ${orbats['2025']?.length ?? 0} ORBAT (${elements} éléments)`,
);

// ——— Monde et partie ———
t = now();
const world = buildWorld(map, catalog, balance, { research, orbats });
row('buildWorld', now() - t, `${world.loadWarnings?.length ?? 0} avertissements`, 'buildWorld');

const HUMAN = 'fra';
const h0 = heap();
t = now();
const s = createGame(world, {
  seed: 2025,
  players: [{ nationId: HUMAN, isAi: false }],
  aiLevel: 'normal',
  scenario,
  speed: 1,
}) as EngineState;
const tCreate = now() - t;
const h1 = heap();
row(
  'createGame',
  tCreate,
  `${Object.keys(s.units).length} unités, ${Object.keys(s.pairs).length} paires, ${s.queue.length} événements`,
  'createGame',
);
row('mémoire (tas de la partie)', null, `${mib(h1 - h0)} (tas total ${mib(h1)})`);
metrics.heapMiB = Math.round(((h1 - h0) / 1048576) * 10) / 10;
console.log('  empreinte initiale', stateHash(s));

// ——— Jour calme ———
t = now();
let notes = advanceTo(s, DAY);
row('jour calme (J0 → J1)', now() - t, `${notes.length} notifications`, 'calmDay');
const hashCalm = stateHash(s);
console.log('  empreinte J1', hashCalm);

// ——— 200 ordres + guerres réalistes ———
const w = wi(world);
const WARS: [NationId, NationId][] = [
  ['rus', 'ukr'],
  ['chn', 'twn'],
  ['ind', 'pak'],
  ['isr', 'irn'],
  ['prk', 'kor'],
  ['sau', 'yem'],
  ['aze', 'arm'],
  ['eth', 'eri'],
  ['dza', 'mar'],
  ['ven', 'guy'],
];
t = now();
let declared = 0;
for (const [a, b] of WARS) {
  if (!s.nations[a] || !s.nations[b]) continue;
  if (applyOrder(s, a, { kind: 'declareWar', nationId: b }).ok) declared++;
}
const tWar = now() - t;
const rng = seedRng(11);
const cities = (n: NationId): [number, number][] =>
  Object.values(s.provinces)
    .filter((p) => p.owner === n)
    .map((p) => p.id)
    .sort()
    .map((pid) => w.provById.get(pid)!.cityPoint);
let accepted = 0;
let tried = 0;
const byKind: Record<string, number> = {};
t = now();
for (let round = 0; round < 40 && accepted < 200; round++) {
  for (const [a, b] of WARS) {
    if (accepted >= 200) break;
    if (!s.nations[a] || !s.nations[b]) continue;
    const targets = cities(b);
    if (targets.length === 0) continue;
    const mine = [...(s.rt.byNation.get(a) ?? [])].sort();
    if (mine.length === 0) continue;
    for (let k = 0; k < 3 && accepted < 200; k++) {
      const id = mine[Math.floor(nextFloat(rng) * mine.length)]!;
      const u = s.units[id];
      if (!u || u.off || u.move) continue;
      const sys = world.catalog.get(u.sys)!;
      const target = targets[Math.floor(nextFloat(rng) * targets.length)]!;
      let o: Order;
      if (sys.missile || u.role === 'missile')
        o = { kind: 'strike', unitIds: [id], target: { type: 'point', at: target }, count: 1 };
      else if (sys.movement === 'air')
        o = { kind: 'patrol', unitIds: [id], at: target, radiusKm: 120 };
      else if (sys.movement === 'static' || sys.speedKmh <= 0) continue;
      else if (sys.movement === 'sea') {
        const p = unitPosAt(s, u, s.time);
        o = {
          kind: 'move',
          unitIds: [id],
          to: destination(p, nextFloat(rng) * 360, 100 + nextFloat(rng) * 300),
        };
      } else o = { kind: 'move', unitIds: [id], to: target };
      tried++;
      if (applyOrder(s, a, o).ok) {
        accepted++;
        byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
      }
    }
  }
}
const tOrders = now() - t;
save('j1-orders');
row(
  `${declared} guerres déclarées`,
  tWar,
  `${Object.keys(s.wars).length} guerres en cours`,
  'declareWars',
);
row(
  `${accepted} ordres (${tried} essayés)`,
  tOrders,
  Object.entries(byKind)
    .map(([k, v]) => `${k} ${v}`)
    .join(', '),
  'orders',
);
t = now();
notes = advanceTo(s, 2 * DAY);
row(
  'jour de guerre intense (J1 → J2)',
  now() - t,
  `${notes.length} notifications, ${Object.keys(s.wars).length} guerres, ${Object.keys(s.units).length} unités`,
  'warDay',
);
console.log('  empreinte J2', stateHash(s));
t = now();
notes = advanceTo(s, 3 * DAY);
row('jour suivant (J2 → J3)', now() - t, `${notes.length} notifications`, 'nextDay');
save('j3');

const DAYS = Number(process.env.BENCH_DAYS ?? 10);
const perDay: number[] = [];
t = now();
for (let d = 0; d < DAYS; d++) {
  const t1 = now();
  const nn = advanceTo(s, (4 + d) * DAY);
  perDay.push(now() - t1);
  console.log(
    `  J${4 + d} : ${(now() - t1).toFixed(0)} ms, ${nn.length} notifications, ` +
      `${Object.keys(s.wars).length} guerres, ${Object.keys(s.units).length} unités, ` +
      `${Object.keys(s.pairs).length} paires, ${s.queue.length} événements`,
  );
}
const tDays = now() - t;
row(
  `${DAYS} jours consécutifs (J3 → J${3 + DAYS})`,
  tDays,
  `moyenne ${(tDays / Math.max(1, DAYS)).toFixed(0)} ms, max ${Math.max(...perDay, 0).toFixed(0)} ms, ` +
    `${Object.keys(s.wars).length} guerres, ${Object.keys(s.units).length} unités`,
  'days',
);
metrics.dayMax = Math.round(Math.max(...perDay, 0));
const hashEnd = stateHash(s);
console.log('  empreinte finale', hashEnd);

// ——— Vues ———
const viewNations = s.nationIds.filter((n) => s.nations[n]!.alive);
const sample: NationId[] = [HUMAN, ...WARS.flat()]
  .filter((n, i, a) => a.indexOf(n) === i && s.nations[n])
  .slice(0, 20);
for (const n of viewNations) if (sample.length < 20 && !sample.includes(n)) sample.push(n);
viewFor(s, HUMAN); // préchauffage
const views = new Map<NationId, PlayerView>();
t = now();
for (const n of sample) views.set(n, viewFor(s, n));
const tView = (now() - t) / sample.length;
row(
  `viewFor (moyenne sur ${sample.length} nations)`,
  tView,
  `${Object.keys(views.get(HUMAN)!.units).length} unités visibles (fra)`,
  'viewFor',
);
advanceTo(s, s.time + 60_000 * 30);
t = now();
let diffs = 0;
for (const n of sample) {
  const next = viewFor(s, n);
  if (diffViews(views.get(n)!, next)) diffs++;
}
const tViewDiff = (now() - t) / sample.length;
row(`viewFor + diffViews (30 min plus tard)`, tViewDiff, `${diffs} diffs non vides`, 'viewDiff');

// ——— Instantané ———
t = now();
const bytes = serializeState(s);
row('serializeState', now() - t, `${mib(bytes.length)} (${bytes.length} octets)`, 'serialize');
metrics.snapshotMiB = Math.round((bytes.length / 1048576) * 100) / 100;
t = now();
const back = deserializeState(world, bytes) as EngineState;
row('deserializeState', now() - t, '', 'deserialize');
t = now();
const same = stateHash(back) === stateHash(s);
row('stateHash × 2', now() - t, same ? 'reprise identique' : 'REPRISE DIFFÉRENTE');
t = now();
advanceTo(s, s.time + DAY / 2);
advanceTo(back, back.time + DAY / 2);
const sameAfter = stateHash(back) === stateHash(s);
row('reprise + ½ jour (× 2)', now() - t, sameAfter ? 'états identiques' : 'ÉTATS DIVERGENTS');
metrics.hashCalm = hashCalm;
metrics.hashEnd = hashEnd;

console.log('\n| Mesure | Valeur |\n| --- | --- |');
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
if (process.env.BENCH_JSON) console.log('BENCH_JSON ' + JSON.stringify(metrics));
if (!same || !sameAfter) process.exitCode = 1;
