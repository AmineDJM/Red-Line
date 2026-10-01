import { describe, expect, it } from 'vitest';
import {
  CostSettingsSchema,
  DEFAULT_COST_SETTINGS,
  ZERO_USAGE,
  computeCostReport,
  costAlerts,
  type CostInput,
  type Usage,
} from '../src/costs.js';

const u = (p: Partial<Usage>): Usage => ({ ...ZERO_USAGE, ...p });
const H = 3_600_000;
const from = Date.UTC(2026, 8, 1);

/** 73 h = un dixième de mois (730 h) : coûts fixes de la période = 10 % du mensuel. */
function input(): CostInput {
  return {
    from: new Date(from).toISOString(),
    to: new Date(from + 73 * H).toISOString(),
    now: new Date(from + 73 * H).toISOString(),
    server: {
      ...u({ wsBytes: 6e9, httpBytes: 0.5e9 }),
      cpuProcessMs: 73 * H * 0.45,
      rssMbH: 73 * 300,
      rssMaxMb: 380,
      peakPlayers: 3,
      peakGames: 3,
    },
    games: [
      {
        id: 'g1',
        name: 'Solo',
        mode: 'solo',
        status: 'running',
        humans: ['u1'],
        createdBy: 'u1',
        usage: u({ cpuSimMs: 2000, cpuFlushMs: 1000, memMbH: 100, playS: 3600 }),
        storageBytes: 300,
      },
      {
        id: 'g2',
        name: 'Multi',
        mode: 'multi',
        status: 'running',
        humans: ['u2', 'u3'],
        createdBy: 'u2',
        usage: u({ cpuSimMs: 1000, memMbH: 300, playS: 3600 }),
        storageBytes: 100,
      },
      {
        id: 'g3',
        name: 'IA',
        mode: 'multi',
        status: 'running',
        humans: [],
        createdBy: null,
        usage: u({}),
        storageBytes: 0,
      },
    ],
    users: [
      {
        id: 'u1',
        name: 'Gratuit',
        kind: 'free',
        usage: u({ wsBytes: 3e9, playS: 3600 }),
        paidEurCents: 0,
        refundedEurCents: 0,
        payments: 0,
      },
      {
        id: 'u2',
        name: 'Invité',
        kind: 'guest',
        usage: u({ wsBytes: 1e9, playS: 3600 }),
        paidEurCents: 0,
        refundedEurCents: 0,
        payments: 0,
      },
      {
        id: 'u3',
        name: 'Admin',
        kind: 'staff',
        usage: u({ wsBytes: 1e9 }),
        paidEurCents: 0,
        refundedEurCents: 0,
        payments: 0,
      },
      {
        id: 'u4',
        name: 'Payant',
        kind: 'paying',
        usage: u({}),
        paidEurCents: 1000,
        refundedEurCents: 0,
        payments: 1,
      },
    ],
    entriesUsd: 10,
    entriesByCategory: { video_api: 10 },
    dbBytes: 1e8,
  };
}

describe('attribution des coûts', () => {
  const r = computeCostReport(input(), DEFAULT_COST_SETTINGS);
  const user = (id: string) => r.users!.find((x) => x.id === id)!;

  it('coûts fixes de la période (calcul, base) et variables (bande passante, Stripe, autres)', () => {
    expect(r.monthFraction).toBeCloseTo(0.1, 9);
    expect(r.cost.compute).toBeCloseTo(0.7, 9);
    expect(r.cost.database).toBeCloseTo(0.75, 9); // (6 + 5 Go × 0,30) × 10 %
    expect(r.cost.bandwidth).toBeCloseTo(0.9, 9); // (6,5 Go − 0,5 inclus) × 0,15
    expect(r.cost.stripe).toBeCloseTo(0.432, 9); // 0,25 € + 1,5 % de 10 €, en dollars
    expect(r.cost.other).toBe(10);
    expect(r.cost.total).toBeCloseTo(12.782, 9);
  });

  it('partie répartie au prorata CPU / mémoire puis à parts égales entre ses joueurs', () => {
    const g1 = r.games!.find((g) => g.id === 'g1')!;
    expect(g1.cost.compute).toBeCloseTo(0.35, 9);
    expect(g1.cost.database).toBeCloseTo(0.5625, 9);
    expect(user('u2').cost.compute).toBeCloseTo(0.175, 9);
    expect(user('u3').cost.database).toBeCloseTo(0.09375, 9);
    // Octets directs + octets partagés (statiques) au prorata du temps de jeu.
    expect(user('u1').cost.bandwidth).toBeCloseTo((3.75 / 6.5) * 0.9, 9);
    expect(user('u1').cost.other).toBeCloseTo(2.5, 9);
    const sum = r.users!.reduce((a, x) => a + x.cost.total, 0);
    expect(sum + r.unattributedUsd).toBeCloseTo(r.cost.total, 9);
  });

  it('recettes nettes (TVA, frais), marge, ARPU, ARPPU, conversion, cohortes', () => {
    expect(r.revenue.grossUsd).toBeCloseTo(10.8, 9);
    expect(r.revenue.vatUsd).toBeCloseTo(1.8, 9);
    expect(r.revenue.netUsd).toBeCloseTo(8.568, 9);
    expect(r.marginUsd).toBeCloseTo(8.568 - 12.782, 9);
    expect(r.activeUsers).toBe(3); // l'équipe est exclue
    expect(r.payingUsers).toBe(1);
    expect(r.conversion).toBeCloseTo(0.5, 9);
    expect(r.arppuUsd).toBeCloseTo(8.568, 9);
    expect(r.cohorts.free.users).toBe(1);
    expect(r.cohorts.free.costPerUser).toBeCloseTo(user('u1').cost.total, 9);
    expect(r.cohorts.free.monthlyPerUser).toBeCloseTo(user('u1').cost.total * 10, 6);
    expect(r.modes.multi.games).toBe(2);
    expect(r.playHours).toBeCloseTo(2, 9);
  });

  it('projection mensuelle et coût marginal (capacité réellement consommée)', () => {
    expect(r.projectedMonth.compute).toBe(7);
    expect(r.projectedMonth.bandwidth).toBeCloseTo((65 - 5) * 0.15, 6);
    expect(r.projectedMonth.other).toBeCloseTo(100, 6);
    expect(user('u1').marginalUsd).toBeLessThan(user('u1').cost.total);
    expect(r.utilization.cpu).toBeCloseTo(0.9, 6); // 45 % d'un cœur sur 0,5 CPU payé
  });

  it('alertes et recommandations (seuils de docs/charge.md)', () => {
    const { alerts, recommendations } = costAlerts(r, null, DEFAULT_COST_SETTINGS);
    const codes = alerts.map((a) => a.code);
    expect(codes).toContain('free_user_cost');
    expect(codes).toContain('cpu');
    expect(codes).toContain('negative_margin');
    expect(recommendations.find((x) => x.code === 'upgrade')!.message).toMatch(/Standard/);
    const live = {
      cpuPct: 5,
      rssMb: 200,
      eventLoopP99Ms: 20,
      connectedPlayers: 1,
      games: 1,
      gamesBehind: 0,
    };
    const calm = computeCostReport(
      { ...input(), server: { ...input().server, cpuProcessMs: 0, wsBytes: 0, httpBytes: 0 } },
      CostSettingsSchema.parse({ alerts: { freeUserMonthlyUsd: 1000 } }),
    );
    expect(costAlerts(calm, live, DEFAULT_COST_SETTINGS).alerts.map((a) => a.code)).not.toContain(
      'cpu',
    );
  });

  it('serveur sans aucune partie : capacité payée non attribuée', () => {
    const empty = computeCostReport(
      { ...input(), games: [], users: [], entriesUsd: 0 },
      DEFAULT_COST_SETTINGS,
    );
    expect(empty.unattributedUsd).toBeCloseTo(
      empty.cost.compute + empty.cost.database + empty.cost.bandwidth,
      9,
    );
    expect(empty.cohorts.free.costPerUser).toBe(0);
  });

  it('paramètres : valeurs par défaut complètes, bornes validées', () => {
    expect(DEFAULT_COST_SETTINGS.compute.plans.map((p) => p.usdPerMonth)).toEqual([7, 25, 85, 175]);
    expect(CostSettingsSchema.safeParse({ vatPercent: -1 }).success).toBe(false);
    expect(CostSettingsSchema.parse({ stripe: { percent: 2.9 } }).stripe.fixedEurCents).toBe(25);
  });
});
