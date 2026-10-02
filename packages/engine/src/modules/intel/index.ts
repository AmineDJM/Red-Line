import { DAY, DEPARTMENTS, HOUR, MINUTE, type NationId, type Order } from '@redline/shared';
import type { GameSetup, OrderResult } from '../../api.js';
import type { EngineState } from '../../state/types.js';
import { atWar, sortedKeys } from '../../state/access.js';
import { scheduleMod } from '../kit.js';
import type { EngineModule, ModEvent, OrderHandler } from '../types.js';
import { dailyAgents, handleArrest } from './agents.js';
import { aiOffset, aiThink } from './ai.js';
import { cfg } from './config.js';
import { cryptoDaily, networksDaily, refreshSensors } from './deep.js';
import { interceptTick, listenTick, onUnitGone } from './contacts.js';
import { dailyNotes, scan } from './daily.js';
import { cancelOp, resolveOp, startOp, waveOp } from './ops.js';
import { agentsReveal } from './provinces.js';
import { copyTo, findReport } from './reports.js';
import { onSignal } from './signals.js';
import { ist, nat, newNationIntel, type IntelState } from './state.js';
import { intelView } from './view.js';
import { decide, detaineesDaily, onDue, onInterrogationEnd, onSentenceEnd } from './detainees.js';
import { aiAnswer, orderAnswerSwap, orderProposeSwap, swapsDaily } from './swaps.js';
import {
  interiorDaily,
  interiorModifier,
  interiorOnCapture,
  orderInteriorFocus,
  orderProtectSite,
} from './interior.js';

/**
 * Renseignement : trois départements (intérieur, extérieur, militaire), HUMINT et SIGINT, rapports
 * cotés, opérations, intoxication, contre-espionnage, guerre de l'information, connaissance progressive
 * des provinces étrangères. État dans state.mods.intel (voir state.ts), textes courts et génériques
 * générés à partir de l'état du jeu.
 */

function fail(message: string): OrderResult {
  return { ok: false, error: 'invalid_target', message };
}

/** Période des notes quotidiennes et du balayage (jamais plus d'une fois par heure de jeu). */
function dailyPeriod(state: EngineState): number {
  return DAY / Math.max(1, cfg(state).reportsPerDay);
}
function scanPeriod(state: EngineState): number {
  return Math.max(HOUR, cfg(state).scanEveryMin * MINUTE);
}

function init(state: EngineState, setup: GameSetup): void {
  const c = cfg(state);
  const orbatSet = setup.scenario?.orbatSet ?? '2025';
  const orbats = state.world.orbats?.get(orbatSet);
  const money = state.world.balance.money;
  const st: IntelState = {
    v: 1,
    next: 0,
    orbatSet,
    nations: {},
    agents: {},
    listens: {},
    intercepts: {},
    jams: {},
    decoys: {},
    gates: {},
    pk: {},
  };
  for (const n of state.nationIds) {
    const o = orbats?.get(n);
    const budget =
      o && money
        ? Math.round(
            o.defenseBudgetUsd *
              money.budgetPerDayFraction *
              money.budgetMultiplier *
              (money.budgetDollarFactor ?? 1) *
              c.defaultBudgetShare,
          )
        : c.defaultBudgetUsdPerDay;
    const ni = newNationIntel(budget);
    ni.aiNext = aiOffset(n);
    st.nations[n] = ni;
  }
  state.mods.intel = st;
  let first = c.dailyReportHour * HOUR;
  if (first <= 0) first += dailyPeriod(state);
  scheduleMod(state, { t: first, m: 'intel', e: 'daily' });
  scheduleMod(state, { t: scanPeriod(state), m: 'intel', e: 'scan' });
}

/** Rien de dérivé à reconstruire ; complète les champs ajoutés depuis la création de l'état. */
function rebuild(state: EngineState): void {
  const st = state.mods.intel as IntelState | undefined;
  if (!st) return;
  st.pk ??= {};
  st.gates ??= {};
  for (const n of sortedKeys(st.nations)) st.nations[n]!.log.found ??= 0;
}

function onEvent(state: EngineState, ev: ModEvent): void {
  if (!state.mods.intel) return;
  const d = (ev.d ?? {}) as Record<string, string>;
  switch (ev.e) {
    case 'op':
      return resolveOp(state, d.n!, d.id!);
    case 'wave':
      return waveOp(state, d.n!, d.id!);
    case 'arrest':
      return handleArrest(state, d.id!);
    case 'listen':
      return listenTick(state, d.id!);
    case 'dz_due':
      return onDue(state, d.id!, Number(d.t));
    case 'dz_iq':
      return onInterrogationEnd(state, d.id!, Number(d.t));
    case 'dz_end':
      return onSentenceEnd(state, d.id!, Number(d.t));
    case 'sw_ai':
      return aiAnswer(state, d.id!);
    case 'intercept':
      return interceptTick(state, d.id!);
    case 'expire': {
      const st = ist(state);
      if (d.kind === 'jam') delete st.jams[d.id!];
      else if (d.kind === 'decoy') delete st.decoys[d.id!];
      return;
    }
    case 'daily':
      dailyNotes(state);
      scheduleMod(state, { t: state.time + dailyPeriod(state), m: 'intel', e: 'daily' });
      return;
    case 'scan':
      scan(state);
      scheduleMod(state, { t: state.time + scanPeriod(state), m: 'intel', e: 'scan' });
      return;
  }
}

/**
 * Tick journalier : budgets prélevés (seulement dans une économie en dollars, `balance.money` ; les
 * parties sans cette section ne prélèvent rien), agents exposés au contre-espionnage, remontées des
 * agents sur les provinces du pays hôte.
 */
function onDailyTick(state: EngineState): void {
  const st = ist(state);
  if (!st) return;
  const dollars = !!state.world.balance.money;
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    const ni = nat(state, n);
    if (!ns.alive || !dollars) {
      ni.paid = 1;
      continue;
    }
    let total = 0;
    for (const d of DEPARTMENTS) total += Math.max(0, ni.budget[d]);
    if (total <= 0) {
      ni.paid = 1;
      continue;
    }
    const pay = Math.min(total, Math.max(0, ns.money));
    ns.money -= pay;
    ni.paid = Math.round((pay / total) * 1000) / 1000;
  }
  dailyAgents(state);
  detaineesDaily(state);
  swapsDaily(state);
  agentsReveal(state);
  interiorDaily(state);
  refreshSensors(state);
  cryptoDaily(state);
  networksDaily(state);
}

// ——— Ordres ———

const orders: Partial<Record<Order['kind'], OrderHandler>> = {
  intelOp: (state, n, o) => {
    if (o.kind !== 'intelOp') return fail('Ordre invalide.');
    return startOp(state, n, o.op, o.target);
  },
  cancelIntelOp: (state, n, o) => {
    if (o.kind !== 'cancelIntelOp') return fail('Ordre invalide.');
    return cancelOp(state, n, o.opId);
  },
  intelBudget: (state, n, o) => {
    if (o.kind !== 'intelBudget') return fail('Ordre invalide.');
    if (!state.nations[n]?.alive)
      return { ok: false, error: 'not_allowed', message: 'Nation vaincue.' };
    if (!Number.isFinite(o.budgetPerDay) || o.budgetPerDay < 0) return fail('Budget invalide.');
    nat(state, n).budget[o.dept] = Math.round(o.budgetPerDay);
    return { ok: true };
  },
  shareReport: (state, n, o) => {
    if (o.kind !== 'shareReport') return fail('Ordre invalide.');
    const to: NationId = o.to;
    if (to === n || !state.nations[to]?.alive) return fail('Destinataire invalide.');
    if (atWar(state, n, to))
      return { ok: false, error: 'not_allowed', message: 'Impossible de partager avec un ennemi.' };
    const rep = findReport(state, n, o.reportId);
    if (!rep) return fail('Rapport introuvable.');
    copyTo(state, rep, n, to);
    return { ok: true };
  },
  turnAgent: (state, n, o) => {
    if (o.kind !== 'turnAgent') return fail('Ordre invalide.');
    return startOp(state, n, 'turn_agent', {}, o.agentId);
  },
  interiorFocus: (state, n, o) => {
    if (o.kind !== 'interiorFocus') return fail('Ordre invalide.');
    return orderInteriorFocus(state, n, o.focus);
  },
  protectSite: (state, n, o) => {
    if (o.kind !== 'protectSite') return fail('Ordre invalide.');
    return orderProtectSite(state, n, o.provinceId, o.on);
  },
  detainee: (state, n, o) => {
    if (o.kind !== 'detainee') return fail('Ordre invalide.');
    return decide(state, n, o.agentId, o.action, o.days);
  },
  proposeSwap: (state, n, o) => {
    if (o.kind !== 'proposeSwap') return fail('Ordre invalide.');
    return orderProposeSwap(state, n, o.nationId, {
      give: o.give,
      get: o.get,
      money: o.money ?? 0,
      accordDays: o.accordDays ?? 0,
      liftSanctions: !!o.liftSanctions,
    });
  },
  answerSwap: (state, n, o) => {
    if (o.kind !== 'answerSwap') return fail('Ordre invalide.');
    return orderAnswerSwap(state, n, o.swapId, o.accept);
  },
};

export const intelModule: EngineModule = {
  id: 'intel',
  init,
  rebuild,
  onEvent,
  orders,
  view: intelView,
  hooks: {
    onDailyTick,
    onSignal,
    aiThink,
    onUnitDestroyed: (state, u) => {
      if (state.mods.intel) onUnitGone(state, u.id);
    },
    modifier: (state, n, key) => {
      if (!state.mods.intel || (key !== 'unrest.risk' && key !== 'site.protection')) return 1;
      return interiorModifier(state, n, key);
    },
    onProvinceCaptured: (state, pid, from) => {
      // L'ancien propriétaire connaît parfaitement ce qu'il vient de perdre (à cette date).
      if (!state.mods.intel || !state.nations[from]) return;
      interiorOnCapture(state, pid, from);
      const st = ist(state);
      (st.pk[from] ??= {})[pid] = { e: 3, m: 3, t: state.time };
    },
    audience: (state, nation, note) => {
      if (note.kind !== 'intel_report' || !state.mods.intel) return undefined;
      return !!findReport(state, nation, note.reportId);
    },
  },
};
