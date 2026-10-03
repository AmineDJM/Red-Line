/**
 * Opérations du centre de commandement : sélecteurs purs (testés dans test/ops.test.ts) — arme d'une
 * pile, forces libres par commandement, état-major proposé pour un objectif, estimation d'une
 * opération avant validation (forces engagées, rapport de force, durée, chances, coût), mesure
 * principale affichée au tableau de bord.
 */
import {
  BRANCHES,
  BRANCH_SKILL,
  branchOfSystem,
  generalRating,
  type Aggressiveness,
  type Branch,
  type CampaignView,
  type CommandGeneralView,
  type CommandView,
  type NationId,
  type OpGoalDef,
  type PlayerView,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { freePiles, pileValue } from './command.js';

/** Arme d'une pile (null : satellites, armes nucléaires). */
export function branchOfPile(u: UnitView, catalog: Record<string, WeaponSystem>): Branch | null {
  const s = u.systemId ? catalog[u.systemId] : undefined;
  return s ? branchOfSystem(s) : 'land';
}

/** Piles libres (hors armée) par commandement. */
export function freeByBranch(
  view: PlayerView | null,
  me: NationId | null,
  catalog: Record<string, WeaponSystem>,
): Record<Branch, UnitView[]> {
  const out: Record<Branch, UnitView[]> = { land: [], air: [], sea: [], ad: [] };
  for (const u of freePiles(view, me, catalog)) {
    const b = branchOfPile(u, catalog);
    if (b) out[b].push(u);
  }
  return out;
}

/** Général retenu pour une opération : recruté ou candidat, rôle, forces (armée existante ou d'office). */
export interface StaffPick {
  id: string;
  role: Branch;
  /** Armée existante ; null ou absent : forces prises d'office dans l'arme du rôle. */
  armyId?: string | null;
}

/** Tous les candidats des viviers (avec leur commandement). */
export function allCandidates(command: CommandView | undefined): CommandGeneralView[] {
  if (!command) return [];
  if (command.branches?.length) return command.branches.flatMap((b) => b.candidates);
  return command.candidates;
}

/** Général recruté ou candidat, d'après son identifiant. */
export function staffGeneral(
  command: CommandView | undefined,
  id: string,
): CommandGeneralView | null {
  return (
    command?.generals.find((g) => g.id === id) ??
    allCandidates(command).find((g) => g.id === id) ??
    null
  );
}

/** Commandement d'un général (ancien général : d'après sa compétence dominante). */
export function branchOfGeneral(g: CommandGeneralView): Branch {
  if (g.branch) return g.branch;
  const s = g.skills;
  const ground = Math.max(s.offense, s.defense, s.logistics);
  if (s.air > ground && s.air >= s.naval) return 'air';
  if (s.naval > ground && s.naval > s.air) return 'sea';
  return 'land';
}

/** Généraux recrutés disponibles pour une opération (actifs, hors opération en cours). */
export function freeGenerals(
  command: CommandView | undefined,
  exceptOp?: string | null,
): CommandGeneralView[] {
  const live = new Set(
    (command?.ops ?? [])
      .filter((o) => o.status !== 'success' && o.status !== 'failed')
      .map((o) => o.id),
  );
  return (command?.generals ?? []).filter(
    (g) =>
      (g.status === 'active' || g.status === 'wounded') &&
      (!g.opId || !live.has(g.opId) || g.opId === exceptOp),
  );
}

/**
 * État-major proposé : pour chaque commandement recommandé par l'objectif, le meilleur général
 * disponible (recruté d'abord, sinon candidat du vivier) dans la compétence maîtresse de l'arme ;
 * un second général de l'armée de terre pour une conquête quand les forces terrestres le justifient.
 * Seuls les commandements qui ont des forces sont proposés.
 */
export function suggestStaff(
  command: CommandView | undefined,
  def: OpGoalDef,
  goal: string,
  free: Record<Branch, number>,
  taken: ReadonlySet<string> = new Set(),
): StaffPick[] {
  const out: StaffPick[] = [];
  const used = new Set(taken);
  const pick = (b: Branch): void => {
    const key = BRANCH_SKILL[b];
    const best = (list: CommandGeneralView[]) =>
      list
        .filter((g) => !used.has(g.id) && branchOfGeneral(g) === b)
        .sort((x, y) => y.skills[key] - x.skills[key] || (x.id < y.id ? -1 : 1))[0];
    const g = best(freeGenerals(command)) ?? best(allCandidates(command));
    if (!g) return;
    used.add(g.id);
    out.push({ id: g.id, role: b, armyId: null });
  };
  for (const b of def.branches) if ((free[b] ?? 0) > 0) pick(b);
  if ((goal === 'conquest' || goal === 'occupy') && (free.land ?? 0) >= 4) pick('land');
  return out;
}

export interface OpPreview {
  /** Valeur (dollars) des forces engagées et des forces ennemies estimées. */
  forces: number;
  enemy: number;
  ratio: number;
  etaHours: number | null;
  chance: number;
  /** Soldes par jour, primes d'engagement. */
  costPerDay: number;
  hireCost: number;
  piles: number;
}

/** Durée indicative par objectif (heures), au rythme d'une opération bien dotée. */
function etaFor(goal: string, provinces: number): number | null {
  switch (goal) {
    case 'conquest':
    case 'occupy':
      return 12 + 10 * Math.max(1, provinces);
    case 'decapitation':
      return 18;
    case 'attrition':
      return 72;
    case 'air_control':
      return 36;
    case 'sead':
      return 24;
    case 'strategic':
      return 48;
    case 'blockade':
      return 12;
    default:
      return null;
  }
}

/**
 * Estimation avant validation : forces engagées (armées choisies, sinon part des piles libres de
 * l'arme partagée entre généraux de même rôle), forces ennemies estimées (renseignement), rapport de
 * force, durée, chances (même formule que le moteur), coût.
 */
export function previewOp(o: {
  view: PlayerView | null;
  me: NationId | null;
  catalog: Record<string, WeaponSystem>;
  goal: string;
  nations: NationId[];
  provinces?: string[];
  staff: StaffPick[];
  aggr: Aggressiveness;
  share: number;
  attackRatio: number;
}): OpPreview {
  const command = o.view?.command;
  const free = freeByBranch(o.view, o.me, o.catalog);
  let forces = 0;
  let piles = 0;
  const auto: Record<Branch, number> = { land: 0, air: 0, sea: 0, ad: 0 };
  for (const p of o.staff) if (!p.armyId) auto[p.role]++;
  for (const b of BRANCHES) {
    if (!auto[b]) continue;
    const list = free[b];
    const k = Math.max(list.length ? 1 : 0, Math.ceil(list.length * o.share));
    const sorted = [...list].sort((x, y) => pileValue(y, o.catalog) - pileValue(x, o.catalog));
    for (const u of sorted.slice(0, k)) forces += pileValue(u, o.catalog);
    piles += k;
  }
  for (const p of o.staff) {
    if (!p.armyId) continue;
    const a = command?.armies.find((x) => x.id === p.armyId);
    for (const id of a?.unitIds ?? []) {
      const u = o.view?.units[id];
      if (u) {
        forces += pileValue(u, o.catalog);
        piles++;
      }
    }
  }
  let enemy = 0;
  for (const n of o.nations) enemy += command?.estimates[n] ?? 0;
  const ratio = enemy > 0 ? Math.min(99, forces / enemy) : forces > 0 ? 99 : 0;
  let skill = 30;
  let exp = 20;
  let costPerDay = 0;
  let hireCost = 0;
  for (const p of o.staff) {
    const g = staffGeneral(command, p.id);
    if (!g) continue;
    skill = Math.max(skill, generalRating(g.skills));
    exp = Math.max(exp, g.skills.experience);
    costPerDay += g.salaryPerDay;
    if (g.status === 'candidate') hireCost += g.hireCost;
  }
  const x = Math.min(ratio, 10) * (0.85 + (0.3 * skill) / 100) * (0.9 + (0.2 * exp) / 100);
  const need = o.attackRatio;
  const chance = o.staff.length
    ? Math.max(0.03, Math.min(0.97, (x * x) / (x * x + need * need * 0.64)))
    : 0;
  const provinces = o.provinces?.length
    ? o.provinces.length
    : Object.values(o.view?.provinces ?? {}).filter((p) => o.nations.includes(p.owner)).length;
  return {
    forces,
    enemy,
    ratio: Math.round(ratio * 100) / 100,
    etaHours: etaFor(o.goal, provinces),
    chance: Math.round(chance * 100) / 100,
    costPerDay,
    hireCost,
    piles,
  };
}

/** Mesure principale d'une opération : clé de texte et paramètres (tableau de bord, liste). */
export function opHeadline(op: CampaignView): {
  key: string;
  params: Record<string, number>;
} {
  const m = (k: string) => op.progress.find((p) => p.key === k);
  const pct = (p?: { done: number; total: number }) =>
    p && p.total > 0 ? Math.round((100 * p.done) / p.total) : 0;
  switch (op.goal) {
    case 'attrition':
      return { key: 'command.ops.metric.forces', params: { pct: pct(m('forces')) } };
    case 'conquest':
    case 'occupy': {
      const p = m('provinces');
      return {
        key: 'command.ops.metric.provinces',
        params: { done: p?.done ?? 0, total: p?.total ?? 0 },
      };
    }
    case 'decapitation': {
      const p = m('capital');
      return {
        key: 'command.ops.metric.capital',
        params: { done: p?.done ?? 0, total: p?.total ?? 0 },
      };
    }
    case 'air_control': {
      const s = m('sams');
      const a = m('aircraft');
      return {
        key: 'command.ops.metric.sky',
        params: {
          sams: Math.max(0, (s?.total ?? 0) - (s?.done ?? 0)),
          air: Math.max(0, (a?.total ?? 0) - (a?.done ?? 0)),
        },
      };
    }
    case 'sead': {
      const s = m('sams');
      return {
        key: 'command.ops.metric.sams',
        params: { left: Math.max(0, (s?.total ?? 0) - (s?.done ?? 0)), total: s?.total ?? 0 },
      };
    }
    case 'strategic': {
      const p = m('buildings');
      return {
        key: 'command.ops.metric.buildings',
        params: { done: p?.done ?? 0, total: p?.total ?? 0 },
      };
    }
    case 'blockade': {
      const p = m('ports');
      return {
        key: 'command.ops.metric.ports',
        params: { done: p?.done ?? 0, total: p?.total ?? 0 },
      };
    }
    default: {
      const p = m('front');
      return {
        key: 'command.ops.metric.front',
        params: { done: p?.done ?? 0, total: p?.total ?? 0 },
      };
    }
  }
}

/** Opérations en cours (ni réussies ni échouées). */
export function liveOps(command: CommandView | undefined): CampaignView[] {
  return (command?.ops ?? []).filter((o) => o.status !== 'success' && o.status !== 'failed');
}

/** Objectifs triés (ordre des données). */
export function goalList(command: CommandView | undefined): [string, OpGoalDef][] {
  return Object.entries(command?.goals ?? {}).sort(
    (a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1),
  );
}

/** Commandements recommandés pour un objectif, et ceux couverts par l'état-major choisi. */
export function branchFit(def: OpGoalDef, staff: StaffPick[]): { b: Branch; ok: boolean }[] {
  const have = new Set(staff.map((s) => s.role));
  return def.branches.map((b) => ({ b, ok: have.has(b) }));
}
