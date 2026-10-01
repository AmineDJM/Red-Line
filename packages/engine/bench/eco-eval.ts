// Bilan économique de départ sur les vraies données : entretien des forces ORBAT / revenu de défense.
//
//   node bench/run.mjs eco-eval                       (depuis packages/engine)
//   ECOEVAL_SCENARIO=world-today|cold-war-1985   (défaut : les deux)
//   ECOEVAL_RAW=1 : entretien brut du catalogue (sans âge, coût local ni plafond), pour comparer.
//   ECOEVAL_ALL=1 : une ligne par nation (sinon résumé et nations remarquables).
//   ECOEVAL_JSON=1 : une ligne JSON par nation.
//
// Revenu = revenu journalier total de la nation au départ (budget de défense / 365, parts nationale et
// provinciale) ; entretien = entretien journalier de toutes ses unités de départ ; marge = revenu −
// entretien ; « 7 j » = trésorerie de départ + 7 jours de marge (ce qu'un joueur peut engager la
// première semaine).
import { HOUR, type Balance, type NationId } from '@redline/shared';
import { advanceTo, buildWorld, createGame } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { breakdown, budgetDay } from '../src/modules/eco/budget.js';
import { eco, orbatOf } from '../src/modules/eco/state.js';
import { costIndexOf } from '../src/modules/eco/upkeep.js';
import { loadRealData } from './load.js';

const env = process.env;
const SCENARIOS = (env.ECOEVAL_SCENARIO ?? 'world-today,cold-war-1985').split(',');
const ALL = !!env.ECOEVAL_ALL;
const JSON_OUT = !!env.ECOEVAL_JSON;
const RAW = !!env.ECOEVAL_RAW;

const fmt = (usd: number): string => {
  const a = Math.abs(usd);
  const s = usd < 0 ? '−' : '';
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)} G$`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)} M$`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)} k$`;
  return `${s}${a.toFixed(0)} $`;
};
const pct = (x: number): string => `${(x * 100).toFixed(0)} %`;

interface Row {
  n: NationId;
  budgetYear: number;
  income: number;
  upkeep: number;
  ratio: number;
  margin: number;
  money0: number;
  week: number;
  factor: number;
  costIndex: number;
}

function quantile(xs: number[], q: number): number {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))] ?? 0;
}

for (const sc of SCENARIOS) {
  const data = loadRealData(sc);
  // Modèle d'avant : prix catalogue seul, budgets ORBAT sans conversion de dollars.
  const balance: Balance = RAW
    ? {
        ...data.balance,
        money: { ...data.balance.money!, budgetDollarFactor: 1 },
        upkeep: {
          generationFactor: {},
          generationExempt: [],
          localShare: {},
          localShareDefault: 0,
          defaultCostIndex: 1,
          maxStartShare: 1e9,
          minStartShare: 0,
        },
      }
    : data.balance;
  const world = buildWorld(data.map, data.catalog, balance, {
    research: data.research,
    orbats: data.orbats,
  });
  const s = createGame(world, {
    seed: 1,
    players: [{ nationId: 'fra', isAi: false }],
    aiLevel: 'normal',
    scenario: data.scenario,
    speed: 1,
  }) as EngineState;
  advanceTo(s, HOUR); // forces posées, premier état stable
  const rows: Row[] = [];
  for (const n of s.nationIds) {
    const o = orbatOf(s, n);
    if (!o || budgetDay(s, n) <= 0) continue;
    const b = breakdown(s, n);
    const margin = b.total - b.upkeepTotal;
    const money0 = s.nations[n]!.money;
    rows.push({
      n,
      budgetYear: budgetDay(s, n) * 365,
      income: b.total,
      upkeep: b.upkeepTotal,
      ratio: b.upkeepTotal / b.total,
      margin,
      money0,
      week: money0 + 7 * margin,
      factor: eco(s).upk?.[n] ?? 1,
      costIndex: costIndexOf(s, n),
    });
  }
  rows.sort((a, b) => b.ratio - a.ratio || (a.n < b.n ? -1 : 1));
  if (JSON_OUT) {
    for (const r of rows) console.log(JSON.stringify({ scenario: sc, ...r }));
    continue;
  }
  const ratios = rows.map((r) => r.ratio);
  const over = rows.filter((r) => r.ratio > 1);
  console.log(`\n## ${data.scenario.name} (${rows.length} nations dotées d'un ORBAT)\n`);
  console.log(`- entretien > revenu (déficit structurel) : ${over.length}`);
  console.log(`- entretien > 90 % du revenu : ${rows.filter((r) => r.ratio > 0.9).length}`);
  console.log(`- entretien > 75 % du revenu : ${rows.filter((r) => r.ratio > 0.75).length}`);
  console.log(
    `- ratio médian ${pct(quantile(ratios, 0.5))}, 1er quartile ${pct(quantile(ratios, 0.25))}, ` +
      `3e quartile ${pct(quantile(ratios, 0.75))}, maximum ${pct(Math.max(...ratios))}`,
  );
  console.log(
    `- marge cumulée du monde : ${fmt(rows.reduce((a, r) => a + r.margin, 0))}/j ; ` +
      `nations à marge négative : ${rows.filter((r) => r.margin < 0).length}`,
  );
  const watch = new Set([
    'usa',
    'chn',
    'rus',
    'ind',
    'gbr',
    'fra',
    'deu',
    'jpn',
    'kor',
    'tur',
    'isr',
    'irn',
    'sau',
    'egy',
    'pak',
    'mar',
    'dza',
    'prk',
    'eri',
    'ukr',
    'bra',
    'nga',
    'cub',
    'vnm',
  ]);
  const shown = ALL ? rows : rows.filter((r, i) => i < 12 || watch.has(r.n));
  console.log(
    '\n| Nation | Budget annuel | Revenu/j | Entretien/j | Entretien/revenu | Marge/j | Trésorerie J0 | J0 + 7 j | Coût local | Facteur national |',
  );
  console.log('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of shown)
    console.log(
      `| ${r.n} | ${fmt(r.budgetYear)} | ${fmt(r.income)} | ${fmt(r.upkeep)} | ${pct(r.ratio)} | ` +
        `${fmt(r.margin)} | ${fmt(r.money0)} | ${fmt(r.week)} | ${r.costIndex.toFixed(2)} | ${r.factor.toFixed(3)} |`,
    );
}
