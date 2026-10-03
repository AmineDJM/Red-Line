/**
 * Missions et opérations successives, enchaînement de phases et nouvelles opérations sur les VRAIES
 * données (monde 2025, ORBAT en piles mixtes, réseau de routes) — joueur humain, généraux du vivier,
 * forces d'office, aucune province en dur (villes de real-places.ts, voisinages de la carte).
 *
 * Non-régression « une seule mission puis plus rien » : la même armée et les mêmes généraux
 * enchaînent trois missions ou opérations (Luxembourg, Charleroi, Belgique, Pays-Bas) avec des ordres
 * réellement émis à chaque étape ; une opération en deux phases (SEAD puis conquête) exécute la
 * seconde après la première. Résultats par catégorie : contre-offensive (terre), interdiction (air),
 * supériorité navale et assaut amphibie (mer), bouclier antimissile (DCA), guerre éclair (interarmées).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, distanceKm, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { atWar, sysOf, unitPosAt } from '../src/state/access.js';
import { declareWar } from '../src/state/war.js';
import { transferProvince } from '../src/combat/capture.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cmd, type OpSt } from '../src/modules/command/state.js';
import { statOf } from '../src/modules/mil/stats.js';
import { mil } from '../src/modules/mil/state.js';
import { buildingsOf, strikeRangeKm } from '../src/modules/mil/util.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
}, 120_000);

function game(players: [string, boolean][], seed = 3): EngineState {
  return createGame(world, {
    seed,
    players: players.map(([nationId, isAi]) => ({ nationId, isAi })),
    scenario: data.scenario,
  }) as EngineState;
}

function ok(s: EngineState, n: string, o: Order): void {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
}

const KEY: Record<string, 'offense' | 'air' | 'naval' | 'defense'> = {
  land: 'offense',
  air: 'air',
  sea: 'naval',
  ad: 'defense',
};

/** Meilleurs candidats des commandements demandés (comme l'état-major proposé du QG). */
function staff(s: EngineState, n: string, branches: string[]): { candidateId: string }[] {
  const v = viewFor(s, n).command!;
  const used = new Set<string>();
  return branches.map((b) => {
    const c = v
      .branches!.find((x) => x.id === b)!
      .candidates.filter((x) => !used.has(x.id))
      .sort((x, y) => y.skills[KEY[b]!] - x.skills[KEY[b]!] || (x.id < y.id ? -1 : 1))[0]!;
    used.add(c.id);
    return { candidateId: c.id };
  });
}

function lastOp(s: EngineState): OpSt {
  const ops = cmd(s).ops!;
  return ops[
    Object.keys(ops)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .pop()!
  ]!;
}

/** Ordres acceptés des généraux de `n` pendant `fn`, par type. */
function ordersDuring(n: string, fn: () => void): Record<string, number> {
  const out: Record<string, number> = {};
  setAiTracer((_s, who, o, r) => {
    if (who === n && r.ok) out[(o as Order).kind] = (out[(o as Order).kind] ?? 0) + 1;
  });
  try {
    fn();
  } finally {
    setAiTracer(null);
  }
  return out;
}

const acts = (o: Record<string, number>) =>
  (o.move ?? 0) + (o.attack ?? 0) + (o.strike ?? 0) + (o.patrol ?? 0) + (o.blockade ?? 0);

/** Avance heure par heure jusqu'à la fin de l'opération (ou `hours`). */
function runOp(s: EngineState, op: OpSt, hours: number): number {
  const t0 = s.time;
  let h = 0;
  while (h < hours && op.status !== 'success' && op.status !== 'failed') {
    h++;
    advanceTo(s, t0 + h * HOUR);
  }
  return h;
}

function taken(s: EngineState, op: OpSt, n: string): number {
  return op.targets.filter((p) => s.provinces[p]?.owner === n).length;
}

describe('missions et opérations successives (vraies données)', { timeout: 1_800_000 }, () => {
  it('France : Luxembourg, puis Charleroi (mission), puis Belgique et Pays-Bas avec les mêmes généraux', () => {
    const s = game([
      ['fra', false],
      ['lux', true],
      ['bel', true],
      ['nld', true],
    ]);
    // 1. Opération 1 : conquête du Luxembourg (armée de terre + aviation, forces d'office).
    ok(s, 'fra', {
      kind: 'campaignCreate',
      name: 'Un',
      goal: 'conquest',
      nations: ['lux'],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'fra', ['land', 'air']),
    });
    const op1 = lastOp(s);
    const o1 = ordersDuring('fra', () => runOp(s, op1, 72));
    expect(op1.status).toBe('success');
    expect(acts(o1)).toBeGreaterThan(0);
    const land = op1.armies.find((id) => op1.roles[id] === 'land')!;
    const gens = op1.armies.map((id) => cmd(s).armies[id]!.general!);
    // Après la victoire, l'armée tient ses gains (posture) au lieu de rester inerte.
    expect(cmd(s).armies[land]!.post).toBe('hold');

    // 2. Mission confiée à l'armée de terre de l'opération close : prendre Charleroi.
    const charleroi = provinceAt(data.map, PLACES.charleroi).id;
    ok(s, 'fra', {
      kind: 'armyMission',
      armyId: land,
      mission: { type: 'conquer', provinceId: charleroi, roe: 'free', aggr: 'bold' },
    });
    const a = cmd(s).armies[land]!;
    const t2 = s.time;
    const o2 = ordersDuring('fra', () => {
      for (let h = 1; h <= 72 && a.status !== 'success'; h++) advanceTo(s, t2 + h * HOUR);
    });
    expect(acts(o2)).toBeGreaterThan(0);
    expect(a.status).toBe('success');
    expect(s.provinces[charleroi]!.owner).toBe('fra');

    // 3. Opération 2 : conquête de la Belgique, mêmes généraux (sans armée désignée, comme le QG).
    ok(s, 'fra', {
      kind: 'campaignCreate',
      name: 'Deux',
      goal: 'conquest',
      nations: ['bel'],
      roe: 'free',
      aggr: 'bold',
      commanders: gens.map((generalId) => ({ generalId })),
    });
    const op2 = lastOp(s);
    const h2 = { h: 0 };
    const o3 = ordersDuring('fra', () => {
      h2.h = runOp(s, op2, 6 * 24);
    });
    expect(acts(o3)).toBeGreaterThan(0);
    expect(taken(s, op2, 'fra')).toBeGreaterThan(0);
    expect(op2.status).toBe('success');

    // 4. Opération 3 : Pays-Bas, toujours les mêmes généraux.
    ok(s, 'fra', {
      kind: 'campaignCreate',
      name: 'Trois',
      goal: 'conquest',
      nations: ['nld'],
      roe: 'free',
      aggr: 'bold',
      commanders: gens.map((generalId) => ({ generalId })),
    });
    const op3 = lastOp(s);
    const o4 = ordersDuring('fra', () => runOp(s, op3, 4 * 24));
    expect(acts(o4)).toBeGreaterThan(0);
    expect(taken(s, op3, 'fra')).toBeGreaterThan(0);
    console.info(
      `Successives : Luxembourg ${op1.status}, Charleroi ${a.status}, Belgique ${op2.status} en ${h2.h} h, Pays-Bas ${taken(s, op3, 'fra')}/${op3.targets.length} (${op3.status})`,
    );
  });

  it('chaîne de 2 phases (SEAD puis conquête de la Belgique) : la phase 2 suit la phase 1', () => {
    const s = game([
      ['fra', false],
      ['bel', true],
    ]);
    ok(s, 'fra', {
      kind: 'campaignCreate',
      name: 'Chaîne',
      goal: 'sead',
      nations: ['bel'],
      roe: 'free',
      aggr: 'bold',
      phaseHours: 24,
      phases: [{ goal: 'conquest' }],
      commanders: staff(s, 'fra', ['air', 'land', 'land']),
    });
    const op = lastOp(s);
    const per: Record<number, Record<string, number>> = {};
    const t0 = s.time;
    let h = 0;
    while (h < 6 * 24 && op.status !== 'success' && op.status !== 'failed') {
      h++;
      const step = op.step ?? 0;
      const o = ordersDuring('fra', () => advanceTo(s, t0 + h * HOUR));
      const acc = (per[step] ??= {});
      for (const k of Object.keys(o)) acc[k] = (acc[k] ?? 0) + o[k]!;
    }
    console.info(
      `Chaîne SEAD → conquête : phase 1 ${op.results?.[0]} (${JSON.stringify(per[0])}), phase 2 ${op.status} à H+${h} (${JSON.stringify(per[1])})`,
    );
    expect(op.step).toBe(1);
    expect(op.goal).toBe('conquest');
    expect(acts(per[0]!)).toBeGreaterThan(0);
    expect(acts(per[1]!)).toBeGreaterThan(0);
    expect(taken(s, op, 'fra')).toBeGreaterThan(0);
    expect(op.status).toBe('success');
  });
});

describe('capitale et brigades (vraies données)', { timeout: 1_800_000 }, () => {
  it('SEAD puis conquête du Luxembourg, agressivité équilibrée, état-major proposé : la capitale tombe', () => {
    // Avant correction : chaque général de l'armée de terre n'a qu'une brigade, la capitale exige
    // « deux piles moyennes » × 1,5 : « forces insuffisantes » pendant cinq jours, puis échec.
    const s = game([['fra', false]], 7);
    ok(s, 'fra', {
      kind: 'campaignCreate',
      name: 'Ciel puis terre',
      goal: 'sead',
      nations: ['lux'],
      phaseHours: 6,
      phases: [{ goal: 'conquest' }],
      commanders: staff(s, 'fra', ['air', 'land', 'ad', 'sea', 'land']),
    });
    const op = lastOp(s);
    expect(op.aggr).toBe('balanced');
    const h = runOp(s, op, 4 * 24);
    console.info(`Capitale (brigades, équilibrée) : ${op.status} à H+${h}, ${op.captures} prises`);
    expect(op.step).toBe(1);
    expect(op.status).toBe('success');
    expect(op.targets.every((p) => s.provinces[p]!.owner === 'fra')).toBe(true);
  });
});

describe('nouvelles opérations : résultats (vraies données)', { timeout: 1_800_000 }, () => {
  it('Terre — contre-offensive : la France reprend la province de Lille perdue', () => {
    const s = game([
      ['fra', false],
      ['bel', true],
    ]);
    const lille = provinceAt(data.map, PLACES.lille).id;
    declareWar(s, 'bel', 'fra');
    transferProvince(s, lille, 'bel');
    expect(s.provinces[lille]!.owner).toBe('bel');
    ok(s, 'fra', {
      kind: 'campaignCreate',
      goal: 'counteroffensive',
      nations: [],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'fra', ['land', 'air']),
    });
    const op = lastOp(s);
    expect(op.targets).toContain(lille);
    const h = runOp(s, op, 3 * 24);
    console.info(`Contre-offensive : Lille ${s.provinces[lille]!.owner} à H+${h}, ${op.status}`);
    expect(s.provinces[lille]!.owner).toBe('fra');
    expect(op.status).toBe('success');
  });

  it('Air — interdiction (Russie → Ukraine) : installations logistiques frappées', () => {
    const s = game([
      ['rus', false],
      ['ukr', true],
    ]);
    ok(s, 'rus', {
      kind: 'campaignCreate',
      goal: 'interdiction',
      nations: ['ukr'],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'rus', ['air', 'air']),
    });
    const op = lastOp(s);
    const o = ordersDuring('rus', () => advanceTo(s, 2 * DAY));
    const m = op.prog.find((p) => p.key === 'logistics')!;
    console.info(
      `Interdiction : ${o.strike ?? 0} frappes, logistique ${m.done}/${m.total}, ${op.cnt?.moving ?? 0} frappes sur des colonnes`,
    );
    expect(o.strike ?? 0).toBeGreaterThan(10);
    expect(m.total).toBeGreaterThan(0);
    expect(m.done).toBeGreaterThan(0);
  });

  it('Mer — supériorité navale (Turquie → Grèce) : navires grecs coulés', () => {
    const s = game([
      ['tur', false],
      ['grc', true],
    ]);
    ok(s, 'tur', {
      kind: 'campaignCreate',
      goal: 'naval_supremacy',
      nations: ['grc'],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'tur', ['sea', 'air']),
    });
    const op = lastOp(s);
    const o = ordersDuring('tur', () => advanceTo(s, 3 * DAY));
    const m = op.prog.find((p) => p.key === 'ships')!;
    console.info(
      `Supériorité navale : navires grecs coulés ${m.done}/${m.total}, ordres ${JSON.stringify(o)}`,
    );
    expect(m.total).toBeGreaterThan(0);
    expect(m.done).toBeGreaterThan(0);
  });

  it('Mer — assaut amphibie (Italie → Malte) : l’île est prise', () => {
    const s = game([
      ['ita', false],
      ['mlt', true],
    ]);
    ok(s, 'ita', {
      kind: 'campaignCreate',
      goal: 'amphibious',
      nations: ['mlt'],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'ita', ['land', 'sea', 'air']),
    });
    const op = lastOp(s);
    const malta = provinceAt(data.map, PLACES.laValette).id;
    expect(op.targets).toContain(malta);
    const o = ordersDuring('ita', () => runOp(s, op, 5 * 24));
    console.info(
      `Assaut amphibie : Malte ${s.provinces[malta]!.owner}, ${op.status}, ordres ${JSON.stringify(o)}`,
    );
    expect(s.provinces[malta]!.owner).toBe('ita');
    expect(op.status).toBe('success');
  });

  it('DCA — bouclier antimissile (Ukraine) : une salve russe sur Kiev est interceptée', () => {
    const s = game([
      ['ukr', false],
      ['rus', false],
    ]);
    declareWar(s, 'rus', 'ukr');
    ok(s, 'ukr', {
      kind: 'campaignCreate',
      goal: 'missile_shield',
      nations: [],
      roe: 'free',
      commanders: staff(s, 'ukr', ['ad', 'ad']),
    });
    const op = lastOp(s);
    const kiev = provinceAt(data.map, PLACES.kiev);
    expect(op.gd!.sites![0]).toBe(kiev.id);
    // Le bouclier se met en place (DCA à la capitale), puis la Russie tire une salve balistique.
    advanceTo(s, 18 * HOUR);
    const ads = op.armies.flatMap((id) => cmd(s).armies[id]!.units).map((id) => s.units[id]!);
    const atKiev = ads.filter(
      (u) => u && distanceKm(unitPosAt(s, u, s.time), kiev.cityPoint) <= 60,
    );
    expect(atKiev.length).toBeGreaterThan(0);
    // Missiles russes (balistiques d'abord, sinon de croisière) à portée de Kiev.
    const launcher = Object.values(s.units)
      .filter((u) => {
        if (u.owner !== 'rus' || u.role || u.off) return false;
        const sy = sysOf(s, u);
        return sy.category === 'strike_missile' && !!sy.missile && sy.missile.warhead !== 'nuclear';
      })
      .map((u) => ({ u, d: distanceKm(unitPosAt(s, u, s.time), kiev.cityPoint) }))
      .filter((x) => x.d <= strikeRangeKm(sysOf(s, x.u)))
      .sort(
        (x, y) =>
          Number(sysOf(s, y.u).missile!.kind === 'ballistic') -
            Number(sysOf(s, x.u).missile!.kind === 'ballistic') ||
          x.d - y.d ||
          (x.u.id < y.u.id ? -1 : 1),
      )[0]?.u as Unit | undefined;
    expect(launcher).toBeDefined();
    const before = statOf(s, 'ukr').intercepted;
    ok(s, 'rus', {
      kind: 'strike',
      unitIds: [launcher!.id],
      target: { type: 'building', provinceId: kiev.id, building: buildingsOf(s, kiev.id)[0]! },
      count: Math.min(launcher!.count, 8),
    } as Order);
    advanceTo(s, s.time + 2 * HOUR);
    const icp = statOf(s, 'ukr').intercepted - before;
    const m = op.prog.find((p) => p.key === 'sites')!;
    console.info(`Bouclier : ${icp} missiles interceptés, sites couverts ${m.done}/${m.total}`);
    expect(icp).toBeGreaterThan(0);
    expect(op.prog.find((p) => p.key === 'intercepts')!.done).toBeGreaterThan(0);
  });

  it('Interarmées — guerre éclair (Turquie → Syrie) : phases enchaînées jusqu’à la percée', () => {
    const s = game([
      ['tur', false],
      ['syr', true],
    ]);
    ok(s, 'tur', {
      kind: 'campaignCreate',
      goal: 'blitz',
      nations: ['syr'],
      roe: 'free',
      aggr: 'bold',
      commanders: staff(s, 'tur', ['air', 'land', 'land', 'ad']),
    });
    const op = lastOp(s);
    const goals: string[] = [];
    const t0 = s.time;
    for (let h = 1; h <= 6 * 24 && op.status !== 'success' && op.status !== 'failed'; h++) {
      advanceTo(s, t0 + h * HOUR);
      if (goals[goals.length - 1] !== op.goal) goals.push(op.goal);
    }
    console.info(
      `Guerre éclair : phases ${goals.join(' → ')}, issues ${JSON.stringify(op.results)}, ${op.status}, prises ${op.captures}`,
    );
    expect(goals.slice(0, 3)).toEqual(['sead', 'air_control', 'breakthrough']);
    expect(op.captures).toBeGreaterThan(0);
    expect(atWar(s, 'tur', 'syr')).toBe(true);
    expect(mil(s)).toBeDefined();
  });
});
