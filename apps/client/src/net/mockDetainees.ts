import {
  DAY,
  HOUR,
  type DecisionEffects,
  type DetaineeOption,
  type DetaineeView,
  type GameTime,
  type IntelView,
  type NationId,
  type Order,
  type PlayerView,
  type SwapView,
} from '@redline/shared';

/**
 * Démonstration (mode maquette) : détenus, agents détenus à l'étranger, négociations. Les
 * conséquences affichées reprennent le barème par défaut du moteur ; les ordres modifient la vue.
 */

const fx = (e: Partial<DecisionEffects>): DecisionEffects => ({
  relations: 0,
  reputation: 0,
  stability: 0,
  retaliation: 0,
  serviceHit: 0,
  ...e,
});

function options(kind: DetaineeView['kind'], war: boolean): DetaineeOption[] {
  const dip = kind === 'diplomat';
  const imm = dip ? { immunity: true, reputation: -5 } : {};
  return [
    {
      action: 'interrogate',
      allowed: true,
      effects: fx({
        relations: dip ? -12 : -2,
        retaliation: 0.06,
        chance: 0.42,
        hours: 48,
        ...imm,
      }),
    },
    {
      action: 'expel',
      allowed: true,
      effects: dip
        ? fx({ relations: -6, retaliation: 0.6, serviceHit: 0.15, serviceDays: 30 })
        : fx({ relations: -4, retaliation: 0.24, serviceHit: 0.1, serviceDays: 20 }),
    },
    ...[30, 90, 365].map((days): DetaineeOption => ({
      action: 'jail',
      days,
      allowed: true,
      effects: fx({
        relations: Math.round((-12 - (10 * days) / 365) * 10) / 10 + (dip ? -10 : 0),
        reputation: dip ? -5.5 : -0.5,
        stability: 1,
        retaliation: 0.42,
        serviceHit: 0.2,
        serviceDays: 60,
        pressurePerDay: 1,
        ...(dip ? { immunity: true } : {}),
      }),
    })),
    {
      action: 'execute',
      allowed: war,
      ...(war ? {} : { reason: 'war_only' as const }),
      effects: fx({
        relations: war ? -40 : -60,
        reputation: war ? -18 : -27,
        stability: -6,
        retaliation: 0.95,
        serviceHit: 0.35,
        serviceDays: 90,
        worldRelations: war ? -10 : -15,
        council: 0.6,
      }),
    },
    {
      action: 'turn',
      allowed: kind !== 'double',
      ...(kind === 'double' ? { reason: 'not_plausible' as const } : {}),
      effects: fx({ relations: 6, reputation: 1, stability: -1, chance: dip ? 0.08 : 0.2 }),
    },
    {
      action: 'release',
      allowed: true,
      effects: fx({ relations: 6, reputation: 1, stability: -1 }),
    },
  ];
}

/** Détenus, agents détenus et négociations de démonstration (ajoutés à la vue de renseignement). */
export function demoDetainees(
  intel: IntelView,
  me: NationId,
  enemy: NationId,
  other: NationId,
  now: GameTime,
): void {
  intel.regime = 'hybrid';
  intel.detainees = [
    {
      id: 'dz1',
      ref: 'D-41',
      nationId: enemy,
      kind: 'illegal',
      status: 'pending',
      arrestedAt: now - 9 * HOUR,
      decideBy: now + 2 * DAY + 15 * HOUR,
      op: 'sabotage_factory',
      value: 4,
      options: options('illegal', true),
    },
    {
      id: 'dz2',
      ref: 'D-37',
      nationId: other,
      kind: 'diplomat',
      status: 'held',
      arrestedAt: now - 5 * DAY,
      value: 3,
      options: options('diplomat', false),
    },
    {
      id: 'dz3',
      ref: 'D-22',
      nationId: enemy,
      kind: 'source',
      status: 'jailed',
      arrestedAt: now - 20 * DAY,
      days: 90,
      until: now + 70 * DAY,
      interrogated: true,
      access: 'ministry',
      revealed: { agents: 1, ops: 1 },
      value: 2.3,
      options: options('source', true),
    },
  ];
  const caught = intel.agents.find((a) => a.nationId === enemy) ?? intel.agents[0];
  if (caught) {
    caught.status = 'captured';
    caught.kind = 'officer';
    caught.cover = 'nonofficial';
    caught.detention = { fate: 'jailed', since: now - 4 * DAY, days: 365, until: now + 361 * DAY };
  }
  const swap: SwapView = {
    id: 'sw1',
    from: enemy,
    to: me,
    at: now - 3 * HOUR,
    expiresAt: now + 4 * DAY + 21 * HOUR,
    give: caught ? [{ id: caught.id, nationId: me, label: caught.codename, kind: 'illegal' }] : [],
    get: [{ id: 'dz1', nationId: enemy, label: 'D-41', kind: 'illegal' }],
    money: 0,
    accordDays: 30,
    status: 'open',
  };
  intel.swaps = [swap];
  intel.ties = [
    { nationId: enemy, score: -34, regime: 'authoritarian' },
    { nationId: other, score: -6, regime: 'democracy' },
  ];
}

/** Ordres de la démonstration : décision sur un détenu, proposition et réponse d'échange. */
export function demoDetaineeOrder(
  v: PlayerView,
  order: Order,
  t: GameTime,
  me: NationId,
): { intel: IntelView } | null {
  const i = v.intel;
  if (!i) return null;
  switch (order.kind) {
    case 'detainee': {
      const next: Record<string, DetaineeView['status']> = {
        expel: 'expelled',
        jail: 'jailed',
        execute: 'executed',
        release: 'released',
        turn: 'turned',
      };
      return {
        intel: {
          ...i,
          detainees: (i.detainees ?? []).map((d) => {
            if (d.id !== order.agentId) return d;
            if (order.action === 'interrogate')
              return { ...d, interrogating: t + 48 * HOUR, status: d.status };
            const s = next[order.action];
            if (!s) return d;
            const out: DetaineeView = {
              ...d,
              status: order.action === 'expel' && d.kind !== 'diplomat' ? 'returned' : s,
            };
            if (s === 'jailed') {
              out.days = order.days ?? 90;
              out.until = t + (order.days ?? 90) * DAY;
            } else {
              delete out.options;
              out.endedAt = t;
            }
            return out;
          }),
        },
      };
    }
    case 'proposeSwap': {
      const s: SwapView = {
        id: `sw${t}`,
        from: me,
        to: order.nationId,
        at: t,
        expiresAt: t + 5 * DAY,
        give: order.give.map((id) => ({
          id,
          nationId: order.nationId,
          label: i.detainees?.find((d) => d.id === id)?.ref ?? id,
          kind: i.detainees?.find((d) => d.id === id)?.kind ?? 'illegal',
        })),
        get: order.get.map((id) => ({
          id,
          nationId: me,
          label: i.agents.find((a) => a.id === id)?.codename ?? id,
          kind: 'illegal',
        })),
        money: order.money ?? 0,
        accordDays: order.accordDays ?? 0,
        status: 'open',
      };
      return { intel: { ...i, swaps: [s, ...(i.swaps ?? [])] } };
    }
    case 'answerSwap':
      return {
        intel: {
          ...i,
          swaps: (i.swaps ?? []).map((s) =>
            s.id === order.swapId ? { ...s, status: order.accept ? 'accepted' : 'refused' } : s,
          ),
        },
      };
    default:
      return null;
  }
}
