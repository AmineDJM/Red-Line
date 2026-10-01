import { describe, expect, it } from 'vitest';
import { BalanceSchema, DAY, OrbatSchema, type Orbat } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { breakdown, budgetDay } from '../src/modules/eco/budget.js';
import { cfg } from '../src/modules/eco/config.js';
import { eco, orbatOf } from '../src/modules/eco/state.js';
import {
  nationUpkeepFactor,
  startUpkeepFactors,
  unitUpkeepPerDay,
  upkeepFactor,
} from '../src/modules/eco/upkeep.js';
import { loadRealData } from '../bench/load.js';
import { ECO_BALANCE, ORBATS, ecoGame, ecoWorldWith, upkeepOf } from './eco-fixtures.js';

const UPKEEP = {
  generationFactor: { '1': 0.6, '2': 0.7, '3': 0.85, '4': 1, '5': 1.1 },
  localShare: { infantry: 0.9 },
  localShareDefault: 0.5,
};
const BAL = BalanceSchema.parse({ ...ECO_BALANCE, upkeep: UPKEEP });

/** ORBAT de test : aaa au coût local 0,4, ddd sur-armée (entretien catalogue > budget). */
function orbats(ddd: Partial<Orbat> = {}): Orbat[] {
  return ORBATS.map((o) => {
    if (o.nationId === 'aaa') return OrbatSchema.parse({ ...o, costIndex: 0.4 });
    if (o.nationId === 'ddd')
      return OrbatSchema.parse({
        ...o,
        inventory: [
          { systemId: 'tst.infantry', count: 20 },
          { systemId: 'us.f-16', count: 1000 },
        ],
        ...ddd,
      });
    return o;
  });
}

const game = (balance = BAL, o = orbats(), seed = 1) =>
  ecoGame({ world: ecoWorldWith(balance, o), seed });

describe('entretien ajusté (âge, coût local, facteur national de départ)', () => {
  it('matériel ancien moins cher à entretenir que le moderne, prix catalogue inchangé', () => {
    const s = game();
    const f16 = s.world.catalog.get('us.f-16')!;
    const old = { ...f16, id: 'tst.old-jet', generation: 2 };
    const modern = { ...f16, id: 'tst.new-jet', generation: 5 };
    const a = unitUpkeepPerDay(s, 'bbb', old);
    const b = unitUpkeepPerDay(s, 'bbb', modern);
    expect(a).toBeLessThan(b);
    expect(a / b).toBeCloseTo(0.7 / 1.1, 9);
    // Le catalogue (prix réels) n'est pas modifié.
    expect(s.world.catalog.get('us.f-16')!.upkeepPerDay).toBe(f16.upkeepPerDay);
    expect(s.world.catalog.get('us.f-16')!.cost.money).toBe(f16.cost.money);
    // Infanterie : soldes, pas de dépendance à la génération.
    const inf = s.world.catalog.get('tst.infantry')!;
    expect(unitUpkeepPerDay(s, 'bbb', { ...inf, id: 'tst.inf2', generation: 1 })).toBeCloseTo(
      unitUpkeepPerDay(s, 'bbb', { ...inf, id: 'tst.inf5', generation: 5 }),
      9,
    );
  });

  it('coût local : la part locale de l’entretien suit l’indice de la nation', () => {
    const s = game();
    const inf = s.world.catalog.get('tst.infantry')!;
    // Infanterie : part locale 0,9 → 0,1 + 0,9 × 0,4 = 0,46 du prix catalogue pour aaa.
    expect(upkeepFactor(s, 'aaa', inf) / nationUpkeepFactor(s, 'aaa')).toBeCloseTo(0.46, 9);
    expect(upkeepFactor(s, 'bbb', inf)).toBeCloseTo(1, 9);
    // Autres catégories : part locale par défaut 0,5 → 0,7 (génération comprise).
    const sam = s.world.catalog.get('tst.sam')!;
    const gen = UPKEEP.generationFactor[String(sam.generation) as '1'] ?? 1;
    expect(upkeepFactor(s, 'aaa', sam) / nationUpkeepFactor(s, 'aaa')).toBeCloseTo(0.7 * gen, 9);
  });

  it('armée réelle plus chère que le budget : plafonnée à maxStartShare, plus de déficit', () => {
    const big = (maxStartShare: number) =>
      game(BalanceSchema.parse({ ...ECO_BALANCE, upkeep: { ...UPKEEP, maxStartShare } }));
    const raw = big(1e9);
    expect(upkeepOf(raw, 'ddd')).toBeGreaterThan(budgetDay(raw, 'ddd'));
    expect(breakdown(raw, 'ddd').upkeepTotal).toBeGreaterThan(breakdown(raw, 'ddd').total);

    const s = big(0.7);
    const b = breakdown(s, 'ddd');
    expect(b.upkeepTotal).toBeCloseTo(0.7 * budgetDay(s, 'ddd'), 0);
    expect(b.total - b.upkeepTotal).toBeGreaterThan(0);
    expect(eco(s).upk!.ddd).toBeLessThan(1);
    // Les nations sous le plafond ne sont pas touchées.
    expect(eco(s).upk!.bbb).toBeUndefined();
    // La trésorerie progresse jour après jour.
    const m0 = s.nations.ddd!.money;
    advanceTo(s, 3 * DAY);
    expect(s.nations.ddd!.money).toBeGreaterThan(m0);
    // Vue Économie : entretien au prix catalogue et facteur moyen.
    const d = viewFor(s, 'ddd').economy.detail!;
    expect(d.upkeepAdjust!.catalog).toBeGreaterThan(d.upkeepTotal);
    expect(d.upkeepAdjust!.factor).toBeCloseTo(d.upkeepTotal / d.upkeepAdjust!.catalog, 2);

    // Part propre à la nation (ORBAT upkeepShare).
    const t = game(BAL, orbats({ upkeepShare: 0.55 }));
    expect(breakdown(t, 'ddd').upkeepTotal).toBeCloseTo(0.55 * budgetDay(t, 'ddd'), 0);
    // Plancher optionnel : relève l'entretien d'une armée minuscule.
    const u = game(
      BalanceSchema.parse({ ...ECO_BALANCE, upkeep: { ...UPKEEP, minStartShare: 0.3 } }),
    );
    expect(breakdown(u, 'bbb').upkeepTotal).toBeCloseTo(0.3 * budgetDay(u, 'bbb'), 0);
  });

  it('déterminisme, sauvegarde et migration d’une sauvegarde antérieure (rejeu identique)', () => {
    const a = game();
    const b = game();
    expect(eco(a).upk).toEqual(eco(b).upk);
    expect(Object.keys(eco(a).upk!)).toContain('ddd');
    advanceTo(a, 2 * DAY);
    advanceTo(b, 2 * DAY);
    expect(stateHash(a)).toBe(stateHash(b));

    // Sauvegarde antérieure (sans facteur national) : recalculé à l'identique au chargement.
    const old = deserializeState(a.world, serializeState(a)) as EngineState;
    delete eco(old).upk;
    const bytes = serializeState(old);
    const r1 = deserializeState(a.world, bytes) as EngineState;
    const r2 = deserializeState(a.world, bytes) as EngineState;
    expect(eco(r1).upk).toEqual(eco(a).upk);
    expect(startUpkeepFactors(r1)).toEqual(eco(a).upk);
    for (const s of [a, r1, r2]) advanceTo(s, 4 * DAY);
    expect(stateHash(r1)).toBe(stateHash(a));
    expect(stateHash(r2)).toBe(stateHash(a));
  });
});

describe('vraies données : aucun déficit structurel au départ', () => {
  // Nations jouées → la première semaine permet-elle aussi une base militaire (5e8 $) ?
  // (Algérie 1985 : 2,8 G$ de budget annuel en dollars 2025, la base attend quelques semaines.)
  const cases: [string, Record<string, boolean>][] = [
    ['world-today', { mar: true, dza: true, fra: true }],
    ['cold-war-1985', { dza: false, fra: true }],
  ];
  for (const [scenario, players] of cases) {
    it(scenario, { timeout: 300_000 }, () => {
      const d = loadRealData(scenario);
      const world = buildWorld(d.map, d.catalog, d.balance, {
        research: d.research,
        orbats: d.orbats,
      });
      const s = createGame(world, {
        seed: 7,
        players: [{ nationId: Object.keys(players)[0]!, isAi: false }],
        aiLevel: 'normal',
        scenario: d.scenario,
        speed: 1,
      }) as EngineState;
      const max = cfg(world).upkeep.maxStartShare;
      const margin = new Map<string, number>();
      let checked = 0;
      for (const n of s.nationIds) {
        if (!orbatOf(s, n) || budgetDay(s, n) <= 0) continue;
        const b = breakdown(s, n);
        checked++;
        expect(b.upkeepTotal, n).toBeLessThan(b.total);
        expect(b.upkeepTotal / b.total, n).toBeLessThanOrEqual(max + 1e-6);
        margin.set(n, b.total - b.upkeepTotal);
      }
      expect(checked).toBeGreaterThan(scenario === 'world-today' ? 190 : 25);

      // Les grandes puissances gardent leur avance : États-Unis, Chine, Russie en 2025 ; les deux
      // superpuissances en 1985.
      const ranked = [...margin.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n);
      if (scenario === 'world-today') {
        expect(ranked[0]).toBe('usa');
        expect(ranked.slice(0, 3).sort()).toEqual(['chn', 'rus', 'usa']);
      } else expect(ranked.slice(0, 2).sort()).toEqual(['rus', 'usa']);

      // Un joueur peut produire dans la première semaine : quelques chasseurs modernes OU un bâtiment.
      const bytes = serializeState(s);
      for (const [n, canBuild] of Object.entries(players)) {
        const cap = wi(world).nationById.get(n)!.capitalProvinceId!;
        const fighter = scenario === 'world-today' ? 'us.f-16' : 'eu.mirage-f1';
        const g1 = deserializeState(world, bytes) as EngineState;
        g1.nations[n]!.isAi = false;
        const r = applyOrder(g1, n, {
          kind: 'produce',
          provinceId: cap,
          systemId: fighter,
          count: 4,
        });
        expect(r.ok, `${n} : ${JSON.stringify(r)}`).toBe(true);
        expect(margin.get(n)!).toBeGreaterThan(0);
        if (!canBuild) continue;
        const g2 = deserializeState(world, bytes) as EngineState;
        g2.nations[n]!.isAi = false;
        const m0 = g2.nations[n]!.money;
        const site = (wi(world).provsByNation.get(n) ?? []).find(
          (p) => !wi(world).provById.get(p)!.buildings.includes('military_base'),
        )!;
        const rb = applyOrder(g2, n, {
          kind: 'build',
          provinceId: site,
          building: 'military_base',
        });
        expect(rb.ok, `${n} : ${JSON.stringify(rb)}`).toBe(true);
        expect(m0 - g2.nations[n]!.money).toBeCloseTo(
          cfg(world).buildings.buildCostUsd.military_base!,
          0,
        );
      }
    });
  }
});
