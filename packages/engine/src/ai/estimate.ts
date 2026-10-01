import {
  DAY,
  distanceKm,
  type LngLat,
  type NationId,
  type Orbat,
  type ProvinceId,
} from '@redline/shared';
import type { Contact, EngineState } from '../state/types.js';
import { nationUnits, sortedKeys } from '../state/access.js';
import { wi } from '../state/world.js';
import { board } from '../modules/registry.js';
import { budgetDay } from '../modules/eco/budget.js';
import { eco, orbatOf } from '../modules/eco/state.js';
import { nationCoverage } from '../modules/intel/provinces.js';
import { aiCfg } from './config.js';

/**
 * Estimations de rapport de force SANS tricher : une nation connaît ses propres unités, ses contacts
 * (brouillard de guerre : `state.know`), la carte politique publique (provinces, alliances) et ce qui
 * est publié de chaque armée : l'ORBAT de départ (inventaire réel, fiabilité de la source) et le budget
 * de défense. L'estimation part de cet ORBAT public, corrigé par le territoire perdu depuis et par ce
 * que le budget permet d'avoir produit, majoré d'une incertitude (qui grandit avec le temps et diminue
 * avec la reconnaissance militaire du pays) puis par la prudence du niveau ; jamais en dessous des
 * forces réellement vues. Sans ORBAT (bac à sable, données absentes) : hypothèse miroir, autant de
 * forces par province que soi.
 */

/** Valeur d'un élément de système (prix unitaire : bon indicateur de puissance relative). */
export function elementValue(state: EngineState, sysId: string): number {
  const s = state.world.catalog.get(sysId);
  if (!s) return 0;
  return Math.max(1, s.cost.money / Math.max(1, s.unitSize));
}

export interface OwnForce {
  value: number;
  perProvince: number;
  avgUnit: number;
}

export function ownForce(state: EngineState, n: NationId): OwnForce {
  let value = 0;
  let count = 0;
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    value += elementValue(state, u.sys) * u.count * (u.hp / Math.max(1, u.maxHp));
    count++;
  }
  const provs = Math.max(1, state.nations[n]!.provinceCount);
  return { value, perProvince: value / provs, avgUnit: count > 0 ? value / count : 1 };
}

/**
 * Mémo des forces connues par nation observée, actif pendant une réflexion stratégique
 * (withForceMemo) et invalidé à chaque ordre donné (invalidateForceMemo) : entre deux ordres, les
 * contacts de la nation ne changent pas. Un seul parcours trié des contacts cumule toutes les nations
 * dans le même ordre d'additions que le parcours filtré d'origine : sommes identiques bit à bit.
 */
let memoOn = false;
let memo: { state: EngineState; n: NationId; mine: OwnForce; known: Map<NationId, number> } | null =
  null;

export function withForceMemo(fn: () => void): void {
  if (memoOn) {
    fn();
    return;
  }
  memoOn = true;
  try {
    fn();
  } finally {
    memoOn = false;
    memo = null;
  }
}

export function invalidateForceMemo(): void {
  memo = null;
}

export function contactValue(state: EngineState, c: Contact, mine: OwnForce): number {
  if (c.lvl >= 2 && c.sys) {
    const sys = state.world.catalog.get(c.sys);
    const count = c.lvl >= 3 && c.count !== null ? c.count : (sys?.unitSize ?? 1);
    return elementValue(state, c.sys) * count * (c.hpr ?? 1);
  }
  return mine.avgUnit;
}

function knownForce(state: EngineState, n: NationId, t: NationId, mine: OwnForce): number {
  const k = state.know[n];
  if (memoOn) {
    if (!memo || memo.state !== state || memo.n !== n || memo.mine !== mine) {
      const known = new Map<NationId, number>();
      if (k) {
        for (const id of sortedKeys(k)) {
          const c = k[id]!;
          known.set(c.owner, (known.get(c.owner) ?? 0) + contactValue(state, c, mine));
        }
      }
      memo = { state, n, mine, known };
    }
    return memo.known.get(t) ?? 0;
  }
  let known = 0;
  if (k) {
    for (const id of sortedKeys(k)) {
      const c = k[id]!;
      if (c.owner !== t) continue;
      known += contactValue(state, c, mine);
    }
  }
  return known;
}

/** Valeur de l'inventaire publié d'un ORBAT (systèmes du catalogue seulement), par ORBAT. */
const orbatValueCache = new WeakMap<Orbat, number>();

function orbatValue(state: EngineState, o: Orbat): number {
  let v = orbatValueCache.get(o);
  if (v === undefined) {
    v = 0;
    for (const it of o.inventory) {
      if (it.count <= 0 || !state.world.catalog.get(it.systemId)) continue;
      v += elementValue(state, it.systemId) * it.count;
    }
    orbatValueCache.set(o, v);
  }
  return v;
}

/** Fiabilité publiée d'un ORBAT → incertitude de départ. */
function baseUncertainty(state: EngineState, o: Orbat): number {
  const E = aiCfg(state.world).estimate;
  return o.confidence === 'high'
    ? E.uncertaintyHigh
    : o.confidence === 'low'
      ? E.uncertaintyLow
      : E.uncertaintyMedium;
}

/**
 * Force publique de `t` vue par `n` : ORBAT publié, moins une part des forces avec le territoire perdu,
 * plus la production que son budget de défense (public) a pu financer depuis le début de la partie ;
 * `sigma` = incertitude relative (fiabilité de la source, âge, reconnaissance militaire de `n`).
 * null sans ORBAT ou sans économie réelle.
 */
export function publicForce(
  state: EngineState,
  n: NationId,
  t: NationId,
): { mean: number; sigma: number } | null {
  const E = aiCfg(state.world).estimate;
  if (!E.useOrbat || !eco(state).live) return null;
  const o = orbatOf(state, t);
  if (!o) return null;
  const init = wi(state.world).provsByNation.get(t)?.length ?? 0;
  const cur = state.nations[t]?.provinceCount ?? 0;
  const kept = init > 0 && cur < init ? 1 - E.territoryLoss * (1 - cur / init) : 1;
  const days = state.time / DAY;
  const mean = orbatValue(state, o) * kept + budgetDay(state, t) * days * E.productionShare;
  let sigma = Math.min(E.maxUncertainty, baseUncertainty(state, o) + E.uncertaintyPerDay * days);
  const cov = nationCoverage(state, n, t, 'm');
  if (cov.total > 0) sigma *= 1 - E.reconDiscount * (cov.known / cov.total);
  return { mean, sigma };
}

/** Force estimée de `t` du point de vue de `n` (pessimiste : moyenne × (1 + incertitude) × prudence). */
export function estimateForce(
  state: EngineState,
  n: NationId,
  t: NationId,
  mine: OwnForce,
  caution: number,
): number {
  const known = knownForce(state, n, t, mine);
  const pub = publicForce(state, n, t);
  if (pub) return Math.max(known, pub.mean * (1 + pub.sigma)) * caution;
  const tn = state.nations[t];
  const mirror = (tn?.provinceCount ?? 0) * mine.perProvince;
  return Math.max(known, mirror) * caution;
}

/** Membres de l'alliance de `t` liés par la défense mutuelle (charte publique), hors `t` et hors `except`. */
export function mutualAllies(state: EngineState, t: NationId, except: NationId): NationId[] {
  const b = board(state);
  const id = b.allianceOf[t];
  if (!id || !b.allianceCharters?.[id]?.mutualDefense) return [];
  return state.nationIds.filter(
    (m) => m !== t && m !== except && b.allianceOf[m] === id && state.nations[m]!.alive,
  );
}

/** Nations voisines (provinces adjacentes), carte publique. */
export function neighborNations(state: EngineState, n: NationId): NationId[] {
  return adjacency(state).get(n) ?? [];
}

/**
 * Voisinages de toutes les nations, recalculés seulement quand la carte politique change (version
 * `ownerV` tenue par le module diplo). Le cache est une fonction pure de l'état : aucun effet sur le
 * déterminisme ni sur le rejeu.
 */
const adjCache = new WeakMap<EngineState, { v: number; map: Map<NationId, NationId[]> }>();

function ownerVersion(state: EngineState): number {
  const d = (state.mods as Record<string, { ownerV?: number } | undefined>).diplo;
  return d?.ownerV ?? -1;
}

export function adjacency(state: EngineState): Map<NationId, NationId[]> {
  const v = ownerVersion(state);
  const hit = adjCache.get(state);
  if (hit && hit.v === v && v >= 0) return hit.map;
  const w = wi(state.world);
  const sets = new Map<NationId, Set<NationId>>();
  for (const pid of sortedKeys(state.provinces)) {
    const o = state.provinces[pid]!.owner;
    if (!w.nationById.has(o)) continue;
    for (const nb of w.provById.get(pid)!.neighbors) {
      const x = state.provinces[nb]?.owner;
      if (!x || x === o || !w.nationById.has(x)) continue;
      let s = sets.get(o);
      if (!s) sets.set(o, (s = new Set()));
      s.add(x);
    }
  }
  const map = new Map<NationId, NationId[]>();
  for (const [k, s] of sets) map.set(k, [...s].sort());
  adjCache.set(state, { v, map });
  return map;
}

/**
 * Provinces côtières (accès à la mer) dont la ville est à moins de `amphibiousReachKm` d'une autre
 * ville côtière, sans frontière terrestre entre elles : liaisons possibles d'un débarquement (carte
 * statique, par monde ; triées).
 */
const seaLinkCache = new WeakMap<object, Map<ProvinceId, ProvinceId[]>>();

export function seaLinks(state: EngineState): Map<ProvinceId, ProvinceId[]> {
  let m = seaLinkCache.get(state.world);
  if (m) return m;
  m = new Map();
  const w = wi(state.world);
  const reach = aiCfg(state.world).tactical.amphibiousReachKm;
  const coastal = [...w.seaSpawn.keys()].filter((p) => !!w.seaSpawn.get(p)).sort();
  // Cases de 5° pour borner les comparaisons.
  const cell = (p: LngLat) => `${Math.floor(p[0] / 5)},${Math.floor(p[1] / 5)}`;
  const grid = new Map<string, ProvinceId[]>();
  for (const p of coastal) {
    const k = cell(w.provById.get(p)!.cityPoint);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(p);
  }
  const spanY = Math.ceil(reach / 555) + 1;
  for (const p of coastal) {
    const def = w.provById.get(p)!;
    const at = def.cityPoint;
    const cx = Math.floor(at[0] / 5);
    const cy = Math.floor(at[1] / 5);
    const cos = Math.max(0.1, Math.cos((Math.min(89, Math.abs(at[1]) + 5) * Math.PI) / 180));
    const spanX = Math.min(36, Math.ceil(reach / (555 * cos)) + 1);
    const out = new Set<ProvinceId>();
    for (let dx = -spanX; dx <= spanX; dx++) {
      for (let dy = -spanY; dy <= spanY; dy++) {
        const x = (((cx + dx) % 72) + 72) % 72;
        for (const q of grid.get(`${x >= 36 ? x - 72 : x},${cy + dy}`) ?? []) {
          if (q === p || def.neighbors.includes(q)) continue;
          if (distanceKm(at, w.provById.get(q)!.cityPoint) <= reach) out.add(q);
        }
      }
    }
    if (out.size) m.set(p, [...out].sort());
  }
  seaLinkCache.set(state.world, m);
  return m;
}

/** Nations atteignables par la mer depuis `n` (débarquement), hors voisins terrestres ; triées. */
const overseasCache = new WeakMap<EngineState, { v: number; map: Map<NationId, NationId[]> }>();

export function overseasNations(state: EngineState, n: NationId): NationId[] {
  const v = ownerVersion(state);
  let hit = overseasCache.get(state);
  if (!hit || hit.v !== v || v < 0) {
    hit = { v, map: new Map() };
    overseasCache.set(state, hit);
  }
  let list = hit.map.get(n);
  if (list) return list;
  const links = seaLinks(state);
  const land = new Set(neighborNations(state, n));
  const out = new Set<NationId>();
  for (const p of state.rt.provsOf.get(n) ?? []) {
    for (const q of links.get(p) ?? []) {
      const o = state.provinces[q]?.owner;
      if (o && o !== n && !land.has(o)) out.add(o);
    }
  }
  list = [...out].sort();
  hit.map.set(n, list);
  return list;
}

/** Provinces d'origine de `n` désormais tenues par `by`. */
export function lostTo(state: EngineState, n: NationId, by: NationId): number {
  let c = 0;
  for (const pid of wi(state.world).provsByNation.get(n) ?? [])
    if (state.provinces[pid]?.owner === by) c++;
  return c;
}
