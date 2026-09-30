import { MODULES, placeStartingForces } from '../modules/registry.js';
import {
  DAY,
  MINUTE,
  RESOURCES,
  destination,
  distanceKm,
  type LngLat,
  type NationId,
  type ProvinceId,
  type Resource,
} from '@redline/shared';
import type { GameSetup, World } from '../api.js';
import { seedRng } from '../rng/rng.js';
import { schedule } from './access.js';
import { addToIndex, emptyRuntime } from './runtime.js';
import {
  STATE_FORMAT,
  type AiLevel,
  type EngineState,
  type NationState,
  type StateData,
} from './types.js';
import { wi } from './world.js';
import { spawnUnit } from './units.js';
import { registerProvinceZone } from '../encounters/pairs.js';
import { cleanTop, settle } from '../sim/settle.js';

/** Attache le monde et des index dérivés vides (non énumérables) à des données d'état. */
export function attachState(world: World, data: StateData): EngineState {
  const state = data as unknown as EngineState;
  Object.defineProperty(state, 'world', { value: world, enumerable: false, writable: false });
  Object.defineProperty(state, 'rt', { value: emptyRuntime(), enumerable: false, writable: false });
  return state;
}

export function createGameImpl(world: World, setup: GameSetup): EngineState {
  const w = wi(world);
  const bal = world.balance;
  const nationIds = [
    ...new Set((setup.nationIds ?? w.nationIds).filter((n) => w.nationById.has(n))),
  ].sort();
  const inGame = new Set(nationIds);
  const players = setup.players
    .filter((p) => inGame.has(p.nationId))
    .map((p) => ({
      nationId: p.nationId,
      isAi: p.isAi,
      aiLevel: (p.aiLevel ?? 'normal') as AiLevel,
    }))
    .sort((a, b) => (a.nationId < b.nationId ? -1 : a.nationId > b.nationId ? 1 : 0));

  const data: StateData = {
    fmt: STATE_FORMAT,
    time: 0,
    setup: { seed: setup.seed, players },
    rng: seedRng(setup.seed),
    seq: 0,
    nextUnit: 0,
    nextProd: 0,
    queue: [],
    nationIds,
    nations: {},
    provinces: {},
    totalProvinces: 0,
    units: {},
    wars: {},
    pairs: {},
    sight: {},
    know: {},
    pending: [],
    winner: null,
    mods: {},
  };
  for (const pid of w.provIds) {
    const def = w.provById.get(pid)!;
    if (!inGame.has(def.nationId)) continue;
    data.provinces[pid] = { id: pid, owner: def.nationId, capture: null, capV: 0 };
    data.totalProvinces++;
  }
  for (const n of nationIds) {
    const p = players.find((x) => x.nationId === n);
    const res = {} as Record<Resource, number>;
    for (const r of RESOURCES) res[r] = bal.economy.startingResources[r] ?? 0;
    const count = (w.provsByNation.get(n) ?? []).filter((pid) => data.provinces[pid]).length;
    const ns: NationState = {
      id: n,
      isAi: !p || p.isAi,
      isPlayer: !!p && !p.isAi,
      active: !!p,
      aiLevel: p?.aiLevel ?? 'normal',
      alive: count > 0,
      money: bal.economy.startingMoney,
      res,
      provinceCount: count,
      production: [],
    };
    data.nations[n] = ns;
  }

  const state = attachState(world, data);
  state.rt.silent = true;
  for (const pid of Object.keys(state.provinces).sort()) {
    registerProvinceZone(state, pid);
    addToIndex(state.rt.provsOf, state.provinces[pid]!.owner, pid);
  }

  for (const m of MODULES) m.init?.(state, setup);

  if (setup.units) {
    for (const spec of setup.units) {
      if (!inGame.has(spec.owner)) throw new Error(`nation absente de la partie : ${spec.owner}`);
      if (!world.catalog.has(spec.systemId)) throw new Error(`système inconnu : ${spec.systemId}`);
      spawnUnit(state, spec.owner, spec.systemId, spec.pos, spec.count);
    }
  } else {
    for (const n of nationIds) if (!placeStartingForces(state, n)) placeArmy(state, n);
  }

  schedule(state, { k: 'day', t: DAY });
  schedule(state, { k: 'ai', t: bal.time.aiThinkMinutes * MINUTE });
  settle(state);
  cleanTop(state);
  state.rt.silent = false;
  state.pending = [];
  return state;
}

/** Armée de départ (joueurs et IA actives) ou garnison (neutres), autour de la capitale et de quelques provinces. */
function placeArmy(state: EngineState, n: NationId): void {
  const w = wi(state.world);
  const ns = state.nations[n]!;
  const army = ns.active ? state.world.balance.startingArmy : state.world.balance.garrisonArmy;
  const owned = (w.provsByNation.get(n) ?? []).filter((pid) => state.provinces[pid]);
  if (owned.length === 0) return;
  const capId = w.nationById.get(n)!.capitalProvinceId;
  const capital: ProvinceId = owned.includes(capId) ? capId : owned[0]!;
  const capPt = w.provById.get(capital)!.cityPoint;
  const others = owned
    .filter((p) => p !== capital)
    .map((p) => ({ p, d: distanceKm(w.provById.get(p)!.cityPoint, capPt) }))
    .sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : 1))
    .map((x) => x.p);
  const sites = [capital, ...others].slice(0, 4);
  const perSite = new Map<ProvinceId, number>();
  const gc = state.world.balance.combat.groundContactKm;
  let i = 0;
  for (const entry of army) {
    const sys = state.world.catalog.get(entry.systemId);
    if (!sys) continue;
    for (let c = 0; c < entry.count; c++) {
      const site = sites[i % sites.length]!;
      i++;
      let pos: LngLat | null;
      if (sys.movement === 'sea') {
        pos = w.seaSpawn.get(site) ?? sites.map((s) => w.seaSpawn.get(s)).find((x) => !!x) ?? null;
      } else {
        const k = perSite.get(site) ?? 0;
        perSite.set(site, k + 1);
        const city = w.provById.get(site)!.cityPoint;
        pos = city;
        if (k > 0) {
          const cand = destination(city, (k * 137.508) % 360, gc * 0.3 * (1 + (k % 3) / 3));
          const cell = w.nav.cellAt(cand);
          if (w.nav.cellProv.get(cell) === site) pos = cand;
        }
      }
      if (pos) spawnUnit(state, n, sys.id, pos);
    }
  }
}
