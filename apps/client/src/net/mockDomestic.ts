/**
 * Démonstration (?mock=1) : gestion intérieure (onglet Intérieur de l'Économie) et renseignement
 * intérieur (onglet Intérieur du Renseignement), et réponses crédibles aux ordres correspondants.
 */
import {
  DAY,
  DOMESTIC_POLICIES,
  HOUR,
  type DomesticPolicy,
  type DomesticPolicyEffects,
  type DomesticView,
  type InteriorFocus,
  type InteriorIntelView,
  type Order,
  type PlayerView,
  type ProvinceDef,
  type ThreatGrade,
} from '@redline/shared';
import { useWorld } from '../store/world.js';

const NEUTRAL: DomesticPolicyEffects = {
  income: 1,
  production: 1,
  infantry: 1,
  research: 1,
  upkeep: 1,
  stabilityPerDay: 0,
  morale: 0,
  warSupport: 0,
  unrest: 1,
  strikes: 1,
  excludes: [],
};

/** Effets de démonstration (repli si data/balance n'a pas de section `domestic`). */
const DEMO_EFFECTS: Record<DomesticPolicy, Partial<DomesticPolicyEffects>> = {
  propaganda: { income: 0.98, stabilityPerDay: 0.3, morale: 6, warSupport: 15, unrest: 0.9 },
  conscription: { infantry: 1.5, income: 0.95, upkeep: 0.95, morale: -4, warSupport: -5 },
  war_economy: { production: 1.25, income: 0.95, stabilityPerDay: -0.6, morale: -5, strikes: 1.5 },
  austerity: {
    income: 1.06,
    upkeep: 0.9,
    stabilityPerDay: -0.4,
    morale: -8,
    unrest: 1.2,
    strikes: 2,
    excludes: ['stimulus'],
  },
  stimulus: { income: 0.9, stabilityPerDay: 0.4, morale: 8, strikes: 0.5, excludes: ['austerity'] },
  martial_law: {
    income: 0.95,
    research: 0.95,
    stabilityPerDay: 1.2,
    morale: -10,
    warSupport: -10,
    unrest: 0.4,
    strikes: 0.2,
  },
};

function effectsOf(p: DomesticPolicy): DomesticPolicyEffects {
  const b = useWorld.getState().balance?.domestic?.policies?.[p];
  return { ...NEUTRAL, ...(b ?? DEMO_EFFECTS[p]) };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function totals(view: DomesticView): DomesticView['totals'] {
  const act = view.policies.filter((p) => p.active).map((p) => p.effects);
  const mul = (k: 'income' | 'production' | 'research' | 'upkeep') =>
    r2(act.reduce((f, e) => f * e[k], 1));
  const add = (k: 'stabilityPerDay' | 'morale') => r2(act.reduce((f, e) => f + e[k], 0));
  return {
    income: mul('income'),
    production: mul('production'),
    research: mul('research'),
    upkeep: mul('upkeep'),
    stabilityPerDay: add('stabilityPerDay'),
    morale: add('morale'),
  };
}

const grade = (v: number): ThreatGrade =>
  v >= 75 ? 'critical' : v >= 50 ? 'high' : v >= 25 ? 'moderate' : 'low';

/** Sections `domestic` et `intel.interior` de démonstration (mutation de la vue). */
export function demoDomestic(view: PlayerView, mine: ProvinceDef[], now: number): void {
  const cap = mine.find((p) => p.isCapital) ?? mine[0];
  const ranked = mine.map((p, i) => ({ p, i }));
  const policies = DOMESTIC_POLICIES.map((id) => ({
    id,
    active: id === 'propaganda' || id === 'conscription',
    since: id === 'propaganda' ? now - 5 * DAY : id === 'conscription' ? now - 20 * HOUR : null,
    changeableAt: id === 'conscription' ? now + 28 * HOUR : 0,
    effects: effectsOf(id),
  }));
  const provinces = ranked
    .map(({ p, i }) => ({
      id: p.id,
      risk: Math.max(0, Math.round(62 - i * 9 + (p.isCapital ? 6 : 0))),
      unrest: Math.max(0, Math.round(38 - i * 8)),
      occupied: false,
      ...(i === 1 ? { protected: true } : {}),
    }))
    .filter((x) => x.risk > 0)
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 15);
  const pid = (k: number) => mine[k % Math.max(1, mine.length)]?.id ?? null;
  const dom: DomesticView = {
    policies,
    stability: view.stability?.value ?? 64,
    morale: 61.5,
    warSupport: 72,
    warSupportTarget: 80,
    wearinessFactor: 1,
    unrestRisk: 41,
    unrestFactor: 0.78,
    strikeUntil: now + 19 * HOUR,
    provinces,
    events: [
      {
        id: 'd4',
        time: now - 5 * HOUR,
        kind: 'strike',
        provinceId: pid(0),
        title: 'Grève générale',
        text: `Mouvement de grève parti de ${mine[0]?.name ?? 'la capitale'} : production ralentie de 20 % pendant 48 h.`,
        severity: 'warn',
      },
      {
        id: 'd3',
        time: now - 30 * HOUR,
        kind: 'protest',
        provinceId: pid(1),
        title: 'Manifestations',
        text: `Manifestations contre le gouvernement à ${mine[1]?.name ?? 'la capitale'}. Stabilité −2.`,
        severity: 'warn',
      },
      {
        id: 'd2',
        time: now - 3 * DAY,
        kind: 'sabotage',
        provinceId: pid(2),
        title: 'Sabotage intérieur',
        text: `Réseau rebelle actif à ${mine[2]?.name ?? 'la capitale'} : installation endommagée à 18 %.`,
        severity: 'critical',
      },
    ],
    totals: { income: 1, production: 1, research: 1, upkeep: 1, stabilityPerDay: 0, morale: 0 },
  };
  dom.totals = totals(dom);
  view.domestic = dom;

  if (view.intel) {
    const threats = ranked
      .map(({ p, i }) => {
        const level = Math.max(0, Math.round(78 - i * 11 + (p.isCapital ? 8 : 0)));
        const factors = [
          ...(i < 3 ? ['Incidents récents'] : []),
          ...(p.buildings.length ? [`Sites sensibles (${Math.min(3, p.buildings.length)})`] : []),
          ...(i % 3 === 0 ? ['Frontière ennemie'] : []),
          ...(p.id === cap?.id ? ['Capitale'] : []),
        ];
        return {
          provinceId: p.id,
          level,
          grade: grade(level),
          factors,
          protected: i === 1 || p.id === cap?.id,
        };
      })
      .filter((x) => x.level > 0)
      .sort((a, b) => b.level - a.level)
      .slice(0, 12);
    const interior: InteriorIntelView = {
      focus: 'counterintel',
      protected: threats.filter((t) => t.protected).map((t) => t.provinceId),
      maxProtected: 3,
      metrics: {
        quality: 0.62,
        agentDetectPerDay: 0.081,
        opDetect: 0.38,
        protection: 0.3,
        unrestReduction: 0.15,
      },
      threatLevel: Math.round(threats.slice(0, 5).reduce((s, t) => s + t.level, 0) / 5),
      threats,
      stats: { foiled: 3, alerts: 7, caught: 2, doubles: 1 },
    };
    view.intel.interior = interior;
  }
}

/** Ordres de démonstration : renvoie la nouvelle section, ou null si l'ordre ne la concerne pas. */
export function demoDomesticOrder(
  view: PlayerView,
  order: Order,
  now: number,
): Partial<Pick<PlayerView, 'domestic' | 'intel'>> | { error: string } | null {
  switch (order.kind) {
    case 'domesticPolicy': {
      const d = view.domestic;
      if (!d) return null;
      const cur = d.policies.find((p) => p.id === order.policy);
      if (!cur) return { error: 'invalid_target' };
      if (cur.active === order.on) return { error: 'not_allowed' };
      if (cur.changeableAt > now) return { error: 'cooldown' };
      const until = now + 2 * DAY;
      const policies = d.policies.map((p) => {
        if (p.id === order.policy)
          return { ...p, active: order.on, since: order.on ? now : null, changeableAt: until };
        if (order.on && cur.effects.excludes.includes(p.id) && p.active)
          return { ...p, active: false, since: null, changeableAt: until };
        return p;
      });
      const next: DomesticView = { ...d, policies };
      next.totals = totals(next);
      return { domestic: next };
    }
    case 'interiorFocus': {
      const i = view.intel?.interior;
      if (!view.intel || !i) return null;
      const m: Record<InteriorFocus, [number, number, number, number]> = {
        balanced: [0.045, 0.25, 0.19, 0.12],
        counterintel: [0.081, 0.38, 0.15, 0.07],
        protection: [0.036, 0.3, 0.3, 0.1],
        surveillance: [0.04, 0.2, 0.17, 0.22],
      };
      const [a, o, p, u] = m[order.focus];
      return {
        intel: {
          ...view.intel,
          interior: {
            ...i,
            focus: order.focus,
            maxProtected: order.focus === 'protection' ? 5 : 3,
            metrics: {
              ...i.metrics,
              agentDetectPerDay: a,
              opDetect: o,
              protection: p,
              unrestReduction: u,
            },
          },
        },
      };
    }
    case 'protectSite': {
      const i = view.intel?.interior;
      if (!view.intel || !i) return null;
      const has = i.protected.includes(order.provinceId);
      if (order.on && (has || i.protected.length >= i.maxProtected)) return { error: 'capacity' };
      if (!order.on && !has) return { error: 'not_allowed' };
      const protectedIds = order.on
        ? [...i.protected, order.provinceId]
        : i.protected.filter((x) => x !== order.provinceId);
      return {
        intel: {
          ...view.intel,
          interior: {
            ...i,
            protected: protectedIds,
            threats: i.threats.map((t) => ({
              ...t,
              protected: protectedIds.includes(t.provinceId),
            })),
          },
        },
      };
    }
    default:
      return null;
  }
}
