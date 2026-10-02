import {
  distanceKm,
  type LngLat,
  type LocParam,
  type MissionInput,
  type NationId,
  type Order,
  type ProvinceId,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { unitValue } from '../../ai/estimate.js';
import { provincesOf, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../../state/world.js';
import { journal } from './journal.js';
import { assign, checkHire, doHire, fullName } from './generals.js';
import { cmd, cmdBal, cmdOpt, nextCmdId, type ArmySt, type MissionSt } from './state.js';
import { scheduleArmy } from './schedule.js';

/**
 * Armées du centre de commandement : création à partir des piles existantes, affectation, retrait,
 * renforts, mission, suspension, dissolution, réponses aux demandes du général. Une pile appartient à
 * au plus une armée (l'ajouter à une autre armée l'y transfère). Règle d'ordre manuel : un ordre
 * direct du joueur sur une pile d'une armée prime jusqu'à sa fin ; le général la reprend ensuite.
 */

const fail = (error: OrderResult['error'], message: string): OrderResult => ({
  ok: false,
  error,
  message,
});

export function armyValue(state: EngineState, a: ArmySt): number {
  let v = 0;
  for (const id of a.units) {
    const u = state.units[id];
    if (u && u.owner === a.owner) v += unitValue(state, u);
  }
  return v;
}

/** Pile utilisable dans une armée : à soi, ni munition en vol ni leurre. */
function validUnits(state: EngineState, n: NationId, ids: string[]): Unit[] | OrderResult {
  const out: Unit[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    if (u.role) return fail('not_allowed', `Unité indisponible : ${id}`);
    out.push(u);
  }
  return out;
}

/** Ajoute des piles à une armée (retirées de leur armée précédente). */
export function addUnits(state: EngineState, a: ArmySt, ids: string[]): void {
  const c = cmd(state);
  for (const id of ids) {
    const prev = c.unitArmy[id];
    if (prev === a.id) continue;
    if (prev) {
      const pa = c.armies[prev];
      if (pa) {
        pa.units = pa.units.filter((x) => x !== id);
        delete pa.manual[id];
      }
    }
    c.unitArmy[id] = a.id;
    a.units.push(id);
  }
}

export function removeUnits(state: EngineState, a: ArmySt, ids: string[]): void {
  const c = cmd(state);
  const set = new Set(ids);
  a.units = a.units.filter((x) => !set.has(x));
  for (const id of ids) {
    if (c.unitArmy[id] === a.id) delete c.unitArmy[id];
    delete a.manual[id];
    if (a.mem.commit) delete a.mem.commit[id];
  }
}

export function orderCreate(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armyCreate' }>,
): OrderResult {
  const B = cmdBal(state);
  if (!B.enabled) return fail('not_allowed', 'Centre de commandement désactivé.');
  const c = cmd(state);
  const mine = Object.values(c.armies).filter((a) => a.owner === n).length;
  if (mine >= B.maxArmies) return fail('capacity', 'Nombre maximal d’armées atteint.');
  if (o.unitIds.length > B.maxPiles) return fail('capacity', 'Trop de piles pour une armée.');
  const units = validUnits(state, n, o.unitIds);
  if (!Array.isArray(units)) return units;
  // Création complète en un ordre (assistant) : général et mission validés avant toute modification.
  const hire = o.candidateId ? checkHire(state, n, o.candidateId) : null;
  if (hire && !hire.ok) return hire.res;
  const gen = o.generalId ? cmd(state).gens[o.generalId] : null;
  if (
    o.generalId &&
    (!gen || gen.owner !== n || gen.status === 'dead' || gen.status === 'resigned')
  )
    return fail('invalid_target', 'Général inconnu.');
  const mis = o.mission ? resolveMission(state, n, o.mission) : null;
  if (mis && !mis.ok) return mis.res;
  const id = nextCmdId(state, 'a');
  const a: ArmySt = {
    id,
    owner: n,
    name: o.name.trim().slice(0, 40) || id,
    createdAt: state.time,
    units: [],
    general: null,
    mission: null,
    status: 'idle',
    suspended: false,
    reinforce: 'ask',
    manual: {},
    request: null,
    askAfter: 0,
    journal: [],
    start: 0,
    now: 0,
    est: null,
    obj: null,
    aims: [],
    captures: 0,
    losses: 0,
    mem: {},
    v: 0,
  };
  c.armies[id] = a;
  addUnits(
    state,
    a,
    units.map((u) => u.id),
  );
  a.now = armyValue(state, a);
  journal(state, a, 'created', { piles: a.units.length });
  if (hire?.ok) doHire(state, n, hire.idx, a);
  else if (gen) assign(state, gen, a);
  if (mis?.ok) applyMission(state, a, mis.ms);
  return { ok: true };
}

export function orderEdit(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armyEdit' }>,
): OrderResult {
  const c = cmd(state);
  const a = c.armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  const add = o.add?.length ? validUnits(state, n, o.add) : [];
  if (!Array.isArray(add)) return add;
  const remove = (o.remove ?? []).filter((id) => c.unitArmy[id] === a.id);
  const total = a.units.length + add.filter((u) => c.unitArmy[u.id] !== a.id).length;
  if (total - remove.length > cmdBal(state).maxPiles)
    return fail('capacity', 'Trop de piles pour une armée.');
  if (o.name !== undefined) a.name = o.name.trim().slice(0, 40) || a.name;
  if (o.reinforce) a.reinforce = o.reinforce;
  if (add.length) {
    const ids = add.map((u) => u.id).filter((id) => c.unitArmy[id] !== a.id);
    addUnits(state, a, ids);
    if (ids.length) {
      // Renforts : ils comptent dans les effectifs de référence de la mission.
      if (a.mission) a.start += ids.reduce((s, id) => s + unitValue(state, state.units[id]!), 0);
      journal(state, a, 'reinforced', { piles: ids.length }, 'good');
    }
  }
  if (remove.length) {
    if (a.mission)
      a.start = Math.max(
        0,
        a.start - remove.reduce((s, id) => s + unitValue(state, state.units[id]!), 0),
      );
    removeUnits(state, a, remove);
    journal(state, a, 'detached', { piles: remove.length });
  }
  a.now = armyValue(state, a);
  return { ok: true };
}

/** Provinces visées (Conquérir, Débarquement) et villes à tenir, figées au lancement. */
function missionTargets(
  state: EngineState,
  n: NationId,
  brain: string,
  m: MissionInput & { radiusKm: number },
): { targets?: ProvinceId[]; holds?: ProvinceId[] } {
  const w = wi(state.world);
  if (brain === 'conquer' || brain === 'landing') {
    if (m.nationId) return { targets: provincesOf(state, m.nationId).sort() };
    const pid = m.provinceId!;
    const owner = state.provinces[pid]!.owner;
    if (brain === 'landing' || !m.radiusKm) return { targets: [pid] };
    const at = w.provById.get(pid)!.cityPoint;
    const out = provincesOf(state, owner)
      .filter((p) => p === pid || distanceKm(w.provById.get(p)!.cityPoint, at) <= m.radiusKm)
      .sort();
    return { targets: out };
  }
  if (brain === 'hold_front') {
    const enemy = (o: NationId) => (m.nationId ? o === m.nationId : o !== n);
    const holds = provincesOf(state, n)
      .filter((p) =>
        (w.provById.get(p)?.neighbors ?? []).some((x) => {
          const o = state.provinces[x]?.owner;
          return !!o && o !== n && enemy(o);
        }),
      )
      .sort();
    return { holds };
  }
  if (brain === 'defend' || brain === 'air_defense' || brain === 'reserve') {
    const at = m.at!;
    const holds = provincesOf(state, n)
      .filter((p) => distanceKm(w.provById.get(p)!.cityPoint, at) <= Math.max(m.radiusKm, 30))
      .sort();
    return { holds };
  }
  return {};
}

/** Mission validée et normalisée (cible, zone, provinces visées ou à tenir), sans rien modifier. */
export function resolveMission(
  state: EngineState,
  n: NationId,
  input: MissionInput,
): { ok: true; ms: MissionSt } | { ok: false; res: OrderResult } {
  const no = (message: string) => ({ ok: false as const, res: fail('invalid_target', message) });
  const B = cmdBal(state);
  const def = B.missions[input.type];
  if (!def) return no('Mission inconnue.');
  const m = { ...input };
  const w = wi(state.world);
  let at: LngLat | undefined = m.at ? [m.at[0], m.at[1]] : undefined;
  if (m.provinceId && !state.provinces[m.provinceId]) return no('Province inconnue.');
  if (m.nationId && (!state.nations[m.nationId] || m.nationId === n)) return no('Nation invalide.');
  switch (def.target) {
    case 'province': {
      if (!m.provinceId && !m.nationId) return no('Province à désigner.');
      const owner = m.provinceId ? state.provinces[m.provinceId]!.owner : m.nationId!;
      if (owner === n) return no('Cette province est déjà à vous.');
      if (m.provinceId) at = w.provById.get(m.provinceId)!.cityPoint;
      break;
    }
    case 'nation':
      if (!m.nationId && m.provinceId) {
        const owner = state.provinces[m.provinceId]!.owner;
        if (owner === n) return no('Désignez une nation étrangère.');
        m.nationId = owner;
      }
      if (!m.nationId && def.brain !== 'hold_front') return no('Nation à désigner.');
      break;
    case 'zone':
      if (!at && m.provinceId) at = w.provById.get(m.provinceId)!.cityPoint;
      if (!at) return no('Zone à désigner sur la carte.');
      break;
  }
  const radiusKm = m.radiusKm ?? def.radiusKm;
  const aggr = m.aggr ?? 'balanced';
  const A = B.aggressiveness[aggr];
  const t = missionTargets(state, n, def.brain, { ...m, radiusKm, ...(at ? { at } : {}) });
  return {
    ok: true,
    ms: {
      type: m.type,
      ...(m.provinceId ? { provinceId: m.provinceId } : {}),
      ...(m.nationId ? { nationId: m.nationId } : {}),
      ...(at ? { at } : {}),
      radiusKm,
      aggr,
      roe: m.roe ?? 'standard',
      retreatAt: m.retreatAt ?? A.retreatAt,
      since: state.time,
      progressAt: state.time,
      doneAt: null,
      ...t,
    },
  };
}

export function orderMission(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armyMission' }>,
): OrderResult {
  const c = cmd(state);
  const a = c.armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  if (o.mission === null) {
    if (a.mission) journal(state, a, 'missionCleared');
    a.mission = null;
    a.request = null;
    a.mem = {};
    a.status = 'idle';
    a.est = null;
    a.obj = null;
    a.aims = [];
    a.v++;
    return { ok: true };
  }
  const r = resolveMission(state, n, o.mission);
  if (!r.ok) return r.res;
  applyMission(state, a, r.ms);
  return { ok: true };
}

/** Confie une mission validée à l'armée (effectifs de référence, mémoire remise à zéro). */
export function applyMission(state: EngineState, a: ArmySt, ms: MissionSt): void {
  a.mission = ms;
  a.request = null;
  a.mem = {};
  a.suspended = false;
  a.start = armyValue(state, a);
  a.now = a.start;
  a.est = null;
  a.obj = null;
  a.aims = [];
  a.status = a.general ? 'preparing' : 'passive';
  a.v++;
  journal(state, a, 'mission', {
    mission: { key: `engine.cmd.mission.${ms.type}` },
    target: targetParam(ms),
  });
  scheduleArmy(state, a);
}

/** Désignation de la cible pour le journal. */
export function targetParam(m: MissionSt): LocParam {
  if (m.provinceId) return { province: m.provinceId };
  if (m.nationId) return { nation: m.nationId };
  return { key: 'engine.cmd.zone' };
}

export function orderSuspend(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armySuspend' }>,
): OrderResult {
  const a = cmd(state).armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  if (a.suspended === o.on) return { ok: true };
  a.suspended = o.on;
  a.v++;
  if (o.on) {
    a.status = 'suspended';
    journal(state, a, 'suspended', {}, 'warn');
  } else {
    a.status = a.mission ? (a.general ? 'active' : 'passive') : 'idle';
    if (a.mission) a.mission.progressAt = state.time;
    journal(state, a, 'resumed');
    scheduleArmy(state, a);
  }
  return { ok: true };
}

export function orderDissolve(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armyDissolve' }>,
): OrderResult {
  const c = cmd(state);
  const a = c.armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  removeUnits(state, a, [...a.units]);
  if (a.general) {
    const g = c.gens[a.general];
    if (g) g.army = null;
  }
  delete c.armies[a.id];
  return { ok: true };
}

export function orderAnswer(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'armyAnswer' }>,
): OrderResult {
  const c = cmd(state);
  const a = c.armies[o.armyId];
  if (!a || a.owner !== n) return fail('invalid_target', 'Armée inconnue.');
  const r = a.request;
  if (!r || r.id !== o.requestId) return fail('invalid_target', 'Demande expirée.');
  a.request = null;
  a.v++;
  const g = a.general ? c.gens[a.general] : null;
  const who = g ? fullName(g) : '';
  switch (r.kind) {
    case 'declare_war':
      if (!a.mission) break;
      if (o.accept) {
        a.mission.okWar = [...new Set([...(a.mission.okWar ?? []), r.nationId!])].sort();
        journal(state, a, 'warAuthorized', { nation: { nation: r.nationId! } }, 'warn');
      } else {
        a.suspended = true;
        a.status = 'suspended';
        journal(state, a, 'warRefused', { nation: { nation: r.nationId! } });
      }
      break;
    case 'strategic_strike':
      if (!a.mission) break;
      if (o.accept) {
        a.mission.okStrike = true;
        journal(state, a, 'strikeAuthorized', {}, 'warn');
      } else {
        a.suspended = true;
        a.status = 'suspended';
        journal(state, a, 'strikeRefused');
      }
      break;
    case 'reinforce': {
      const B = cmdBal(state).reinforce;
      a.askAfter = state.time + B.cooldownHours * 3_600_000;
      if (!o.accept) {
        journal(state, a, 'reinforceRefused', { general: who });
        break;
      }
      const ids = (r.unitIds ?? []).filter((id) => {
        const u = state.units[id];
        return !!u && u.owner === n && !u.role && !c.unitArmy[id];
      });
      if (ids.length) {
        addUnits(state, a, ids);
        if (a.mission) a.start += ids.reduce((s, id) => s + unitValue(state, state.units[id]!), 0);
        journal(state, a, 'reinforced', { piles: ids.length }, 'good');
      }
      break;
    }
  }
  if (!a.suspended) scheduleArmy(state, a);
  return { ok: true };
}

// ——— Ordres manuels du joueur, piles créées et disparues ———

const UNIT_ORDERS = new Set([
  'move',
  'attack',
  'stop',
  'patrol',
  'strike',
  'rtb',
  'rebase',
  'blockade',
  'escort',
  'embark',
  'disembark',
  'specialOp',
]);

/**
 * Ordre accepté : un ordre direct du joueur (pas du général) sur une pile d'une armée commandée la
 * place sous ordre manuel ; une pile scindée donne des piles qui restent dans l'armée.
 */
export function onUnitOrder(state: EngineState, n: NationId, o: Order, driving: boolean): void {
  const c = cmdOpt(state);
  if (!c) return;
  if (o.kind === 'split') {
    const aid = c.unitArmy[o.unitId];
    const a = aid ? c.armies[aid] : null;
    const parent = state.units[o.unitId];
    if (!a || !parent) return;
    const at = unitPosAt(state, parent, state.time);
    const fresh: string[] = [];
    for (let i = state.nextUnit; i > Math.max(0, state.nextUnit - 64); i--) {
      const u = state.units[`u${i}`];
      if (!u || u.owner !== n || c.unitArmy[u.id] || u.role) continue;
      if (distanceKm(unitPosAt(state, u, state.time), at) > 1) continue;
      fresh.push(u.id);
    }
    fresh.sort();
    addUnits(state, a, fresh);
    if (a.manual[o.unitId]) for (const id of fresh) a.manual[id] = 1;
    return;
  }
  if (driving || !UNIT_ORDERS.has(o.kind)) return;
  const ids: string[] = [];
  if ('unitIds' in o && Array.isArray(o.unitIds)) ids.push(...(o.unitIds as string[]));
  if ('transportId' in o && typeof o.transportId === 'string') ids.push(o.transportId);
  for (const id of ids) {
    const aid = c.unitArmy[id];
    const a = aid ? c.armies[aid] : null;
    if (!a || a.owner !== n) continue;
    a.manual[id] = 1;
  }
}

/** Pile détruite ou retirée (fusion, salve) : elle quitte son armée. */
export function onUnitGone(state: EngineState, u: Unit, destroyed: boolean): void {
  const c = cmdOpt(state);
  const aid = c?.unitArmy[u.id];
  if (!c || !aid) return;
  const a = c.armies[aid];
  if (!a) {
    delete c.unitArmy[u.id];
    return;
  }
  if (destroyed) {
    a.losses += u.count;
    if (a.mission)
      journal(state, a, 'lost', { system: { system: sysOf(state, u).id }, count: u.count }, 'bad');
  }
  removeUnits(state, a, [u.id]);
}

/** Province prise : l'armée dont une pile tient la ville la compte (journal, expérience). */
export function armiesAt(state: EngineState, n: NationId, at: LngLat): ArmySt[] {
  const c = cmdOpt(state);
  if (!c) return [];
  const out = new Set<string>();
  for (const aid of Object.keys(c.armies).sort()) {
    const a = c.armies[aid]!;
    if (a.owner !== n) continue;
    for (const id of a.units) {
      const u = state.units[id];
      if (!u || u.off) continue;
      if (distanceKm(unitPosAt(state, u, state.time), at) <= CAPTURE_RADIUS_KM * 2) {
        out.add(aid);
        break;
      }
    }
  }
  return [...out].map((id) => c.armies[id]!);
}
