import type {
  GovMissionView,
  GovOfficeView,
  GovernmentView,
  LngLat,
  NationId,
  PlayerView,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { budgetDay } from '../eco/budget.js';
import { dayUnit } from './exec.js';
import {
  candidate,
  effectsOf,
  headView,
  officeDef,
  officeIds,
  poolIds,
  salaryOf,
} from './heads.js';
import { availableOf, floorFor, progressOf } from './missions.js';
import { govBal, govOpt, type MissionSt } from './state.js';

/**
 * Vue du gouvernement (PlayerView.government) : postes (titulaire, candidats, journal), missions en
 * cours et récentes, définitions des données. Propre nation seulement ; aucune donnée d'une autre
 * nation n'y figure (les candidats sont tirés de la graine de la partie pour cette nation).
 */

function missionView(state: EngineState, n: NationId, m: MissionSt): GovMissionView {
  const p = progressOf(state, n, m);
  const w = wi(state.world);
  const at: LngLat[] = [];
  for (const x of m.pending)
    if (x.pid) {
      const c = w.provById.get(x.pid)?.cityPoint;
      if (c) at.push(c);
    }
  return {
    id: m.id,
    office: m.office,
    type: m.type,
    priority: m.priority,
    status: m.suspended && m.status !== 'done' ? 'suspended' : m.status,
    ...(m.why ? { why: m.why } : {}),
    budget: m.budget,
    spent: Math.round(m.spent),
    available: Math.round(availableOf(m)),
    goal: p.goal,
    done: p.done,
    pending: m.pending.length,
    progress: p.progress,
    ...(m.resource ? { resource: m.resource } : {}),
    ...(m.branch ? { branch: m.branch } : {}),
    ...(m.category ? { category: m.category } : {}),
    ...(m.nationId ? { nationId: m.nationId } : {}),
    ...(m.provinceId ? { provinceId: m.provinceId, radiusKm: m.radiusKm ?? 400 } : {}),
    ...(at.length ? { at } : {}),
    since: m.since,
    ...(m.last ? { last: m.last } : {}),
  };
}

export function governmentView(state: EngineState, n: NationId, view: PlayerView): void {
  const B = govBal(state);
  if (!B.enabled || !state.nations[n] || view.spectator) return;
  const gn = govOpt(state)?.nations[n];
  const offices: GovOfficeView[] = [];
  let salary = 0;
  let floor = 0;
  for (const office of officeIds(state)) {
    const def = officeDef(state, office)!;
    const h = gn?.heads[office];
    if (h) {
      salary += salaryOf(state, n, office, h);
      floor = Math.max(floor, effectsOf(state, office, h).reserveDays * dayUnit(state, n));
    }
    offices.push({
      id: office,
      ministry: def.ministry,
      group: def.group,
      head: h ? headView(state, n, office, h, true) : null,
      candidates: poolIds(state, n, office).map((idx) =>
        headView(state, n, office, candidate(state, n, office, idx), false),
      ),
      journal: [...(gn?.journal[office] ?? [])],
    });
  }
  const missions = gn
    ? Object.keys(gn.missions)
        .sort()
        .map((id) => missionView(state, n, gn.missions[id]!))
    : [];
  if (gn) for (const o of officeIds(state)) floor = Math.max(floor, floorFor(state, n, o));
  view.government = {
    offices,
    missions,
    history: gn ? gn.history.map((m) => missionView(state, n, m)).reverse() : [],
    missionDefs: B.missions,
    officeDefs: B.offices,
    salaryPerDay: salary,
    reserveFloor: Math.round(floor),
    maxMissions: B.maxMissions,
    budgetDay: Math.round(budgetDay(state, n)),
  } satisfies GovernmentView;
}
