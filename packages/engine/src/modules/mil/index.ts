import { HOUR, type Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import type { EngineState, Unit } from '../../state/types.js';
import { nationUnits, sortedKeys, sysOf } from '../../state/access.js';
import { ceasefire, targetClassOf } from '../../encounters/profile.js';
import { board } from '../kit.js';
import type { EngineModule, ModEvent } from '../types.js';
import { combatAi } from './ai.js';
import {
  handleBingo,
  handleFuelout,
  handleScan,
  initAircraft,
  interceptMove,
  onAirMovement,
  onMissionArrived,
  orderPatrol,
  orderRebase,
  orderRtb,
} from './air.js';
import { addTension, decayTension, raiseAlert, syncLevel } from './alert.js';
import { handleClose, noteDestroyed, recordHit } from './battles.js';
import {
  dropFromGeneral,
  generalModifier,
  handleGeneral,
  initGenerals,
  orderAppoint,
  orderDelegate,
  releaseOnOrder,
} from './generals.js';
import { orderNuclearAuth } from './nuclear.js';
import { handleOpStep, orderCancelOperation, orderOperation, pruneOps } from './ops.js';
import {
  blindRadars,
  handleDecoyEnd,
  handleOth,
  handleSatPass,
  handleUnblind,
  initOth,
  initSatellite,
  orderJam,
  spawnDecoys,
} from './sensors.js';
import {
  blockadeUnitChanged,
  captureMateriel,
  defenseModifier,
  onDefenseSignal,
  orderBlockade,
  orderMerge,
  orderSpecialOp,
  orderSplit,
  resolveSpecialOp,
} from './special.js';
import { emptyMil, mil, milBal } from './state.js';
import { countLoss, elementsLost, fillStats } from './stats.js';
import {
  expose,
  forgetMissile,
  handleIntercept,
  handleUnexpose,
  impact,
  orderStrike,
  reloadShipsInPort,
  scheduleInterceptions,
} from './strike.js';
import { milPublicView, milView } from './view.js';
import { isSatellite, schedule } from './util.js';
import { battleReportForImpl } from './battles.js';
import { destroyUnit, jammingFor } from '../../combat/combat.js';
import { signal } from '../registry.js';

/** Combat complet : aviation (missions, carburant, ravitaillement), marine, sous-marins, missiles et interception, nucléaire et alerte mondiale, opérations combinées, rapports de bataille, capteurs, satellites, brouillage, généraux, forces spéciales, blocus, matériel capturé, bâtiments de défense. */

type Handler = (state: EngineState, n: string, order: Order) => OrderResult;
const h = <K extends Order['kind']>(
  fn: (state: EngineState, n: string, o: Extract<Order, { kind: K }>) => OrderResult,
): Handler => fn as unknown as Handler;

function onEvent(state: EngineState, ev: ModEvent): void {
  const d = ev.d as never;
  switch (ev.e) {
    case 'bingo':
      return handleBingo(state, d);
    case 'fuelout':
      return handleFuelout(state, d);
    case 'scan':
      return handleScan(state, d);
    case 'icpt':
      return handleIntercept(state, d);
    case 'opstep':
      return handleOpStep(state, d);
    case 'bclose':
      return handleClose(state, d);
    case 'sat':
      return handleSatPass(state, d);
    case 'oth':
      return handleOth(state, d);
    case 'gen':
      return handleGeneral(state, d);
    case 'unblind':
      return handleUnblind(state, d);
    case 'unexpose':
      return handleUnexpose(state, d);
    case 'decoyEnd':
      return handleDecoyEnd(state, d);
    case 'tick':
      return handleTick(state);
  }
}

/**
 * Tick horaire léger : cessez-le-feu qui commencent ou s'achèvent et zones d'exclusion aérienne qui
 * changent (écrits par diplo) ⇒ réévaluation du combat des unités concernées.
 */
function handleTick(state: EngineState): void {
  schedule(state, state.time + HOUR, 'tick');
  const m = mil(state);
  const b = board(state);
  const active: Record<string, number> = {};
  for (const k of sortedKeys(b.ceasefires)) if (b.ceasefires[k]! > state.time) active[k] = b.ceasefires[k]!;
  const changed = new Set<string>();
  for (const k of Object.keys(active)) if (m.cf[k] === undefined) changed.add(k);
  for (const k of Object.keys(m.cf)) if (active[k] === undefined) changed.add(k);
  m.cf = active;
  for (const k of [...changed].sort()) {
    for (const n of k.split('|')) for (const id of nationUnits(state, n)) state.rt.dirtyCombat.add(id);
  }
  const nf = sortedKeys(b.noFly).join(',');
  if (nf !== m.nf) {
    m.nf = nf;
    for (const id of sortedKeys(state.units)) {
      const u = state.units[id]!;
      if (sysOf(state, u).movement === 'air') state.rt.dirtyCombat.add(id);
    }
  }
}

function onSpawn(state: EngineState, u: Unit): void {
  if (u.role) return;
  const s = sysOf(state, u);
  if (isSatellite(s)) {
    initSatellite(state, u);
    return;
  }
  initAircraft(state, u);
  initOth(state, u);
}

function onGone(state: EngineState, u: Unit): void {
  const m = mil(state);
  if (u.role === 'missile') forgetMissile(state, u.id);
  // Aéronefs embarqués : perdus avec leur porteur.
  for (const id of sortedKeys(m.ms)) {
    const ms = m.ms[id]!;
    if (ms.emb === u.id) {
      const a = state.units[id];
      delete m.ms[id];
      if (a) {
        countLoss(state, a, a.count, null);
        destroyUnit(state, a, null);
      }
    } else if (ms.bk === 'c' && ms.base === u.id) {
      ms.bk = null;
      ms.base = null;
    }
  }
  blockadeUnitChanged(state, u, true);
  delete m.ms[u.id];
  delete m.reload[u.id];
  delete m.cells[u.id];
  delete m.mag[u.id];
  delete m.icw[u.id];
  delete m.jamOff[u.id];
  delete m.exposed[u.id];
  delete m.decoy[u.id];
  delete m.sats[u.id];
  delete m.sf[u.id];
  const fp = m.fixedOf[u.id];
  if (fp) {
    delete m.fixedOf[u.id];
    for (const k of Object.keys(m.fixed)) if (m.fixed[k] === u.id) delete m.fixed[k];
  }
  if (Object.keys(m.icq).length > 0) {
    const prefix = `${u.id}>`;
    for (const k of Object.keys(m.icq)) if (k.startsWith(prefix)) delete m.icq[k];
  }
  dropFromGeneral(state, u.id);
}

export const milModule: EngineModule = {
  id: 'mil',
  init(state, setup) {
    (state.mods as Record<string, unknown>).mil = emptyMil();
    initGenerals(state, setup);
    schedule(state, HOUR, 'tick');
    syncLevel(state);
  },
  rebuild(state) {
    mil(state);
  },
  onEvent,
  orders: {
    patrol: h<'patrol'>(orderPatrol),
    strike: h<'strike'>(orderStrike),
    rtb: h<'rtb'>(orderRtb),
    rebase: h<'rebase'>(orderRebase),
    jam: h<'jam'>(orderJam),
    blockade: h<'blockade'>(orderBlockade),
    specialOp: h<'specialOp'>(orderSpecialOp),
    split: h<'split'>(orderSplit),
    merge: h<'merge'>(orderMerge),
    appointGeneral: h<'appointGeneral'>(orderAppoint),
    delegate: h<'delegate'>(orderDelegate),
    nuclearAuth: h<'nuclearAuth'>(orderNuclearAuth),
    operation: h<'operation'>(orderOperation),
    cancelOperation: h<'cancelOperation'>(orderCancelOperation),
  },
  view: milView,
  publicView: milPublicView,
  hooks: {
    onDailyTick(state) {
      decayTension(state);
      reloadShipsInPort(state);
      pruneOps(state);
    },
    onUnitSpawned: onSpawn,
    onUnitDestroyed(state, u, killer) {
      noteDestroyed(state, u);
      if (sysOf(state, u).category === 'logistics' && killer && killer.owner !== u.owner) {
        signalDelivery(state, u, killer);
      }
      onGone(state, u);
    },
    onUnitRemoved(state, u) {
      onGone(state, u);
    },
    onDamage(state, att, tgt, dmg) {
      const lost = elementsLost(state, tgt, tgt.hp);
      countLoss(state, tgt, lost, att);
      const b = recordHit(state, att, tgt, lost, targetClassOf(state, tgt));
      if (jammingFor(state, tgt) > 0) b.cm.jamming = (b.cm.jamming ?? 0) + 1;
      if (tgt.role !== 'decoy' && tgt.owner !== att.owner && !att.role) {
        if (!(state.sight[tgt.owner]?.[att.id])) b.cm.stealth = (b.cm.stealth ?? 0) + 1;
      }
      if (tgt.role === 'decoy') {
        b.cm.decoy = (b.cm.decoy ?? 0) + 1;
        // Un leurre ne résiste pas à un coup au but.
        tgt.hp = Math.min(tgt.hp, 1e-7);
      }
      const as = sysOf(state, att);
      if (as.naval?.submerged && !att.role && dmg > 0) expose(state, att);
    },
    onMovementChanged(state, u) {
      onAirMovement(state, u);
      blockadeUnitChanged(state, u, false);
    },
    onArrived(state, u) {
      if (u.role === 'missile') {
        impact(state, u);
        return;
      }
      if (mil(state).sf[u.id]) resolveSpecialOp(state, u);
      if (!state.units[u.id]) return;
      onMissionArrived(state, u);
      if (state.units[u.id]) blockadeUnitChanged(state, u, false);
    },
    onCombatRefresh(state, u) {
      scheduleInterceptions(state, u);
    },
    onOrder(state, n, order) {
      releaseOnOrder(state, n, order);
    },
    interceptOrder(state, n, order) {
      if (order.kind === 'move') return interceptMove(state, n, order);
      if (order.kind === 'attack') {
        for (const id of order.unitIds) {
          const ms = mil(state).ms[id];
          const u = state.units[id];
          if (u && u.owner === n && ms?.fa && !ms.up && ms.ready > state.time) {
            return { ok: false, error: 'cooldown', message: 'Appareil en remise en œuvre au sol.' };
          }
        }
        const tgt = state.units[order.targetId];
        if (tgt && ceasefire(state, n, tgt.owner)) {
          return { ok: false, error: 'locked', message: 'Cessez-le-feu en vigueur.' };
        }
      }
      return null;
    },
    unitModifier(state, u, key) {
      return generalModifier(state, u, key) * defenseModifier(state, u, key);
    },
    onProvinceCaptured(state, pid, from, to) {
      captureMateriel(state, pid, from, to);
    },
    onWarDeclared(state) {
      raiseAlert(state, milBal(state).tension.war, 'war');
    },
    onSignal(state, name, data) {
      switch (name) {
        case 'alert':
          addTension(state, Number(data.amount) || 0);
          return;
        case 'cyber':
          if (data.kind === 'radar') blindRadars(state, data.victim as string, Number(data.hours) || 0);
          return;
        case 'decoys':
          spawnDecoys(state, data);
          return;
        case 'static_defense':
        case 'radar_station':
          onDefenseSignal(state, name, data);
          return;
      }
    },
    audience(state, nation, note) {
      switch (note.kind) {
        case 'alert_level':
          return true;
        case 'battle_report': {
          const b = mil(state).battles[note.reportId];
          return !!b && (b.a.nations.includes(nation) || b.d.nations.includes(nation));
        }
        case 'operation':
          return mil(state).ops[note.operationId]?.owner === nation;
        case 'missile_launch': {
          const u = state.units[note.unitId];
          return !!u && (u.owner === nation || !!state.know[nation]?.[u.id]);
        }
        case 'building_hit':
          return state.provinces[note.provinceId]?.owner === nation;
        default:
          return undefined;
      }
    },
    aiThink(state, n) {
      combatAi(state, n);
    },
    stats: fillStats,
  },
};

/** Porteur logistique détruit par l'ennemi : les livraisons appartiennent au module eco. */
function signalDelivery(state: EngineState, u: Unit, killer: Unit): void {
  signal(state, 'delivery_intercepted', { deliveryId: null, carrierUnitId: u.id, by: killer.owner });
}

/** Détail d'un rapport de bataille pour une nation qui y a pris part. */
export const battleReportFor = battleReportForImpl;
