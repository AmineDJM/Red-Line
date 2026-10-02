// Banc du centre de commandement sur les VRAIES données (monde 2025, ORBAT en piles mixtes) :
// la France crée une armée avec ses piles proches de la Belgique, recrute un général et lui confie
// « Conquérir » sur une province belge voisine (choisie d'après la carte, sans identifiant en dur).
// Mesure : issue, durée, ordres du général (acceptés / refusés), coût de calcul par jour de jeu par
// rapport à la même partie sans armée commandée.
//   node --expose-gc bench/run.mjs command
//   CMD_DAYS=4 CMD_SEEDS=1,2 CMD_AGGR=cautious,bold node bench/run.mjs command
import { DAY, HOUR, distanceKm, type Order } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, viewFor } from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { sysOf, unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cmd } from '../src/modules/command/state.js';
import { loadRealData } from './load.js';

const DAYS = Number(process.env.CMD_DAYS ?? 4);
const SEEDS = (process.env.CMD_SEEDS ?? '1').split(',').map(Number);
const AGGRS = (process.env.CMD_AGGR ?? 'balanced').split(',') as (
  'cautious' | 'balanced' | 'bold'
)[];
const ME = process.env.CMD_NATION ?? 'fra';
const FOE = process.env.CMD_FOE ?? 'bel';

const data = loadRealData();
const world = buildWorld(data.map, data.catalog, data.balance, {
  research: data.research,
  orbats: data.orbats,
});
const w = wi(world);

function game(seed: number): EngineState {
  return createGame(world, {
    seed,
    players: [
      { nationId: ME, isAi: false },
      { nationId: FOE, isAi: true },
    ],
    scenario: data.scenario,
  }) as EngineState;
}

/** Province ennemie voisine de la plus grande concentration de piles terrestres du joueur. */
function pickTarget(s: EngineState): { pid: string; piles: Unit[] } {
  const land = Object.values(s.units).filter(
    (u) =>
      u.owner === ME &&
      !u.off &&
      !u.role &&
      sysOf(s, u).movement === 'land' &&
      sysOf(s, u).speedKmh > 0,
  );
  let best: { pid: string; piles: Unit[]; score: number } | null = null;
  for (const p of data.map.provinces) {
    if (p.nationId !== FOE) continue;
    if (!p.neighbors.some((x) => s.provinces[x]?.owner === ME)) continue;
    const near = land
      .map((u) => ({ u, d: distanceKm(unitPosAt(s, u, s.time), p.cityPoint) }))
      .filter((x) => x.d <= 400)
      .sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1))
      .slice(0, 6)
      .map((x) => x.u);
    const score = near.length * 1000 - (near.length ? distanceKm(near[0]!.pos, p.cityPoint) : 1e6);
    if (near.some((u) => sysOf(s, u).canCapture) && (!best || score > best.score))
      best = { pid: p.id, piles: near, score };
  }
  return best!;
}

function cpu(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

for (const seed of SEEDS) {
  // Référence : même partie, aucune armée commandée.
  const ref = game(seed);
  let refMs = 0;
  for (let d = 1; d <= DAYS; d++) {
    const t0 = cpu();
    advanceTo(ref, d * DAY);
    refMs += cpu() - t0;
  }
  for (const aggr of AGGRS) {
    const s = game(seed);
    const { pid, piles } = pickTarget(s);
    const log: { ok: boolean; kind: string; reason?: string }[] = [];
    setAiTracer((_st, n, o, r) => {
      if (n === ME) log.push({ ok: r.ok, kind: (o as Order).kind, reason: r.reason ?? r.error });
    });
    const ok = (o: Order) => {
      const r = applyOrder(s, ME, o);
      if (!r.ok) throw new Error(`${o.kind}: ${r.message}`);
    };
    ok({ kind: 'armyCreate', name: '1re Armée', unitIds: piles.map((u) => u.id) });
    const army = Object.keys(cmd(s).armies)[0]!;
    const cands = viewFor(s, ME).command!.candidates;
    const pick =
      aggr === 'cautious'
        ? cands.slice().sort((a, b) => a.skills.audacity - b.skills.audacity)[0]!
        : aggr === 'bold'
          ? cands.slice().sort((a, b) => b.skills.audacity - a.skills.audacity)[0]!
          : cands.slice().sort((a, b) => b.skills.offense - a.skills.offense)[0]!;
    ok({ kind: 'generalHire', candidateId: pick.id, armyId: army });
    ok({
      kind: 'armyMission',
      armyId: army,
      mission: { type: 'conquer', provinceId: pid, aggr, roe: 'free' },
    });
    let ms = 0;
    let took: number | null = null;
    for (let d = 1; d <= DAYS; d++) {
      for (let h = 1; h <= 24; h += 1) {
        const t0 = cpu();
        advanceTo(s, (d - 1) * DAY + h * HOUR);
        ms += cpu() - t0;
        if (took === null && s.provinces[pid]!.owner === ME) took = s.time;
      }
    }
    setAiTracer(null);
    const a = cmd(s).armies[army]!;
    const prov = w.provById.get(pid)!;
    console.log(
      `graine ${seed} · ${aggr} · cible ${prov.cityName ?? prov.name} (${pid}) · ${piles.length} piles · ` +
        `général ${pick.first} ${pick.last} (off ${pick.skills.offense}, aud ${pick.skills.audacity}, exp ${pick.skills.experience})`,
    );
    console.log(
      `  prise : ${took === null ? 'non' : `J+${(took / DAY).toFixed(2)}`} · état ${a.status} · ` +
        `effectifs ${Math.round((100 * a.now) / Math.max(1, a.start))} % · pertes ${a.losses} éléments`,
    );
    const counts = new Map<string, [number, number]>();
    for (const x of log) {
      const c = counts.get(x.kind) ?? [0, 0];
      c[x.ok ? 0 : 1]++;
      counts.set(x.kind, c);
    }
    console.log(
      `  ordres du général : ${[...counts].map(([k, [o, f]]) => `${k} ${o}${f ? ` (${f} refusés)` : ''}`).join(', ')}`,
    );
    console.log(
      `  calcul : ${(ms / DAYS).toFixed(0)} ms/jour (référence sans armée : ${(refMs / DAYS).toFixed(0)} ms/jour)`,
    );
    for (const e of a.journal.slice(-12))
      console.log(
        `    J+${(e.t / DAY).toFixed(2)} ${e.text.key} ${JSON.stringify(e.text.params ?? {})}`,
      );
  }
}
