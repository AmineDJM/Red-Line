import { callHook } from '../modules/registry.js';
import {
  distanceKm,
  MINUTE,
  type Category,
  type LngLat,
  type NationId,
  type Order,
  type ProvinceId,
  type WeaponSystem,
} from '@redline/shared';
import {
  atWar,
  nationUnits,
  provincesOf,
  schedule,
  sortedKeys,
  sysOf,
  unitPosAt,
  warsOf,
} from '../state/access.js';
import type { EngineState, Unit } from '../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../state/world.js';
import { ownCityWithin } from '../state/cities.js';
import { applyOrderImpl } from '../orders/orders.js';
import { canAfford } from '../economy/economy.js';
import { planUnitMove } from '../movement/plan-unit.js';
import { crossingHits } from '../movement/movement.js';
import { nextInt } from '../rng/rng.js';
import { hasPassage } from '../state/war.js';
import { neighborNations } from './estimate.js';
import {
  STRATEGY,
  captureFailures,
  forgetNation,
  isHot,
  reactiveThink,
  strategicThink,
  thinkContext,
} from './strategy.js';
import { ds, pairKey } from '../modules/diplo/state.js';

/**
 * IA tactique (phase 1, complétée) : règles et priorités, sans LLM. La couche stratégique
 * (guerres, paix, alliances, Conseil, procuration) est dans strategy.ts. Elle ne triche pas : ses décisions ne reposent que
 * sur ce que la nation a le droit de voir (ses unités, ses contacts, la carte politique publique)
 * et elle agit exclusivement par `applyOrder`.
 *
 *  - toutes : défendre le territoire (attaquer les ennemis vus chez soi), produire des défenses ;
 *  - 'normal' (et garnisons neutres) : contre-attaquer les provinces perdues voisines ;
 *  - 'hard' : attaquer aussi les provinces voisines faibles d'un ennemi en guerre ;
 *  - 'normal' : idem, mais seulement contre les nations à qui elle a elle-même déclaré la guerre.
 */

/** Réglages de comportement de l'IA (heuristiques, pas de l'équilibrage de jeu). */
const AI = {
  /** Catégories produites pour la défense. */
  defensive: ['infantry', 'tank', 'ifv', 'air_defense', 'artillery'] as Category[],
  /** Distance maximale d'intervention défensive (km). */
  defendReachKm: 1500,
  /** Nombre d'unités d'armée maximal en paix, par province possédée (plus une base). */
  peaceUnitsPerProvince: 0.5,
  peaceUnitsBase: 2,
  /** Plafond d'unités en guerre. */
  warUnitsPerProvince: 1.5,
  warUnitsBase: 6,
  /** Productions simultanées maximales (paix / guerre). */
  maxQueuePeace: 1,
  maxQueueWar: 2,
  /** En paix, on ne produit que si l'argent couvre ce multiple du coût. */
  peaceReserveFactor: 2,
  /** Contre-attaques / offensives lancées par réflexion. */
  maxCounterPerThink: 2,
  maxOffensivePerThink: 1,
  /** Tentatives de capture (calculs de trajet) par réflexion, réussies ou non. */
  maxCaptureAttemptsPerThink: 4,
  /** Délai avant de retenter une capture sans chemin praticable (heures de jeu). */
  captureRetryHours: 6,
};

/**
 * Réflexion des IA : toutes les nations non tenues par un joueur (jusqu'à ~200). Budget de calcul
 * maîtrisé : les nations proches d'un conflit (guerre, voisin en guerre, affaire diplomatique en attente)
 * réfléchissent à chaque période ; les autres, éloignées de tout conflit, sont étalées dans le temps
 * (une réflexion tactique simplifiée toutes les `tacticalEveryCalm` périodes, décalée par nation).
 * La réflexion stratégique (diplomatie) est espacée de la même façon.
 */
export function handleAiThink(state: EngineState): void {
  const period = state.world.balance.time.aiThinkMinutes * MINUTE;
  const tick = Math.round(state.time / period);
  const ids = state.nationIds;
  const ctx = thinkContext(state);
  for (let i = 0; i < ids.length; i++) {
    const n = ids[i]!;
    const ns = state.nations[n]!;
    if (!ns.isAi) {
      forgetNation(state, n);
      continue;
    }
    if (!ns.alive || state.winner) continue;
    const neighbors = neighborNations(state, n);
    const hot = isHot(state, n, neighbors, ctx);
    reactiveThink(state, n, ctx);
    if (state.winner) return;
    const every = hot ? STRATEGY.strategicEveryHot : STRATEGY.strategicEveryCalm;
    if ((tick + i) % every === 0) strategicThink(state, n, neighbors);
    if (hot || (tick + i) % STRATEGY.tacticalEveryCalm === 0) {
      think(state, n);
      callHook('aiThink', state, n);
    }
  }
  schedule(state, {
    k: 'ai',
    t: state.time + period,
  });
}

interface Threat {
  id: string;
  owner: NationId;
  pos: LngLat;
  /** Système connu (niveau identifié ou mieux), sinon null. */
  sys: WeaponSystem | null;
}

function canMove(s: WeaponSystem): boolean {
  return s.movement !== 'static' && s.speedKmh > 0;
}

function order(state: EngineState, n: NationId, o: Order): boolean {
  return applyOrderImpl(state, n, o).ok;
}

/**
 * Le trajet vers ce point traverserait-il une nation avec qui on n'est pas en guerre ? (l'IA évite
 * d'ouvrir un nouveau front par inadvertance ; même calcul que le moteur, à partir de sa propre unité).
 */
function violatesNeutral(state: EngineState, n: NationId, u: Unit, to: LngLat): boolean {
  const plan = planUnitMove(state, u, to);
  if ('error' in plan) return true;
  const start = unitPosAt(state, u, state.time);
  return crossingHits(state, start, plan.legs, (p) => {
    const owner = state.provinces[p]?.owner;
    return !!owner && owner !== n && !atWar(state, n, owner) && !hasPassage(state, n, owner);
  });
}

function think(state: EngineState, n: NationId): void {
  const enemies = warsOf(state, n);
  if (enemies.length === 0) {
    produce(state, n, true);
    return;
  }
  const ns = state.nations[n]!;
  const w = wi(state.world);
  const myUnits = nationUnits(state, n).map((id) => state.units[id]!);
  const idle = new Set(
    myUnits.filter((u) => !u.move && !u.target && canMove(sysOf(state, u))).map((u) => u.id),
  );
  const threats = perceive(state, n);

  // 1. Défense : ennemis vus sur notre territoire ou près de nos villes.
  const targeted = new Set(myUnits.map((u) => u.target).filter((t): t is string => !!t));
  const provDet = state.world.balance.sensors.provinceDetectionKm;
  for (const th of threats) {
    if (targeted.has(th.id)) continue;
    const inside = ownerAt(state, th.pos) === n || ownCityWithin(state, n, th.pos, provDet);
    if (!inside) continue;
    // Distances calculées une fois (mêmes valeurs que dans le comparateur d'origine).
    const dOf = new Map<string, number>();
    const cand = [...idle]
      .sort()
      .map((id) => state.units[id]!)
      .filter((u) => {
        const s = sysOf(state, u);
        if (th.sys && s.damage[th.sys.targetClass] <= 0) return false;
        const d = dist(state, u, th.pos);
        dOf.set(u.id, d);
        return d <= AI.defendReachKm;
      })
      .sort((a, b) => dOf.get(a.id)! - dOf.get(b.id)! || (a.id < b.id ? -1 : 1));
    for (const u of cand.slice(0, 4)) {
      if (violatesNeutral(state, n, u, th.pos)) continue;
      if (order(state, n, { kind: 'attack', unitIds: [u.id], targetId: th.id })) {
        idle.delete(u.id);
        targeted.add(th.id);
        break;
      }
    }
  }

  // 2. Contre-attaque : provinces d'origine perdues, voisines d'une province possédée.
  const budget: CaptureBudget = {
    left: AI.maxCaptureAttemptsPerThink,
    failed: captureFailures(state, n),
  };
  if (ns.aiLevel !== 'easy') {
    let launched = 0;
    for (const pid of w.provsByNation.get(n) ?? []) {
      if (launched >= AI.maxCounterPerThink) break;
      const P = state.provinces[pid];
      if (!P || P.owner === n || !atWar(state, n, P.owner)) continue;
      if (!bordersOwned(state, n, pid)) continue;
      if (launchCapture(state, n, pid, idle, myUnits, budget)) launched++;
    }
  }

  // 3. Offensive : 'hard' contre tout ennemi ; 'normal' contre les nations à qui elle a déclaré la guerre.
  const started = new Set(
    ds(state) ? enemies.filter((e) => ds(state).aggressor[pairKey(n, e)] === n) : [],
  );
  if (ns.aiLevel === 'hard' || (ns.aiLevel === 'normal' && started.size > 0)) {
    let launched = 0;
    const seen = new Set<ProvinceId>();
    let threatById: Map<string, Threat> | undefined;
    for (const own of provincesOf(state, n)) {
      if (launched >= AI.maxOffensivePerThink) break;
      for (const pid of sortedNeighbors(state, own)) {
        if (launched >= AI.maxOffensivePerThink || seen.has(pid)) continue;
        seen.add(pid);
        const P = state.provinces[pid];
        if (!P || P.owner === n || !atWar(state, n, P.owner)) continue;
        if (ns.aiLevel !== 'hard' && !started.has(P.owner)) continue;
        threatById ??= new Map(threats.map((t) => [t.id, t]));
        if (!isWeak(state, n, pid, threatById)) continue;
        const capturers = [...idle].filter((id) => sysOf(state, state.units[id]!).canCapture);
        if (capturers.length < 2) continue; // garder une réserve
        if (launchCapture(state, n, pid, idle, myUnits, budget)) launched++;
      }
    }
  }

  produce(state, n, false);
}

function dist(state: EngineState, u: Unit, p: LngLat): number {
  return distanceKm(unitPosAt(state, u, state.time), p);
}

/** Contacts ennemis (nations en guerre) actuellement observés, tels que la vue les donne. */
function perceive(state: EngineState, n: NationId): Threat[] {
  const out: Threat[] = [];
  const known = state.know[n];
  if (!known) return out;
  for (const id of sortedKeys(known)) {
    const c = known[id]!;
    const u = state.units[id];
    if (!c.seen || !u || !atWar(state, n, c.owner)) continue;
    out.push({
      id,
      owner: c.owner,
      pos: unitPosAt(state, u, state.time),
      sys: c.lvl >= 2 ? sysOf(state, u) : null,
    });
  }
  return out;
}

function ownerAt(state: EngineState, p: LngLat): NationId | null {
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellOfPos(p));
  return pid ? (state.provinces[pid]?.owner ?? null) : null;
}

function bordersOwned(state: EngineState, n: NationId, pid: ProvinceId): boolean {
  const def = wi(state.world).provById.get(pid);
  return !!def?.neighbors.some((x) => state.provinces[x]?.owner === n);
}

/** Aucune unité terrestre hostile connue près de la ville. */
function isWeak(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  threats: Map<string, Threat>,
): boolean {
  const city = wi(state.world).provById.get(pid)!.cityPoint;
  const radius = state.world.balance.combat.groundContactKm * 3;
  const known = state.know[n] ?? {};
  // « Existe-t-il un contact proche ? » : l'ordre de parcours est sans effet (pas de tri).
  for (const id in known) {
    const c = known[id]!;
    if (!atWar(state, n, c.owner)) continue;
    const th = threats.get(id);
    const pos = th ? th.pos : c.pos;
    if (distanceKm(pos, city) <= radius) return false;
  }
  return true;
}

interface CaptureBudget {
  left: number;
  failed: Record<string, number>;
}

/** Envoie l'unité de capture libre la plus proche vers la ville, si personne n'y va déjà. */
function launchCapture(
  state: EngineState,
  n: NationId,
  pid: ProvinceId,
  idle: Set<string>,
  myUnits: Unit[],
  budget: CaptureBudget,
): boolean {
  if (budget.left <= 0 || (budget.failed[pid] ?? 0) > state.time) return false;
  const city = wi(state.world).provById.get(pid)!.cityPoint;
  const already = myUnits.some((u) => {
    const legs = u.move?.legs;
    const dest = legs ? legs[legs.length - 1]!.to : u.pos;
    return distanceKm(dest, city) <= CAPTURE_RADIUS_KM;
  });
  if (already) return false;
  const dOf = new Map<string, number>();
  const cand = [...idle]
    .sort()
    .map((id) => state.units[id]!)
    .filter((u) => {
      const s = sysOf(state, u);
      if (!(s.canCapture && s.movement === 'land')) return false;
      dOf.set(u.id, dist(state, u, city));
      return true;
    })
    .sort((a, b) => dOf.get(a.id)! - dOf.get(b.id)! || (a.id < b.id ? -1 : 1));
  if (cand.length === 0) return false;
  budget.left--;
  for (const u of cand.slice(0, 3)) {
    if (violatesNeutral(state, n, u, city)) continue;
    if (order(state, n, { kind: 'move', unitIds: [u.id], to: city })) {
      idle.delete(u.id);
      return true;
    }
  }
  budget.failed[pid] = state.time + AI.captureRetryHours * 3_600_000;
  return false;
}

/** Valeur défensive par coût d'un système (statique). */
function defensiveValue(s: WeaponSystem): number {
  const dmg = Object.values(s.damage).reduce((a, b) => a + b, 0);
  return (s.hp * s.unitSize * (1 + s.armor) + dmg * s.unitSize) / Math.max(1, s.cost.money);
}

/** Systèmes produits pour la défense, triés par valeur décroissante puis identifiant (par monde). */
const defensiveCache = new WeakMap<object, WeaponSystem[]>();

function defensiveCatalog(state: EngineState): WeaponSystem[] {
  let list = defensiveCache.get(state.world);
  if (!list) {
    list = [];
    for (const id of wi(state.world).systemIds) {
      const s = state.world.catalog.get(id)!;
      if (!s.enabled || !AI.defensive.includes(s.category)) continue;
      if (s.movement === 'sea') continue;
      list.push(s);
    }
    const value = new Map(list.map((s) => [s.id, defensiveValue(s)]));
    list.sort((a, b) => value.get(b.id)! - value.get(a.id)! || (a.id < b.id ? -1 : 1));
    defensiveCache.set(state.world, list);
  }
  return list;
}

/** Voisins d'une province, triés (carte statique, par monde). */
const neighborCache = new WeakMap<object, Map<ProvinceId, ProvinceId[]>>();

function sortedNeighbors(state: EngineState, pid: ProvinceId): ProvinceId[] {
  let m = neighborCache.get(state.world);
  if (!m) neighborCache.set(state.world, (m = new Map()));
  let list = m.get(pid);
  if (!list) m.set(pid, (list = [...(wi(state.world).provById.get(pid)?.neighbors ?? [])].sort()));
  return list;
}

/** Production défensive quand l'argent le permet. */
function produce(state: EngineState, n: NationId, peaceful: boolean): void {
  const ns = state.nations[n]!;
  if (ns.production.length >= (peaceful ? AI.maxQueuePeace : AI.maxQueueWar)) return;
  const maxUnits = peaceful
    ? AI.peaceUnitsBase + AI.peaceUnitsPerProvince * ns.provinceCount
    : AI.warUnitsBase + AI.warUnitsPerProvince * ns.provinceCount;
  if ((state.rt.byNation.get(n)?.size ?? 0) + ns.production.length >= maxUnits) return;
  const w = wi(state.world);
  // Valeur défensive par coût, puis tirage parmi les trois meilleures : la liste triée (statique) est
  // parcourue jusqu'aux trois premières options abordables (même résultat que trier les abordables).
  const options: WeaponSystem[] = [];
  for (const s of defensiveCatalog(state)) {
    if (!canAfford(state, n, s)) continue;
    if (peaceful && ns.money < s.cost.money * AI.peaceReserveFactor) continue;
    options.push(s);
    if (options.length >= 3) break;
  }
  if (options.length === 0) return;
  const pick = options[nextInt(state.rng, Math.min(3, options.length))]!;
  const cap = w.nationById.get(n)?.capitalProvinceId;
  let where: ProvinceId | null = cap && state.provinces[cap]?.owner === n ? cap : null;
  if (!where) where = provincesOf(state, n)[0] ?? null;
  if (!where) return;
  order(state, n, { kind: 'produce', provinceId: where, systemId: pick.id });
}
