// Banc du gouvernement sur les VRAIES données (monde 2025, ORBAT, ressources des provinces) :
// plusieurs nations jouées nomment leurs six titulaires et confient une dizaine de missions chacune
// (ressources, industrie, bases, fortification, défense antiaérienne, recherche, production, stocks,
// renseignement). Mesure : actions lancées, dépenses, missions terminées ou bloquées, temps de calcul
// d'une réflexion du gouvernement, et coût par jour de jeu par rapport à la même partie sans mission.
//   node --expose-gc bench/run.mjs gov
//   GOV_DAYS=4 GOV_NATIONS=fra,dza,deu,ind node bench/run.mjs gov
import { DAY, HOUR, type GovMissionInput, type NationId } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, viewFor } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { thinkNation } from '../src/modules/gov/missions.js';
import { gov as govState } from '../src/modules/gov/state.js';
import { setAiTracer } from '../src/ai/trace.js';
import { loadRealData } from './load.js';

const DAYS = Number(process.env.GOV_DAYS ?? 4);
const NATIONS = (process.env.GOV_NATIONS ?? 'fra,dza,deu,ind').split(',');

const data = loadRealData();
const world = buildWorld(data.map, data.catalog, data.balance, {
  research: data.research,
  orbats: data.orbats,
});

function game(): EngineState {
  return createGame(world, {
    seed: 11,
    players: NATIONS.map((nationId) => ({ nationId, isAi: false })),
    scenario: data.scenario,
  }) as EngineState;
}

/** Voisin terrestre (frontière) d'une nation, d'après la carte. */
function neighborOf(s: EngineState, n: NationId): NationId | undefined {
  for (const p of data.map.provinces) {
    if (s.provinces[p.id]?.owner !== n) continue;
    for (const q of p.neighbors) {
      const o = s.provinces[q]?.owner;
      if (o && o !== n) return o;
    }
  }
  return undefined;
}

function setup(s: EngineState): void {
  for (const n of NATIONS) {
    const gv = viewFor(s, n).government!;
    for (const o of gv.offices) {
      const c = [...o.candidates].sort((a, b) => b.rating - a.rating)[0]!;
      applyOrder(s, n, { kind: 'govAppoint', office: o.id, candidateId: c.id });
    }
    const nb = neighborOf(s, n);
    const share = (pct: number) => ({ mode: 'share' as const, pct });
    const missions: GovMissionInput[] = [
      { type: 'resource', resource: 'oil', budget: share(10) },
      { type: 'resource', resource: 'metals', budget: share(5) },
      { type: 'industry', budget: share(5) },
      { type: 'air_bases', budget: share(5) },
      { type: 'air_defense', budget: share(5) },
      { type: 'research_branch', branch: 'aero', budget: share(10) },
      { type: 'produce', category: 'air_defense', goal: 8, budget: share(10) },
      { type: 'stockpile', category: 'strike_missile', goal: 10, budget: share(5) },
      { type: 'counterintel', budget: share(2) },
      ...(nb
        ? [
            { type: 'fortify', nationId: nb, budget: share(5) },
            { type: 'watch', nationId: nb, budget: share(2) },
          ]
        : []),
    ];
    for (const m of missions) {
      const r = applyOrder(s, n, { kind: 'govMission', mission: m });
      if (!r.ok) console.log(`  ${n} ${m.type} refusée : ${r.message}`);
    }
  }
}

function run(withGov: boolean): { msPerDay: number; s: EngineState } {
  const s = game();
  if (withGov) setup(s);
  (globalThis as { gc?: () => void }).gc?.();
  const t0 = performance.now();
  advanceTo(s, s.time + DAYS * DAY);
  return { msPerDay: (performance.now() - t0) / DAYS, s };
}

const orders: Record<string, { ok: number; ko: number }> = {};
setAiTracer((_st, n, o, r) => {
  if (!NATIONS.includes(n)) return;
  const k = `${n}:${o.kind}`;
  orders[k] ??= { ok: 0, ko: 0 };
  if (r.ok) orders[k].ok++;
  else orders[k].ko++;
});
// Alternance (sans, avec, sans, avec) : la compilation à la volée ne favorise aucun des deux.
const base1 = run(false);
const gov1 = run(true);
const base2 = run(false);
for (const k of Object.keys(orders)) delete orders[k];
const gov = run(true);
setAiTracer(null);
const base = { msPerDay: (base1.msPerDay + base2.msPerDay) / 2 };
gov.msPerDay = (gov.msPerDay + gov1.msPerDay) / 2;

console.log(`Gouvernement — ${NATIONS.join(', ')} — ${DAYS} jours de jeu`);
console.log(`  sans mission : ${base.msPerDay.toFixed(0)} ms / jour`);
console.log(`  avec missions : ${gov.msPerDay.toFixed(0)} ms / jour`);
for (const n of NATIONS) {
  const v = viewFor(gov.s, n).government!;
  const all = [...v.missions, ...v.history];
  const spent = all.reduce((a, m) => a + m.spent, 0);
  const st = (x: string) => all.filter((m) => m.status === x).length;
  const acts = Object.keys(orders)
    .filter((k) => k.startsWith(`${n}:`))
    .map((k) => `${k.slice(n.length + 1)} ${orders[k]!.ok}/${orders[k]!.ok + orders[k]!.ko}`)
    .join(', ');
  console.log(
    `  ${n} : ${all.length} missions (en cours ${st('active')}, attente ${st('waiting')}, bloquées ${st('blocked')}, terminées ${st('done')}), dépensé ${(spent / 1e9).toFixed(2)} Md$ — ordres ${acts}`,
  );
  for (const m of all.filter((x) => x.status === 'blocked'))
    console.log(`     bloquée ${m.type} : ${m.why?.key}`);
}
// Coût d'une réflexion (toutes les missions d'une nation), mesuré à part.
// Pire cas : toutes les missions réexaminées (aucune attente de réexamen).
const N = 200;
let t1 = 0;
for (let i = 0; i < N; i++)
  for (const n of NATIONS) {
    const ms = govState(gov.s).nations[n]?.missions ?? {};
    for (const id of Object.keys(ms)) delete ms[id]!.retryAt;
    const t = performance.now();
    thinkNation(gov.s, n);
    t1 += performance.now() - t;
  }
console.log(
  `  réflexion du gouvernement : ${(t1 / (N * NATIONS.length)).toFixed(2)} ms par nation et par cycle sans réexamen différé (${(DAY / HOUR) * (60 / world.balance.time.aiThinkMinutes)} cycles par jour)`,
);
