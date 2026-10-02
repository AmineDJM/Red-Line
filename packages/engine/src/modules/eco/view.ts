import {
  BUILDING_TYPES,
  MODIFIER_KEYS,
  type BuildOptionView,
  type BuildingType,
  type BuildingView,
  type DeliveryView,
  type GameNotification,
  type MarketOffer,
  type ModifierKey,
  type NationId,
  type PlayerView,
  type ProvinceId,
} from '@redline/shared';
import { provincesOf } from '../../state/access.js';
import type { EngineState } from '../../state/types.js';
import { board } from '../kit.js';
import { buildRestriction, buildingsOf, depotsOf, health, levelOf, power } from './buildings.js';
import { cfg, effect } from './config.js';
import { economyDetail } from './detail.js';
import { researchModifier } from './research.js';
import { eco, ecoNation, sortedIds } from './state.js';

/** Sections publiques : mobilisation, embargo, bâtiments construits, blocus. */
function publicParts(state: EngineState, view: PlayerView): void {
  const b = board(state);
  for (const id of Object.keys(view.nations).sort()) {
    const nv = view.nations[id]!;
    if (b.mobilized[id]) nv.mobilized = true;
    if (b.embargoed[id]) nv.embargoed = true;
  }
  const es = eco(state);
  for (const pid of sortedIds(es.blockaded)) {
    const pv = view.provinces[pid];
    if (pv) pv.blockaded = true;
  }
}

/**
 * Devis d'un chantier (même formule que `buildOrder`) : coût × croissance^(niveau − 1), durée ×
 * (1 + croissance × (niveau − 1)) ÷ vitesse des chantiers de la province (industrie locale).
 */
function quote(
  state: EngineState,
  pid: ProvinceId,
  kind: string,
  lvl: number,
): { cost: number; hours: number } {
  const c = cfg(state.world).buildings;
  const speed =
    1 +
    effect(state.world, 'local_industry', 'buildSpeedPerLevel', 0) *
      power(state, pid, 'local_industry');
  return {
    cost: Math.round((c.buildCostUsd[kind] ?? 0) * Math.pow(c.levelCostGrowth, lvl - 1)),
    hours:
      Math.round(
        (((c.buildHours[kind] ?? 24) * (1 + c.levelTimeGrowth * (lvl - 1))) / speed) * 100,
      ) / 100,
  };
}

export function ecoView(state: EngineState, me: NationId, view: PlayerView): void {
  const es = eco(state);
  const en = ecoNation(state, me);
  publicParts(state, view);

  // Recherche
  if (state.world.research || en.done.length > 0) {
    const modifiers: Partial<Record<ModifierKey, number>> = {};
    for (const k of MODIFIER_KEYS) {
      const v = researchModifier(state, me, k);
      if (v !== 1) modifiers[k] = v;
    }
    view.research = {
      current: en.cur
        ? { id: en.cur.id, startedAt: en.cur.startedAt, completesAt: en.cur.completesAt }
        : null,
      queue: en.queue.map((q) => q.id),
      done: [...en.done],
      modifiers,
    };
  }
  view.licences = sortedIds(en.licences).map((systemId) => ({
    systemId,
    acquiredAt: en.licences[systemId]!,
  }));

  // Marché
  const offers: MarketOffer[] = [];
  for (const id of sortedIds(es.offers)) {
    const o = es.offers[id]!;
    if (o.seller !== me && o.to !== null && o.to !== me) continue;
    offers.push({ ...o, item: { ...o.item } });
  }
  const deliveries: DeliveryView[] = [];
  for (const id of sortedIds(es.dlv)) {
    const d = es.dlv[id]!;
    if (d.from !== me && d.to !== me) continue;
    deliveries.push({
      id: d.id,
      from: d.from,
      to: d.to,
      item: { ...d.item },
      carrierUnitId: d.carrier,
      eta: d.eta,
      covert: d.covert,
    });
  }
  view.market = { offers, deliveries, embargoed: Object.keys(board(state).embargoed).sort() };

  // Logistique
  view.logistics = {
    depots: depotsOf(state, me).map((d) => ({
      id: `${d.pid}:forward_base`,
      provinceId: d.pid,
      at: d.at,
      rangeKm: d.rangeKm,
    })),
    mobilized: !!board(state).mobilized[me],
    mobilizedSince: en.mobSince,
  };

  // Bâtiments et fortifications des provinces possédées
  const jobsByProv = new Map<string, { kind: string; t: number; lvl: number }[]>();
  for (const id of sortedIds(es.jobs)) {
    const j = es.jobs[id]!;
    if (j.n !== me) continue;
    let l = jobsByProv.get(j.pid);
    if (!l) jobsByProv.set(j.pid, (l = []));
    l.push({ kind: j.kind, t: j.completesAt, lvl: j.lvl });
  }
  const maxLevel = cfg(state.world).buildings.maxLevel;
  const maxFort = effect(state.world, 'fortification', 'maxLevel', 3);
  for (const pid of provincesOf(state, me)) {
    const pv = view.provinces[pid];
    if (!pv) continue;
    const jobs = jobsByProv.get(pid) ?? [];
    const present = buildingsOf(state, pid);
    const list: BuildingView[] = [];
    for (const b of present) {
      const level = levelOf(state, pid, b);
      const bv: BuildingView = { type: b, level, health: health(state, pid, b) };
      const rep = es.bld[pid]?.[b]?.rep;
      if (rep !== undefined && rep !== null) bv.repairUntil = rep;
      const up = jobs.find((j) => j.kind === b);
      if (up) bv.upgradeUntil = up.t;
      bv.next = level >= maxLevel ? null : { level: level + 1, ...quote(state, pid, b, level + 1) };
      list.push(bv);
    }
    // Options de construction : bâtiments absents (niveau 1) et fortification.
    const options: BuildOptionView[] = [];
    for (const b of BUILDING_TYPES) {
      if (present.includes(b)) continue;
      const o: BuildOptionView = { type: b, level: 1, ...quote(state, pid, b, 1) };
      const why = buildRestriction(state.world, pid, b);
      if (why) o.blocked = why;
      else if (jobs.some((j) => j.kind === b)) o.blocked = 'in_progress';
      options.push(o);
    }
    const fort = (es.forts[pid] ?? 0) + 1;
    const fo: BuildOptionView = {
      type: 'fortification',
      level: Math.min(fort, maxFort),
      ...quote(state, pid, 'fortification', Math.min(fort, maxFort)),
    };
    if (fort > maxFort) fo.blocked = 'max_level';
    else if (jobs.some((j) => j.kind === 'fortification')) fo.blocked = 'in_progress';
    options.push(fo);
    pv.buildOptions = options;
    for (const j of jobs) {
      if (j.kind === 'fortification' || present.includes(j.kind as BuildingType)) continue;
      list.push({
        type: j.kind as BuildingType,
        level: 0,
        health: 0,
        buildUntil: j.t,
        upgradeUntil: j.t,
      });
    }
    pv.buildings = present;
    pv.buildingState = list;
    const lvl = es.forts[pid] ?? 0;
    const fj = jobs.find((j) => j.kind === 'fortification');
    if (lvl > 0 || fj)
      pv.fortification = { provinceId: pid, level: lvl, completesAt: fj?.t ?? null };
  }

  if (es.live) view.economy.detail = economyDetail(state, me);

  // Ravitaillement des unités
  if (es.live) {
    for (const id of Object.keys(view.units).sort()) {
      const uv = view.units[id]!;
      if (uv.level !== 'own') continue;
      uv.supply = es.supply[id] ?? 'supplied';
    }
  }
}

export function ecoPublicView(state: EngineState, view: PlayerView): void {
  publicParts(state, view);
}

/** Destinataires des notifications du module après désérialisation (brouillard). */
export function ecoAudience(
  state: EngineState,
  nation: NationId,
  note: GameNotification,
): boolean | undefined {
  switch (note.kind) {
    case 'building_hit':
      return state.provinces[note.provinceId]?.owner === nation;
    case 'research_complete':
      return eco(state).nations[nation]?.doneAt[note.nodeId] === note.time;
    case 'delivery':
      // Livraison terminée : plus d'état, règle prudente (aucun destinataire connu).
      return undefined;
    default:
      return undefined;
  }
}
