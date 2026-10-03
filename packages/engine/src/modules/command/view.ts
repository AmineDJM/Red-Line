import {
  BRANCHES,
  branchOfSystem,
  type ArmyView,
  type Branch,
  type CommandBranchView,
  type CommandView,
  type NationId,
  type PlayerView,
} from '@redline/shared';
import {
  estimateForce,
  neighborNations,
  ownForce,
  unitValue,
  withForceMemo,
} from '../../ai/estimate.js';
import { nationUnits, sysOf, warsOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import {
  branchOf,
  candidateView,
  candidatesOf,
  generalView,
  isChief,
  salaryOf,
} from './generals.js';
import { campaignView, opNations } from './ops.js';
import { cmdBal, cmdOpt, type ArmySt, type CmdState } from './state.js';

/**
 * Vue du centre de commandement : armées, généraux recrutés et candidats de la nation seulement
 * (jamais ceux d'un autre joueur), missions disponibles et forces estimées des nations voisines,
 * ennemies ou visées (estimation publique et contacts, sans tricher). Aucun champ ne dépend de
 * l'horloge seule : la section ne change qu'à la réflexion du général ou sur ordre.
 */

/** Deux chiffres significatifs : l'estimation ne change pas à chaque instant. */
function sig2(x: number): number {
  if (!(x > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}

function armyView(a: ArmySt): ArmyView {
  const m = a.mission;
  return {
    id: a.id,
    name: a.name,
    generalId: a.general,
    unitIds: [...a.units],
    manualIds: Object.keys(a.manual).sort(),
    mission: m
      ? {
          type: m.type,
          brain: 'conquer',
          ...(m.provinceId ? { provinceId: m.provinceId } : {}),
          ...(m.nationId ? { nationId: m.nationId } : {}),
          ...(m.at ? { at: [m.at[0], m.at[1]] as [number, number] } : {}),
          ...(m.radiusKm !== undefined ? { radiusKm: m.radiusKm } : {}),
          aggr: m.aggr,
          roe: m.roe,
          retreatAt: m.retreatAt,
          since: m.since,
        }
      : null,
    status: a.status,
    reinforce: a.reinforce,
    request: a.request
      ? {
          id: a.request.id,
          kind: a.request.kind,
          ...(a.request.nationId ? { nationId: a.request.nationId } : {}),
          ...(a.request.unitIds ? { unitIds: [...a.request.unitIds] } : {}),
          at: a.request.at,
        }
      : null,
    journal: a.journal.map((e) => ({ ...e })),
    strength: { start: Math.round(a.start), now: Math.round(a.now) },
    objective: a.obj ? { ...a.obj } : null,
    estimate: a.est ? { ...a.est } : null,
    aims: a.aims.map((p) => [p[0], p[1]] as [number, number]),
    captures: a.captures,
    losses: a.losses,
    createdAt: a.createdAt,
    ...(a.op ? { opId: a.op } : {}),
  };
}

/** Commandements : chef, généraux, vivier, forces (piles de l'arme), opérations. */
function branchesView(
  state: EngineState,
  n: NationId,
  c: CmdState | undefined,
): CommandBranchView[] {
  const forces: Record<Branch, CommandBranchView['forces']> = {
    land: { piles: 0, free: 0, elements: 0, value: 0 },
    air: { piles: 0, free: 0, elements: 0, value: 0 },
    sea: { piles: 0, free: 0, elements: 0, value: 0 },
    ad: { piles: 0, free: 0, elements: 0, value: 0 },
  };
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    if (u.role) continue;
    const b = branchOfSystem(sysOf(state, u));
    if (!b) continue;
    const f = forces[b];
    f.piles++;
    if (!c?.unitArmy[id]) f.free++;
    f.elements += u.count;
    f.value += unitValue(state, u);
  }
  return BRANCHES.map((b) => {
    const gens = c
      ? Object.keys(c.gens)
          .sort()
          .filter((id) => c.gens[id]!.owner === n && branchOf(c.gens[id]!) === b)
      : [];
    const ops = new Set<string>();
    for (const gid of gens) {
      const a = c!.gens[gid]!.army ? c!.armies[c!.gens[gid]!.army!] : undefined;
      if (a?.op) ops.add(a.op);
    }
    return {
      id: b,
      chiefId: c?.chiefs?.[n]?.[b] ?? null,
      generalIds: gens,
      candidates: candidatesOf(state, n, b).map((x) => candidateView(state, n, x)),
      forces: { ...forces[b], value: Math.round(forces[b].value) },
      opIds: [...ops].sort(),
    };
  });
}

export function commandView(state: EngineState, n: NationId, view: PlayerView): void {
  const B = cmdBal(state);
  if (!B.enabled || !state.nations[n]) return;
  const c = cmdOpt(state);
  const armies: ArmyView[] = [];
  const generals = [];
  let salary = 0;
  const targets = new Set<NationId>();
  if (c) {
    for (const id of Object.keys(c.armies).sort()) {
      const a = c.armies[id]!;
      if (a.owner !== n) continue;
      const v = armyView(a);
      if (v.mission) v.mission.brain = B.missions[v.mission.type]?.brain ?? 'conquer';
      if (a.op) {
        const role = c.ops?.[a.op]?.roles[a.id];
        if (role) v.role = role;
      }
      armies.push(v);
      if (a.mission?.nationId) targets.add(a.mission.nationId);
      for (const p of a.mission?.targets ?? []) {
        const o = state.provinces[p]?.owner;
        if (o && o !== n) targets.add(o);
      }
    }
    for (const id of Object.keys(c.gens).sort()) {
      const g = c.gens[id]!;
      if (g.owner !== n) continue;
      generals.push(generalView(state, g));
      salary += salaryOf(state, n, g.skills, g.traits, isChief(state, g));
    }
    for (const id of Object.keys(c.ops ?? {}).sort()) {
      const op = c.ops![id]!;
      if (op.owner !== n) continue;
      for (const t of opNations(state, op)) targets.add(t);
    }
  }
  const candidates = candidatesOf(state, n).map((x) => candidateView(state, n, x));
  // Forces estimées : voisins, ennemis, cibles des missions.
  const estimates: Record<NationId, number> = {};
  for (const t of neighborNations(state, n)) targets.add(t);
  for (const t of warsOf(state, n)) targets.add(t);
  targets.delete(n);
  withForceMemo(() => {
    const mine = ownForce(state, n);
    for (const t of [...targets].sort()) {
      if (!state.nations[t]?.alive) continue;
      estimates[t] = sig2(estimateForce(state, n, t, mine, 1));
    }
  });
  const out: CommandView = {
    armies,
    generals,
    candidates,
    salaryPerDay: salary,
    maxArmies: B.maxArmies,
    maxPiles: B.maxPiles,
    missions: B.missions,
    estimates,
    ops: c
      ? Object.keys(c.ops ?? {})
          .sort()
          .filter((id) => c.ops![id]!.owner === n)
          .map((id) => campaignView(state, c.ops![id]!))
      : [],
    maxOps: B.operations.maxOps,
    goals: B.operations.goals,
    branches: branchesView(state, n, c),
  };
  view.command = out;
  // Solde prévu : les généraux sont une dépense récurrente (absente du calcul du module économique).
  const d = view.economy.detail;
  if (d && salary > 0) {
    d.forecast = {
      netPerDay: d.forecast.netPerDay - salary,
      money7d: d.forecast.money7d - 7 * salary,
      money30d: d.forecast.money30d - 30 * salary,
    };
  }
}
