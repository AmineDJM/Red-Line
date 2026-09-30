import type { MissionView, NationId, PlayerView, UnitView } from '@redline/shared';
import { isEmitting, isLanded } from '../../encounters/profile.js';
import { sightLevel, sysOf, veterancyLevel } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { board } from '../kit.js';
import { fuelAt } from './air.js';
import { summariesFor } from './battles.js';
import { generalsFor } from './generals.js';
import { operationsFor } from './ops.js';
import { satellitesFor } from './sensors.js';
import { blockadedProvinces, blockadesView } from './special.js';
import { mil } from './state.js';
import { cellsLeft } from './strike.js';
import { launchCells, posOf } from './util.js';

/**
 * Contribution du module militaire aux vues. Pour ses propres unités : mission, vétérance, général,
 * brouillage, missile (cible et impact prévu), leurre, état embarqué. Pour les unités ennemies :
 * vétérance au niveau « précis », brouilleur repéré, missile détecté (radar ou satellite d'alerte).
 */
function missionView(state: EngineState, u: Unit): MissionView | undefined {
  const m = mil(state).ms[u.id];
  const s = sysOf(state, u);
  const reload = mil(state).reload[u.id];
  const cells = s.movement === 'sea' && launchCells(s) > 0 ? cellsLeft(state, u) : null;
  if (!m) {
    if (reload === undefined && cells === null) return undefined;
    const v: MissionView = { kind: 'none' };
    if (reload !== undefined && reload > state.time) v.readyAt = reload;
    if (cells !== null) v.ammo = cells;
    return v;
  }
  const v: MissionView = { kind: m.mis };
  if (m.at) v.at = m.at;
  if (m.r > 0) v.radiusKm = m.r;
  if (m.tg) v.target = m.tg;
  if (m.fa) {
    v.fuelH = Math.max(0, fuelAt(m, m.ft));
    v.fuelAt = m.ft;
    v.airborne = m.up;
    v.bingoAt = m.bingo;
    if (m.ready > state.time) v.readyAt = m.ready;
  }
  if (m.bk === 'p') v.baseProvinceId = m.base;
  else if (m.bk === 'c') v.baseUnitId = m.base;
  else if (m.fa) v.baseProvinceId = null;
  if (m.ph) v.phase = m.ph;
  if (reload !== undefined && reload > state.time) v.readyAt = reload;
  if (cells !== null) v.ammo = cells;
  const mag = mil(state).mag[u.id];
  if (mag) v.ammo = mag[0];
  return v;
}

export function milView(state: EngineState, me: NationId, view: PlayerView): void {
  const m = mil(state);
  const b = board(state);
  view.alertLevel = b.alertLevel;
  view.operations = operationsFor(state, me);
  view.battleReports = summariesFor(state, me);
  view.generals = generalsFor(state, me);
  view.blockades = blockadesView(state);
  view.satellites = satellitesFor(state, me);
  decorateProvinces(state, view);
  for (const id of Object.keys(view.units)) {
    const v = view.units[id]!;
    const u = state.units[id];
    if (!u) continue;
    if (v.level === 'own') decorateOwn(state, u, v);
    else decorateForeign(state, me, u, v);
  }
  void m;
}

function decorateOwn(state: EngineState, u: Unit, v: UnitView): void {
  const m = mil(state);
  const mv = missionView(state, u);
  if (mv) v.mission = mv;
  v.veterancy = veterancyLevel(state, u.xp);
  const gid = m.unitGen[u.id];
  v.generalId = gid ?? null;
  if (sysOf(state, u).ew.jamming > 0) v.jamming = isEmitting(state, u);
  const st = m.msl[u.id];
  if (st) v.missile = { target: st.target, impactAt: st.impactAt };
  if (u.role === 'decoy') v.decoy = true;
  const ms = m.ms[u.id];
  if (ms?.emb) {
    const c = state.units[ms.emb];
    v.status = 'embarked';
    if (c) {
      v.pos = c.pos;
      if (c.move) v.move = c.move;
      else delete v.move;
    }
  } else if (u.off) {
    v.status = 'idle';
  } else if (isLanded(state, u) && v.status === 'idle') {
    v.status = 'idle';
  }
}

function decorateForeign(state: EngineState, me: NationId, u: Unit, v: UnitView): void {
  const m = mil(state);
  if (v.level === 'precise') v.veterancy = veterancyLevel(state, u.xp);
  if (sightLevel(state, me, u.id) > 0 && isEmitting(state, u)) v.jamming = true;
  const st = m.msl[u.id];
  if (st) v.missile = { target: st.target, impactAt: st.impactAt };
}

function decorateProvinces(state: EngineState, view: PlayerView): void {
  const blk = blockadedProvinces(state);
  const nf = board(state).noFly;
  for (const pid of [...blk].sort()) {
    const p = view.provinces[pid];
    if (p) p.blockaded = true;
  }
  for (const pid of Object.keys(nf).sort()) {
    const p = view.provinces[pid];
    if (p) p.noFlyZone = true;
  }
}

export function milPublicView(state: EngineState, view: PlayerView): void {
  view.alertLevel = board(state).alertLevel;
  view.blockades = blockadesView(state);
  decorateProvinces(state, view);
  for (const id of Object.keys(view.units)) {
    const u = state.units[id];
    if (!u) continue;
    // Pas de secrets : les leurres restent indiscernables, les unités embarquées restent cachées.
    if (u.off) delete view.units[id];
  }
  void posOf;
}
