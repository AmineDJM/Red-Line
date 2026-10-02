// Recensement des piles de départ (nombre d'unités, paires, répartition par catégorie et par domaine),
// pour un ou plusieurs scénarios, avec le coût de createGame.
//
//   node --expose-gc bench/run.mjs stacks                        (world-today et cold-war-1985)
//   STACKS_SCENARIOS=world-today node bench/run.mjs stacks
import { buildWorld, createGame, serializeState } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { loadRealData } from './load.js';
import { breakdown } from '../src/modules/eco/budget.js';

const scenarios = (process.env.STACKS_SCENARIOS ?? 'world-today,cold-war-1985').split(',');
for (const id of scenarios) {
  const { map, catalog, balance, research, orbats, scenario } = loadRealData(id);
  const world = buildWorld(map, catalog, balance, { research, orbats });
  const t0 = performance.now();
  const s = createGame(world, {
    seed: 2025,
    players: [{ nationId: 'fra', isAi: false }],
    aiLevel: 'normal',
    scenario,
    speed: 1,
  }) as EngineState;
  const ms = performance.now() - t0;
  const byCat = new Map<string, [number, number]>();
  let mixed = 0;
  let elements = 0;
  for (const u of Object.values(s.units)) {
    const parts = u.mix
      ? u.mix.map((p) => ({ sys: p.sys, count: p.c }))
      : [{ sys: u.sys, count: u.count }];
    if (parts.length > 1) mixed++;
    for (const p of parts) {
      const cat = world.catalog.get(p.sys)!.category;
      const e = byCat.get(cat) ?? [0, 0];
      e[1] += p.count;
      byCat.set(cat, e);
      elements += p.count;
    }
    const lead = world.catalog.get(u.sys)!.category;
    const e = byCat.get(lead) ?? [0, 0];
    e[0]++;
    byCat.set(lead, e);
  }
  const bytes = serializeState(s).length;
  console.log(
    `${id} : ${Object.keys(s.units).length} unités (${mixed} piles mixtes, ${elements} éléments), ` +
      `${Object.keys(s.pairs).length} paires, createGame ${ms.toFixed(0)} ms, ` +
      `instantané ${(bytes / 1048576).toFixed(2)} Mio`,
  );
  for (const [cat, [n, el]] of [...byCat.entries()].sort((a, b) => b[1][0] - a[1][0]))
    console.log(
      `  ${cat.padEnd(16)} ${String(n).padStart(5)} piles  ${String(el).padStart(7)} éléments`,
    );
  // Entretien journalier (doit être identique avec ou sans regroupement : somme des éléments).
  let upkeep = 0;
  for (const n of s.nationIds) upkeep += breakdown(s, n).upkeepTotal;
  console.log(
    `  entretien journalier : monde ${(upkeep / 1e9).toFixed(3)} G$, ` +
      ['fra', 'rus', 'usa', 'ukr']
        .filter((n) => s.nations[n])
        .map((n) => `${n} ${(breakdown(s, n).upkeepTotal / 1e6).toFixed(2)} M$`)
        .join(', '),
  );
}
