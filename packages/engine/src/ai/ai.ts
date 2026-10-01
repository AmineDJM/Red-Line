import { callHook } from '../modules/registry.js';
import {
  distanceKm,
  HOUR,
  MINUTE,
  type AiLevelBalance,
  type Category,
  type Leg,
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
import { citiesNear, ownCityWithin } from '../state/cities.js';
import { planUnitMove } from '../movement/plan-unit.js';
import { crossingHits } from '../movement/movement.js';
import { nextInt } from '../rng/rng.js';
import { hasPassage } from '../state/war.js';
import { targetClassOf, weaponRange } from '../encounters/profile.js';
import {
  contactValue,
  elementValue,
  neighborNations,
  ownForce,
  seaLinks,
  type OwnForce,
} from './estimate.js';
import { board } from '../modules/kit.js';
import {
  capitalThreat,
  captureFailures,
  clearOperations,
  commitments,
  forgetNation,
  isHot,
  operations,
  reactiveThink,
  strategicThink,
  thinkContext,
  warGoalReached,
  warPlanOf,
  type Operation,
} from './strategy.js';
import { ds, pairKey } from '../modules/diplo/state.js';
import { aiOrder } from './trace.js';
import { aiCfg, aiLevelCfg } from './config.js';
import { aiReserve } from './money.js';
import { aiUnitPrice } from '../modules/eco/ai.js';
import { localCheck } from '../modules/eco/production.js';
import { provinceProductionSpeed } from '../modules/eco/buildings.js';
import { requiredBuildings } from '../modules/eco/config.js';
import { eco } from '../modules/eco/state.js';
import type { AiBalance } from '@redline/shared';

/**
 * IA tactique : règles et priorités, sans LLM. La couche stratégique (guerres, paix, alliances,
 * Conseil, procuration) est dans strategy.ts ; les crochets aiThink des modules ajoutent l'aviation et
 * les missiles (mil), l'économie (eco) et le renseignement (intel). Elle ne triche pas : ses décisions
 * ne reposent que sur ce que la nation a le droit de voir (ses unités, ses contacts, la carte politique
 * publique, ses propres comptes) et elle agit exclusivement par des ordres, comme un joueur.
 *
 * En guerre, à chaque réflexion :
 *  1. points clés : garnison de la capitale (renforcée si l'ennemi s'en approche), renforts vers les
 *     villes menacées par des forces ennemies vues ;
 *  2. défense : les ennemis vus sur son sol sont attaqués par un groupe dimensionné à leur force ;
 *  3. contre-attaque : reprise des provinces perdues voisines (capitale d'abord) ;
 *  4. offensive : provinces ennemies voisines les plus rentables et les moins défendues, et (niveaux
 *     qui débarquent) provinces côtières ennemies accessibles seulement par la mer ;
 *  5. production adaptée aux forces ennemies observées, sans entamer la réserve de trésorerie, dans la
 *     province la mieux équipée et la plus proche du front (pas seulement la capitale).
 * Les attaques partent en groupe (concentration) et seulement si la force engagée dépasse la force
 * ennemie connue près de l'objectif (`attackRatio`) : pas d'unités envoyées seules au casse-pipe.
 * Un groupe dont les unités arriveraient trop étalées (vitesses, distances) se rassemble d'abord dans
 * une ville amie proche de l'objectif, puis part en bloc ; un débarquement se rassemble au port
 * d'embarquement et attend que ses navires d'escorte tiennent la zone (opérations, mémoire de l'IA).
 * En paix, une menace contre un joueur humain (strategy.ts) masse des troupes à la frontière.
 * Tous les réglages sont dans data/balance (section ai, niveaux easy / normal / hard).
 */

/** Catégories produites pour l'armée de terre. */
const LAND_CATEGORIES: Category[] = ['infantry', 'tank', 'ifv', 'artillery', 'air_defense'];

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
  const st = aiCfg(state.world).strategy;
  const ids = state.nationIds;
  const ctx = thinkContext(state);
  const awake = awakeNations(state);
  for (let i = 0; i < ids.length; i++) {
    const n = ids[i]!;
    const ns = state.nations[n]!;
    if (!ns.isAi) {
      forgetNation(state, n);
      continue;
    }
    if (!ns.alive || state.winner) continue;
    if (awake && !awake.has(n)) continue;
    const neighbors = neighborNations(state, n);
    const hot = isHot(state, n, neighbors, ctx);
    reactiveThink(state, n, ctx);
    if (state.winner) return;
    const every = hot ? st.strategicEveryHot : st.strategicEveryCalm;
    if ((tick + i) % every === 0) strategicThink(state, n, neighbors, hot);
    if (hot || (tick + i) % st.tacticalEveryCalm === 0) {
      think(state, n);
      callHook('aiThink', state, n);
    }
  }
  schedule(state, {
    k: 'ai',
    t: state.time + period,
  });
}

/**
 * Veille des IA lointaines (aucun joueur humain connecté, drapeau `dormancy` posé par le serveur) :
 * seules réfléchissent les IA en guerre avec un joueur humain ou dont une ville est à moins de
 * `dormancyRadiusKm` d'une ville d'un joueur humain. null = pas de veille, toutes réfléchissent.
 */
export function awakeNations(state: EngineState): Set<NationId> | null {
  if (!board(state).dormancy) return null;
  const radius = state.world.balance.time.dormancyRadiusKm ?? DEFAULT_DORMANCY_RADIUS_KM;
  const humans = state.nationIds.filter((n) => {
    const ns = state.nations[n]!;
    return ns.isPlayer && ns.alive;
  });
  if (humans.length === 0) return null;
  const awake = new Set<NationId>();
  for (const n of state.nationIds) {
    if (humans.some((h) => h !== n && atWar(state, n, h))) awake.add(n);
  }
  const provById = wi(state.world).provById;
  const humanPts: LngLat[] = [];
  const others: { owner: NationId; at: LngLat }[] = [];
  const humanSet = new Set(humans);
  for (const pid of Object.keys(state.provinces)) {
    const owner = state.provinces[pid]!.owner;
    const def = provById.get(pid);
    if (!owner || !def) continue;
    if (humanSet.has(owner)) humanPts.push(def.cityPoint);
    else others.push({ owner, at: def.cityPoint });
  }
  for (const o of others) {
    if (awake.has(o.owner)) continue;
    for (const h of humanPts) {
      if (distanceKm(o.at, h) <= radius) {
        awake.add(o.owner);
        break;
      }
    }
  }
  return awake;
}

const DEFAULT_DORMANCY_RADIUS_KM = 2000;

/** Une de ses unités mobiles, avec sa position et sa valeur (prix × effectif × santé). */
interface Mine {
  u: Unit;
  s: WeaponSystem;
  pos: LngLat;
  value: number;
  /** Arme à portée (tir possible). */
  armed: boolean;
  /** Peut combattre des forces terrestres (dégâts contre infanterie ou blindés, arme à portée). */
  ground: boolean;
}

/** Contact ennemi connu (vu, ou perdu de vue récemment), tel que la vue le donne. */
interface Seen {
  id: string;
  pos: LngLat;
  /** Système connu (niveau identifié ou mieux), sinon null. */
  sys: WeaponSystem | null;
  value: number;
  seen: boolean;
  /** Milieu connu ('land' | 'sea' | 'air'), null si non identifié. */
  medium: string | null;
}

interface Ctx {
  state: EngineState;
  n: NationId;
  L: AiLevelBalance;
  T: AiBalance['tactical'];
  mine: OwnForce;
  /** Unités terrestres et navires mobiles (ordre des identifiants). */
  land: Mine[];
  sea: Mine[];
  /** Libres : ni trajet, ni cible, ni réservées. */
  idle: Set<string>;
  /** Gardées sur place (garnisons des points clés). */
  reserved: Set<string>;
  paths: number;
  failed: Record<string, number>;
  /** Unités engagées dans une offensive : unité → [province visée, jusqu'à]. */
  commit: Record<string, [string, number]>;
  enemies: Seen[];
  /** Force ennemie connue menaçant chacune de ses villes (rayon threatRadiusKm). */
  threat: Map<ProvinceId, number>;
  /** Force ennemie connue tenant une ville étrangère (rayon cityRadiusKm). */
  hold: Map<ProvinceId, number>;
  /** Villes déjà visées par ses unités en route. */
  aimed: Set<ProvinceId>;
  /** Capitale menacée : survie d'abord (production sans réserve). */
  critical: boolean;
  /** Garnison de la capitale incomplète (production à la capitale). */
  capShort: boolean;
  /** Opérations en cours (rassemblement, débarquement) et unité → province visée. */
  ops: Record<ProvinceId, Operation>;
  opUnits: Map<string, ProvinceId>;
  byId: Map<string, Mine>;
}

function order(state: EngineState, n: NationId, o: Order): boolean {
  return aiOrder(state, n, o).ok;
}

/**
 * Le trajet vers ce point traverserait-il une nation avec qui on n'est pas en guerre ? (l'IA évite
 * d'ouvrir un nouveau front par inadvertance ; même calcul que le moteur, à partir de sa propre unité).
 */
function safeLegs(state: EngineState, n: NationId, u: Unit, to: LngLat): Leg[] | null {
  const plan = planUnitMove(state, u, to);
  if ('error' in plan) return null;
  const start = unitPosAt(state, u, state.time);
  const bad = crossingHits(state, start, plan.legs, (p) => {
    const owner = state.provinces[p]?.owner;
    return !!owner && owner !== n && !atWar(state, n, owner) && !hasPassage(state, n, owner);
  });
  return bad ? null : plan.legs;
}

/** Chemin praticable sans violer un neutre (consomme le budget de calcul de la réflexion). */
function pathOk(ctx: Ctx, m: Mine, to: LngLat): boolean {
  return pathLegs(ctx, m, to) !== null;
}

/** Trajet praticable sans violer un neutre (budget de calcul), sinon null. */
function pathLegs(ctx: Ctx, m: Mine, to: LngLat): Leg[] | null {
  ctx.paths--;
  return safeLegs(ctx.state, ctx.n, m.u, to);
}

function think(state: EngineState, n: NationId): void {
  const enemies = warsOf(state, n);
  if (enemies.length === 0) {
    const plan = warPlanOf(state, n);
    clearOperations(state, n);
    if (plan) {
      // Menace contre un joueur : troupes massées à la frontière (visibles de son renseignement).
      const ctx = context(state, n);
      stage(ctx, plan.t);
      produce(state, n, true, ctx);
      return;
    }
    produce(state, n, true, null);
    return;
  }
  const ctx = context(state, n);
  holdKeyPoints(ctx);
  defend(ctx);
  runOps(ctx);
  if (ctx.L.counterattack) counterattack(ctx);
  const off = ctx.L.offensive;
  if (off !== 'none') {
    // Guerres qu'elle a déclarées et dont le but n'est pas atteint (guerre limitée : au-delà, elle
    // défend ses gains et attend la paix).
    const started = ds(state)
      ? enemies.filter(
          (e) => ds(state).aggressor[pairKey(n, e)] === n && !warGoalReached(state, n, e),
        )
      : [];
    if (off === 'all' || started.length > 0)
      offensive(ctx, off === 'all' ? null : new Set(started));
  }
  produce(state, n, false, ctx);
}

/** Ce que la nation sait d'elle-même et de ses ennemis, calculé une fois par réflexion. */
function context(state: EngineState, n: NationId): Ctx {
  const ns = state.nations[n]!;
  const L = aiLevelCfg(state, ns.aiLevel);
  const T = aiCfg(state.world).tactical;
  const mine = ownForce(state, n);
  const land: Mine[] = [];
  const sea: Mine[] = [];
  const idle = new Set<string>();
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    if (u.off || u.role) continue;
    const s = sysOf(state, u);
    if (s.speedKmh <= 0 || (s.movement !== 'land' && s.movement !== 'sea')) continue;
    const hp = u.hp / Math.max(1, u.maxHp);
    const armed = weaponRange(state, u).max > 0;
    const m: Mine = {
      u,
      s,
      pos: unitPosAt(state, u, state.time),
      value: elementValue(state, u.sys) * u.count * hp,
      armed,
      ground: armed && (s.damage.infantry > 0 || s.damage.armor > 0),
    };
    (s.movement === 'land' ? land : sea).push(m);
  }
  land.sort((a, b) => (a.u.id < b.u.id ? -1 : 1));
  sea.sort((a, b) => (a.u.id < b.u.id ? -1 : 1));
  for (const m of [...land, ...sea]) if (!m.u.move && !m.u.target) idle.add(m.u.id);
  const byId = new Map<string, Mine>();
  for (const m of land) byId.set(m.u.id, m);
  for (const m of sea) byId.set(m.u.id, m);
  // Unités des opérations en cours : ni libres ni réservées (seule la capitale peut les rappeler).
  const ops = operations(state, n);
  const opUnits = new Map<string, ProvinceId>();
  for (const pid of sortedKeys(ops)) {
    const op = ops[pid]!;
    op.units = op.units.filter((id) => byId.has(id) && !opUnits.has(id));
    if (op.sea) op.sea = op.sea.filter((id) => byId.has(id));
    for (const id of op.units) {
      opUnits.set(id, pid);
      idle.delete(id);
    }
  }
  const ctx: Ctx = {
    state,
    n,
    L,
    T,
    mine,
    land,
    sea,
    idle,
    reserved: new Set(),
    paths: L.pathBudget,
    failed: captureFailures(state, n),
    commit: commitments(state, n),
    enemies: [],
    threat: new Map(),
    hold: new Map(),
    aimed: new Set(),
    critical: false,
    capShort: false,
    ops,
    opUnits,
    byId,
  };
  for (const pid of sortedKeys(ops)) ctx.aimed.add(pid);
  picture(ctx);
  // Villes déjà visées : destinations de ses unités terrestres en route hors de chez elle.
  for (const m of land) {
    const legs = m.u.move?.legs;
    if (!legs) continue;
    const dest = legs[legs.length - 1]!.to;
    for (const c of citiesNear(state.world, dest, CAPTURE_RADIUS_KM)) ctx.aimed.add(c.pid);
  }
  return ctx;
}

/** Contacts ennemis connus et carte des menaces (forces terrestres près des villes). */
function picture(ctx: Ctx): void {
  const { state, n, T } = ctx;
  const known = state.know[n];
  if (!known) return;
  const memory = T.contactMemoryHours * 3_600_000;
  const cat = state.world.catalog;
  const nav = wi(state.world).nav;
  for (const id of sortedKeys(known)) {
    const c = known[id]!;
    if (!atWar(state, n, c.owner)) continue;
    const u = state.units[id];
    if (!u || u.off || u.role === 'missile') continue;
    if (!c.seen && state.time - c.lastSeen > memory) continue;
    const sys = c.lvl >= 2 && c.sys ? (cat.get(c.sys) ?? null) : null;
    const pos = c.seen ? unitPosAt(state, u, state.time) : c.pos;
    const value = contactValue(state, c, ctx.mine);
    const medium = sys ? sys.movement : null;
    ctx.enemies.push({ id, pos, sys, value, seen: c.seen, medium });
    // Force terrestre (ou non identifiée) : menace pour les villes proches. Le grand rayon de menace
    // n'est utile que près de chez soi (province du contact à elle ou voisine d'une des siennes).
    if (medium === 'air' || medium === 'sea' || medium === 'static') continue;
    const pid = nav.cellProv.get(nav.cellOfPos(pos));
    const near0 = !!pid && (state.provinces[pid]?.owner === n || bordersOwned(state, n, pid));
    for (const near of citiesNear(state.world, pos, near0 ? T.threatRadiusKm : T.cityRadiusKm)) {
      const owner = state.provinces[near.pid]?.owner;
      if (owner === n) ctx.threat.set(near.pid, (ctx.threat.get(near.pid) ?? 0) + value);
      else if (near.d <= T.cityRadiusKm)
        ctx.hold.set(near.pid, (ctx.hold.get(near.pid) ?? 0) + value);
    }
  }
}

function cityPoint(state: EngineState, pid: ProvinceId): LngLat {
  return wi(state.world).provById.get(pid)!.cityPoint;
}

function capitalOf(state: EngineState, n: NationId): ProvinceId | null {
  return wi(state.world).nationById.get(n)?.capitalProvinceId ?? null;
}

/** Destination (fin de trajet) ou position d'une unité. */
function destOf(m: Mine): LngLat {
  const legs = m.u.move?.legs;
  return legs ? legs[legs.length - 1]!.to : m.pos;
}

/**
 * Garde une ville : réserve les unités terrestres présentes (ou en route), puis fait venir les plus
 * proches unités libres jusqu'à `count` unités et `value` de force. Renvoie le nombre d'unités
 * obtenues (présentes, en route ou envoyées).
 */
function garrison(
  ctx: Ctx,
  pid: ProvinceId,
  count: number,
  value: number,
  minShare: number,
  recall = false,
  reach = ctx.T.reinforceReachKm,
): number {
  const { state } = ctx;
  const at = cityPoint(state, pid);
  const gc = state.world.balance.combat.groundContactKm;
  let have = 0;
  let force = 0;
  const present = ctx.land
    .filter((m) => distanceKm(destOf(m), at) <= gc)
    .map((m) => ({ m, d: Math.round(distanceKm(m.pos, at)) }))
    // Les plus proches d'abord ; à égalité, les plus lentes gardent la ville (les rapides attaquent).
    .sort((a, b) => a.d - b.d || a.m.s.speedKmh - b.m.s.speedKmh || (a.m.u.id < b.m.u.id ? -1 : 1));
  // Hystérésis : les défenseurs présents restent avec une marge (pas de va-et-vient entre la ville et
  // le front quand la menace vue fluctue d'une réflexion à l'autre).
  for (const { m } of present) {
    if (have >= count && force >= value * KEEP_MARGIN) break;
    ctx.reserved.add(m.u.id);
    ctx.idle.delete(m.u.id);
    have++;
    force += m.value;
  }
  if (have >= count && force >= value) return have;
  // Unités engagées dans une offensive : rappelées seulement pour la capitale (`recall`).
  const cands = ctx.land
    .filter(
      (m) =>
        (ctx.idle.has(m.u.id) || (recall && ctx.opUnits.has(m.u.id))) &&
        m.ground &&
        (recall || !ctx.commit[m.u.id]),
    )
    .map((m) => ({ m, d: distanceKm(m.pos, at) }))
    .filter((x) => x.d <= reach)
    .sort((a, b) => a.d - b.d || (a.m.u.id < b.m.u.id ? -1 : 1));
  // Inutile d'envoyer des renforts qui ne suffiraient pas (ils seraient détruits un à un).
  const available = cands.slice(0, ctx.L.groupMax).reduce((a, x) => a + x.m.value, 0);
  if (value > 0 && force + available < value * minShare) return have;
  const group: Mine[] = [];
  const nav = wi(state.world).nav;
  for (const { m } of cands) {
    if ((have >= count && force >= value) || group.length >= ctx.L.groupMax) break;
    if (ctx.paths <= 0) break;
    // Une unité arrêtée en territoire ennemi tient ce qu'elle a pris : on ne la rappelle pas.
    const here = nav.cellProv.get(nav.cellOfPos(m.pos));
    if (here && state.provinces[here]?.owner !== ctx.n) continue;
    if (!pathOk(ctx, m, at)) continue;
    group.push(m);
    have++;
    force += m.value;
  }
  if (group.length === 0) return have;
  if (order(state, ctx.n, { kind: 'move', unitIds: group.map((m) => m.u.id), to: at })) {
    for (const m of group) {
      ctx.idle.delete(m.u.id);
      ctx.reserved.add(m.u.id);
    }
    return have;
  }
  return have - group.length;
}

/** Marge des défenseurs gardés sur place au-delà de la force jugée nécessaire. */
const KEEP_MARGIN = 1.5;

/** 1. Points clés : la capitale, puis les villes menacées. */
function holdKeyPoints(ctx: Ctx): void {
  const { state, n, L } = ctx;
  const cap = capitalOf(state, n);
  if (cap && state.provinces[cap]?.owner === n) {
    const threat = capitalThreat(
      state,
      n,
      ctx.threat.get(cap) ?? 0,
      ctx.T.contactMemoryHours * 3_600_000,
    );
    if (threat > 0) ctx.critical = true;
    const have = garrison(ctx, cap, L.capitalGarrison, threat * L.attackRatio, 0, true);
    // Garnison incomplète : les prochaines unités sortent à la capitale.
    if (have < L.capitalGarrison) ctx.capShort = true;
  }
  if (!L.defendCities) return;
  const cities = [...ctx.threat]
    .filter(([pid]) => pid !== cap)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, ctx.T.maxReinforcePerThink);
  // Le défenseur d'une ville a l'avantage (bonus de ville) : force égale à la menace, au moins 60 %.
  for (const [pid, threat] of cities) garrison(ctx, pid, 1, threat, 0.6);
}

/** 2. Défense : ennemis vus sur son territoire ou près de ses villes, attaqués par un groupe. */
function defend(ctx: Ctx): void {
  const { state, n, L } = ctx;
  const provDet = state.world.balance.sensors.provinceDetectionKm;
  const targeted = new Set<string>();
  for (const m of [...ctx.land, ...ctx.sea]) if (m.u.target) targeted.add(m.u.target);
  const nav = wi(state.world).nav;
  for (const th of ctx.enemies) {
    if (!th.seen || targeted.has(th.id) || th.medium === 'air') continue;
    const pid = nav.cellProv.get(nav.cellOfPos(th.pos));
    const inside =
      (!!pid && state.provinces[pid]?.owner === n) || ownCityWithin(state, n, th.pos, provDet);
    if (!inside) continue;
    // Milieu inconnu : sur terre si la position est dans une province, en mer sinon.
    const naval = th.medium === 'sea' || (th.medium === null && !pid);
    const pool = naval ? ctx.sea : ctx.land;
    // Classe de cible effective (munitions en stock, aéronef posé : installation), comme le moteur.
    const cls = th.sys ? targetClassOf(state, state.units[th.id]!) : null;
    const cands = pool
      .filter((m) => {
        if (!ctx.idle.has(m.u.id) || !m.armed) return false;
        if (cls) return m.s.damage[cls] > 0;
        return naval ? m.s.damage.ship > 0 : m.ground;
      })
      .map((m) => ({ m, d: distanceKm(m.pos, th.pos) }))
      .filter((x) => x.d <= ctx.T.defendReachKm)
      .sort((a, b) => a.d - b.d || (a.m.u.id < b.m.u.id ? -1 : 1));
    if (cands.length === 0) continue;
    const need = th.value * L.attackRatio;
    const group: Mine[] = [];
    let force = 0;
    for (const { m } of cands) {
      if (force >= need || group.length >= L.groupMax || ctx.paths <= 0) break;
      if (!pathOk(ctx, m, th.pos)) continue;
      group.push(m);
      force += m.value;
    }
    // Trop faible pour l'emporter : on ne jette pas les unités une à une (la garnison tient la ville).
    if (group.length === 0 || force < th.value * 0.75) continue;
    if (order(state, n, { kind: 'attack', unitIds: group.map((m) => m.u.id), targetId: th.id })) {
      for (const m of group) ctx.idle.delete(m.u.id);
      targeted.add(th.id);
    }
    if (ctx.paths <= 0) return;
  }
}

/**
 * Envoie un groupe prendre une ville : les unités libres les plus proches (dont au moins une capable de
 * capturer), jusqu'à dépasser `need` de force. Rien n'est lancé si la force réunie ne suffit pas.
 * `from` : débarquement, port d'embarquement (les unités sont choisies près de lui). Si les heures
 * d'arrivée sont trop étalées, ou si le trajet passe par la mer, le groupe se rassemble d'abord
 * (opération) puis part en bloc.
 */
function launchGroup(
  ctx: Ctx,
  pid: ProvinceId,
  need: number,
  from: ProvinceId | null = null,
): boolean {
  const { state, n, L, T } = ctx;
  if (ctx.paths <= 0 || (ctx.failed[pid] ?? 0) > state.time || ctx.aimed.has(pid)) return false;
  const city = cityPoint(state, pid);
  const origin = from ? cityPoint(state, from) : city;
  const reach = from ? T.reinforceReachKm : T.attackReachKm;
  const cands = ctx.land
    .filter(
      (m) =>
        ctx.idle.has(m.u.id) &&
        (m.ground || m.s.canCapture) &&
        (!ctx.commit[m.u.id] || ctx.commit[m.u.id]![0] === pid),
    )
    .map((m) => ({ m, d: distanceKm(m.pos, origin) }))
    .filter((x) => x.d <= reach)
    .sort((a, b) => a.d - b.d || (a.m.u.id < b.m.u.id ? -1 : 1));
  if (!cands.some((x) => x.m.s.canCapture)) return false;
  const max = Math.max(1, L.groupMax);
  // Jamais seule : même une ville qui paraît vide peut cacher des défenseurs (brouillard de guerre).
  const minUnits = Math.min(2, max);
  // Faisabilité sans calcul de trajet : les `max` plus proches suffisent-elles ?
  if (cands.slice(0, max).reduce((a, x) => a + x.m.value, 0) < need) return false;
  const group: Mine[] = [];
  let force = 0;
  let capturer = false;
  let blocked = 0;
  let first = Infinity;
  let last = 0;
  let bySea = false;
  for (const { m } of cands) {
    if (force >= need && group.length >= minUnits && capturer) break;
    if (group.length >= max || ctx.paths <= 0) break;
    // Dernière place réservée à une unité capable de capturer.
    if (!capturer && !m.s.canCapture && group.length === max - 1) continue;
    const legs = pathLegs(ctx, m, city);
    if (!legs) {
      blocked++;
      continue;
    }
    const eta = legs.length ? legs[legs.length - 1]!.t1 - state.time : 0;
    first = Math.min(first, eta);
    last = Math.max(last, eta);
    bySea ||= legs.some((l) => l.medium === 'sea');
    group.push(m);
    force += m.value;
    capturer ||= m.s.canCapture;
  }
  if (!capturer || force < need || group.length < minUnits) {
    if (group.length === 0 && blocked > 0)
      ctx.failed[pid] = state.time + T.captureRetryHours * HOUR;
    return false;
  }
  // Débarquement : seulement les niveaux qui les pratiquent (sinon, unités sans défense en mer).
  if (bySea && !L.amphibious) return false;
  if (L.rally && group.length >= 2 && (bySea || last - first > T.rallySpreadHours * HOUR)) {
    if (startOp(ctx, pid, group, need, bySea)) return true;
    if (bySea) return false;
  }
  if (!order(state, n, { kind: 'move', unitIds: group.map((m) => m.u.id), to: city })) return false;
  const until = state.time + T.commitHours * HOUR;
  for (const m of group) {
    ctx.idle.delete(m.u.id);
    ctx.commit[m.u.id] = [pid, until];
  }
  ctx.aimed.add(pid);
  return true;
}

/**
 * Point de rassemblement d'une offensive : ville amie voisine de l'objectif la plus proche de lui (par
 * la terre) ou port d'embarquement le plus proche (débarquement).
 */
function rallyPoint(ctx: Ctx, pid: ProvinceId, bySea: boolean): LngLat | null {
  const { state, n } = ctx;
  const w = wi(state.world);
  const city = cityPoint(state, pid);
  let best: ProvinceId | null = null;
  let bestD = Infinity;
  const consider = (q: ProvinceId): void => {
    if (state.provinces[q]?.owner !== n || ctx.threat.has(q)) return;
    const d = distanceKm(cityPoint(state, q), city);
    if (d < bestD || (d === bestD && best !== null && q < best)) {
      best = q;
      bestD = d;
    }
  };
  if (bySea) {
    for (const q of seaLinks(state).get(pid) ?? []) consider(q);
  } else {
    for (const q of w.provById.get(pid)?.neighbors ?? []) consider(q);
  }
  if (!best) {
    for (const q of provincesOf(state, n)) {
      if (bySea && !w.seaSpawn.get(q)) continue;
      consider(q);
    }
  }
  return best ? cityPoint(state, best) : null;
}

/**
 * Lance une opération : les unités du groupe rejoignent le point de rassemblement ; un débarquement
 * envoie aussi ses navires d'escorte tenir la zone. Le départ vers l'objectif se fait dans runOps.
 */
function startOp(ctx: Ctx, pid: ProvinceId, group: Mine[], need: number, bySea: boolean): boolean {
  const { state, n, T } = ctx;
  const at = rallyPoint(ctx, pid, bySea);
  if (!at) return false;
  const units: Mine[] = [];
  const moving: Mine[] = [];
  let force = 0;
  let slowest = 0;
  for (const m of group) {
    const d = distanceKm(m.pos, at);
    if (d > T.rallyRadiusKm) {
      if (ctx.paths <= 0 || !pathOk(ctx, m, at)) continue;
      moving.push(m);
      // Durée approchée (détours compris) : borne l'attente au point de rassemblement.
      slowest = Math.max(slowest, ((d * 1.3) / Math.max(1, m.s.speedKmh)) * HOUR);
    }
    units.push(m);
    force += m.value;
  }
  if (units.length < 2 || force < need || !units.some((m) => m.s.canCapture)) return false;
  if (
    moving.length > 0 &&
    !order(state, n, { kind: 'move', unitIds: moving.map((m) => m.u.id), to: at })
  )
    return false;
  const op: Operation = {
    at: [at[0], at[1]],
    units: units.map((m) => m.u.id),
    need,
    until: state.time + Math.min(T.rallyMaxHours * HOUR, slowest + HOUR),
  };
  if (bySea) op.sea = escort(ctx, pid);
  ctx.ops[pid] = op;
  ctx.aimed.add(pid);
  const until = op.until + T.commitHours * HOUR;
  for (const m of units) {
    ctx.idle.delete(m.u.id);
    ctx.opUnits.set(m.u.id, pid);
    ctx.commit[m.u.id] = [pid, until];
  }
  for (const id of op.sea ?? []) ctx.opUnits.set(id, pid);
  return true;
}

/** Point de débarquement (en mer devant la province visée). */
function landingPoint(state: EngineState, pid: ProvinceId): LngLat {
  return wi(state.world).seaSpawn.get(pid) ?? cityPoint(state, pid);
}

/** Escorte d'un débarquement : navires de surface armés libres envoyés patrouiller sur la zone. */
function escort(ctx: Ctx, pid: ProvinceId): string[] {
  const { state, n, L } = ctx;
  if (L.escortShips <= 0) return [];
  const at = landingPoint(state, pid);
  const ships = ctx.sea
    .filter(
      (m) =>
        ctx.idle.has(m.u.id) &&
        m.armed &&
        m.s.category === 'surface_ship' &&
        !ctx.opUnits.has(m.u.id) &&
        distanceKm(m.pos, at) <= ESCORT_REACH_KM,
    )
    .map((m) => ({ m, d: distanceKm(m.pos, at) }))
    .sort((a, b) => a.d - b.d || (a.m.u.id < b.m.u.id ? -1 : 1))
    .slice(0, L.escortShips)
    .map((x) => x.m);
  // Route maritime vérifiée avant l'ordre (mer fermée, détroit) : pas d'ordre refusé.
  const ids = ships.filter((m) => !('error' in planUnitMove(state, m.u, at))).map((m) => m.u.id);
  if (ids.length === 0) return [];
  if (!order(state, n, { kind: 'patrol', unitIds: ids, at, radiusKm: ESCORT_RADIUS_KM })) return [];
  for (const id of ids) ctx.idle.delete(id);
  return ids;
}

const ESCORT_REACH_KM = 2500;
const ESCORT_RADIUS_KM = 60;

/** La traversée peut-elle partir ? Escorte sur zone, ou mer libre de navires ennemis connus. */
function seaReady(ctx: Ctx, pid: ProvinceId, op: Operation): boolean {
  const { state, T } = ctx;
  const at = landingPoint(state, pid);
  const escorts = (op.sea ?? []).map((id) => ctx.byId.get(id)).filter((m) => !!m);
  if (escorts.some((m) => distanceKm(m.pos, at) <= T.escortOnStationKm)) return true;
  const nav = wi(state.world).nav;
  const hostile = ctx.enemies.some((e) => {
    if (e.medium !== 'sea' && (e.medium !== null || nav.cellProv.get(nav.cellOfPos(e.pos))))
      return false;
    return distanceKm(e.pos, at) <= T.seaControlKm;
  });
  if (hostile) return false;
  // Mer libre : on attend un peu l'escorte en route, puis on traverse.
  return escorts.length === 0 || state.time >= op.until + (T.rallyMaxHours / 2) * HOUR;
}

/** Fin d'une opération : ses unités redeviennent libres. */
function release(ctx: Ctx, pid: ProvinceId): void {
  const op = ctx.ops[pid];
  if (!op) return;
  delete ctx.ops[pid];
  for (const id of [...op.units, ...(op.sea ?? [])]) {
    ctx.opUnits.delete(id);
    const m = ctx.byId.get(id);
    if (ctx.commit[id]?.[0] === pid) delete ctx.commit[id];
    if (m && !m.u.move && !m.u.target && !ctx.reserved.has(id)) ctx.idle.add(id);
  }
}

/**
 * Opérations en cours : quand toutes les unités sont au point de rassemblement (ou à l'échéance, avec
 * celles arrivées si elles suffisent), et pour un débarquement quand la zone est tenue, le groupe part
 * en bloc vers l'objectif. Objectif pris, perdu de vue ou force insuffisante : opération dissoute.
 */
function runOps(ctx: Ctx): void {
  const { state, n, T } = ctx;
  for (const pid of sortedKeys(ctx.ops)) {
    const op = ctx.ops[pid]!;
    const P = state.provinces[pid];
    // Unités prises pour défendre une ville (garnison) : retirées de l'opération.
    op.units = op.units.filter((id) => !ctx.reserved.has(id));
    if (!P || P.owner === n || !atWar(state, n, P.owner) || op.units.length === 0) {
      release(ctx, pid);
      continue;
    }
    if (op.go) {
      depart(ctx, pid, op);
      continue;
    }
    const all = op.units.map((id) => ctx.byId.get(id)!);
    const there = all.filter((m) => !m.u.move && distanceKm(m.pos, op.at) <= T.rallyRadiusKm);
    const late = state.time >= op.until;
    if (there.length < all.length && !late) continue;
    const force = there.reduce((a, m) => a + m.value, 0);
    // Force exigée revue au départ : l'ennemi a pu renforcer la ville entre-temps.
    const need = Math.max(op.need, needFor(ctx, pid, P.owner) * (op.sea ? T.amphibiousRatio : 1));
    if (force < need || there.length < 2 || !there.some((m) => m.s.canCapture)) {
      if (late || there.length === all.length) release(ctx, pid);
      continue;
    }
    if (op.sea && !seaReady(ctx, pid, op)) {
      if (state.time >= op.until + T.rallyMaxHours * HOUR) release(ctx, pid);
      continue;
    }
    if (ctx.paths <= 0) continue;
    const city = cityPoint(state, pid);
    if (!pathOk(ctx, there[0]!, city)) {
      ctx.failed[pid] = state.time + T.captureRetryHours * HOUR;
      release(ctx, pid);
      continue;
    }
    // Départs échelonnés : les plus lents d'abord, chacun à l'heure qui le fait arriver avec les
    // autres (durée estimée : distance avec détours, vitesse, embarquement).
    const seaF = op.sea ? state.world.balance.movement.embarkedSpeedFactor : 1;
    const eta = new Map<string, number>();
    for (const m of there)
      eta.set(
        m.u.id,
        ((distanceKm(m.pos, city) * DETOUR) / Math.max(1, m.s.speedKmh * seaF)) * HOUR,
      );
    const slowest = Math.max(...eta.values());
    op.go = {};
    for (const m of there) op.go[m.u.id] = state.time + slowest - eta.get(m.u.id)!;
    // Les unités arrivées en retard (hors du point) sont libérées.
    for (const m of all) {
      if (op.go[m.u.id] !== undefined) continue;
      ctx.opUnits.delete(m.u.id);
      if (ctx.commit[m.u.id]?.[0] === pid) delete ctx.commit[m.u.id];
    }
    op.units = there.map((m) => m.u.id);
    depart(ctx, pid, op);
  }
}

/** Détour moyen d'un trajet de surface par rapport au grand cercle (estimation des durées). */
const DETOUR = 1.15;

/** Départs dus d'une opération lancée (à une demi-réflexion près) ; fin quand tous sont partis. */
function depart(ctx: Ctx, pid: ProvinceId, op: Operation): void {
  const { state, n, T } = ctx;
  const go = op.go!;
  const half = (state.world.balance.time.aiThinkMinutes * MINUTE) / 2;
  const city = cityPoint(state, pid);
  const due: string[] = [];
  for (const id of sortedKeys(go)) {
    const m = ctx.byId.get(id);
    if (!m || ctx.reserved.has(id)) {
      delete go[id];
      continue;
    }
    if (go[id]! > state.time + half) continue;
    // Chaque vague vérifie son trajet (pas de neutre traversé par inadvertance).
    if (!safeLegs(state, n, m.u, city)) {
      delete go[id];
      ctx.opUnits.delete(id);
      continue;
    }
    due.push(id);
  }
  if (due.length > 0 && order(state, n, { kind: 'move', unitIds: due, to: city })) {
    const until = state.time + T.commitHours * HOUR;
    for (const id of due) {
      delete go[id];
      ctx.idle.delete(id);
      ctx.opUnits.delete(id);
      ctx.commit[id] = [pid, until];
    }
  }
  op.units = sortedKeys(go);
  if (op.units.length > 0) return;
  // Tous partis : fin de l'opération (les navires d'escorte restent sur zone, en patrouille).
  for (const id of op.sea ?? []) {
    ctx.opUnits.delete(id);
    ctx.idle.delete(id);
  }
  delete ctx.ops[pid];
  ctx.aimed.add(pid);
}

/**
 * Préparatifs d'une menace contre `t` : la capitale gardée, des troupes massées dans la ville amie la
 * plus proche de sa capitale (frontière terrestre, sinon port d'embarquement), en paix et sans franchir
 * de frontière (le renseignement adverse peut les voir venir).
 */
function stage(ctx: Ctx, t: NationId): void {
  const { state, n, L } = ctx;
  const cap = capitalOf(state, n);
  if (cap && state.provinces[cap]?.owner === n) garrison(ctx, cap, L.capitalGarrison, 0, 0);
  const tCap = capitalOf(state, t);
  const aim =
    tCap && state.provinces[tCap]?.owner === t
      ? cityPoint(state, tCap)
      : provincesOf(state, t).length
        ? cityPoint(state, provincesOf(state, t)[0]!)
        : null;
  if (!aim) return;
  const w = wi(state.world);
  const links = seaLinks(state);
  // Frontière terrestre d'abord (rang 0), sinon port relié par la mer (rang 1) ; puis la plus proche.
  let best: ProvinceId | null = null;
  let bestKey: [number, number] = [2, Infinity];
  for (const q of provincesOf(state, n)) {
    const def = w.provById.get(q)!;
    const rank = def.neighbors.some((x) => state.provinces[x]?.owner === t)
      ? 0
      : (links.get(q) ?? []).some((x) => state.provinces[x]?.owner === t)
        ? 1
        : 2;
    if (rank === 2) continue;
    const d = distanceKm(def.cityPoint, aim);
    if (rank < bestKey[0] || (rank === bestKey[0] && d < bestKey[1])) {
      best = q;
      bestKey = [rank, d];
    }
  }
  if (best) garrison(ctx, best, L.stageUnits, 0, 0, false, ctx.T.attackReachKm);
}

/** Force à engager contre une ville : force ennemie connue × attackRatio (capitale : au moins deux unités). */
function needFor(ctx: Ctx, pid: ProvinceId, owner: NationId): number {
  const known = ctx.hold.get(pid) ?? 0;
  const capital = capitalOf(ctx.state, owner) === pid;
  const prior = capital ? 2 * ctx.mine.avgUnit : 0;
  return Math.max(known, prior) * ctx.L.attackRatio;
}

/** 3. Contre-attaque : provinces d'origine perdues, voisines d'une province possédée (capitale d'abord). */
function counterattack(ctx: Ctx): void {
  const { state, n, L } = ctx;
  const w = wi(state.world);
  const cap = capitalOf(state, n);
  const lost = (w.provsByNation.get(n) ?? []).filter((pid) => {
    const P = state.provinces[pid];
    return !!P && P.owner !== n && atWar(state, n, P.owner) && bordersOwned(state, n, pid);
  });
  lost.sort((a, b) => Number(b === cap) - Number(a === cap) || (a < b ? -1 : 1));
  let launched = 0;
  for (const pid of lost) {
    if (launched >= L.maxCounterPerThink || ctx.paths <= 0) break;
    if (launchGroup(ctx, pid, needFor(ctx, pid, state.provinces[pid]!.owner))) launched++;
  }
}

/**
 * 4. Offensive : provinces ennemies voisines, les plus rentables et les moins défendues d'abord ; puis
 * (niveaux qui débarquent) provinces côtières ennemies sans frontière avec les siennes, à portée d'un
 * de ses ports (débarquement : force exigée majorée, attrait réduit).
 */
function offensive(ctx: Ctx, only: Set<NationId> | null): void {
  const { state, n, L, T } = ctx;
  const w = wi(state.world);
  const seen = new Set<ProvinceId>();
  const cands: { pid: ProvinceId; score: number; owner: NationId; from: ProvinceId | null }[] = [];
  for (const own of provincesOf(state, n)) {
    for (const pid of sortedNeighbors(state, own)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const P = state.provinces[pid];
      if (!P || P.owner === n || !atWar(state, n, P.owner)) continue;
      if (only && !only.has(P.owner)) continue;
      if (ctx.aimed.has(pid) || (ctx.failed[pid] ?? 0) > state.time) continue;
      const def = w.provById.get(pid)!;
      const capital = capitalOf(state, P.owner) === pid;
      const hold = ctx.hold.get(pid) ?? 0;
      const worth = (capital ? L.enemyCapitalBonus : 1) * (1 + Math.log10(1 + def.income.money));
      cands.push({
        pid,
        owner: P.owner,
        score: worth / (1 + (2 * hold) / ctx.mine.avgUnit),
        from: null,
      });
    }
  }
  if (L.amphibious) {
    const links = seaLinks(state);
    const best = new Map<ProvinceId, [ProvinceId, number]>();
    for (const own of provincesOf(state, n)) {
      if (ctx.threat.has(own)) continue;
      const at = cityPoint(state, own);
      for (const pid of links.get(own) ?? []) {
        if (seen.has(pid)) continue;
        const P = state.provinces[pid];
        if (!P || P.owner === n || !atWar(state, n, P.owner)) continue;
        if (only && !only.has(P.owner)) continue;
        if (ctx.aimed.has(pid) || (ctx.failed[pid] ?? 0) > state.time) continue;
        const d = distanceKm(at, cityPoint(state, pid));
        const cur = best.get(pid);
        if (!cur || d < cur[1]) best.set(pid, [own, d]);
      }
    }
    for (const [pid, [from]] of [...best].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const P = state.provinces[pid]!;
      const def = w.provById.get(pid)!;
      const capital = capitalOf(state, P.owner) === pid;
      const hold = ctx.hold.get(pid) ?? 0;
      const worth = (capital ? L.enemyCapitalBonus : 1) * (1 + Math.log10(1 + def.income.money));
      cands.push({
        pid,
        owner: P.owner,
        score: (SEA_TARGET_WEIGHT * worth) / (1 + (2 * hold) / ctx.mine.avgUnit),
        from,
      });
    }
  }
  cands.sort((a, b) => b.score - a.score || (a.pid < b.pid ? -1 : 1));
  let launched = 0;
  let tries = 0;
  for (const c of cands) {
    if (launched >= L.maxOffensivePerThink || ctx.paths <= 0 || tries >= 4) break;
    tries++;
    const need = needFor(ctx, c.pid, c.owner) * (c.from ? T.amphibiousRatio : 1);
    if (launchGroup(ctx, c.pid, need, c.from)) launched++;
  }
}

/** Attrait d'un objectif à prendre par la mer, relatif à un objectif voisin par la terre. */
const SEA_TARGET_WEIGHT = 0.6;

function bordersOwned(state: EngineState, n: NationId, pid: ProvinceId): boolean {
  const def = wi(state.world).provById.get(pid);
  return !!def?.neighbors.some((x) => state.provinces[x]?.owner === n);
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

/** Valeur défensive par coût d'un système (statique). */
function defensiveValue(s: WeaponSystem): number {
  const dmg = Object.values(s.damage).reduce((a, b) => a + b, 0);
  return (s.hp * s.unitSize * (1 + s.armor) + dmg * s.unitSize) / Math.max(1, s.cost.money);
}

/**
 * Systèmes terrestres produits par l'IA, triés par valeur défensive par coût décroissante puis par
 * identifiant (par monde) : tous, et par catégorie.
 */
const catalogCache = new WeakMap<
  object,
  { all: WeaponSystem[]; by: Map<Category, WeaponSystem[]> }
>();

function landCatalog(state: EngineState): {
  all: WeaponSystem[];
  by: Map<Category, WeaponSystem[]>;
} {
  let c = catalogCache.get(state.world);
  if (!c) {
    const all: WeaponSystem[] = [];
    for (const id of wi(state.world).systemIds) {
      const s = state.world.catalog.get(id)!;
      if (!s.enabled || !LAND_CATEGORIES.includes(s.category)) continue;
      if (s.movement === 'sea' || defensiveValue(s) <= 0) continue;
      if (!Object.values(s.damage).some((d) => d > 0)) continue;
      all.push(s);
    }
    const value = new Map(all.map((s) => [s.id, defensiveValue(s)]));
    all.sort((a, b) => value.get(b.id)! - value.get(a.id)! || (a.id < b.id ? -1 : 1));
    const by = new Map<Category, WeaponSystem[]>();
    for (const s of all) {
      let list = by.get(s.category);
      if (!list) by.set(s.category, (list = []));
      list.push(s);
    }
    catalogCache.set(state.world, (c = { all, by }));
  }
  return c;
}

const AIR_CATEGORIES = new Set<string>(['fighter', 'bomber', 'air_support', 'helicopter', 'drone']);

/**
 * Catégories voulues, de la plus urgente à la moins urgente : écart entre la composition souhaitée
 * (adaptée aux forces ennemies identifiées : aviation → défense antiaérienne, blindés → chars et
 * artillerie) et la composition actuelle de son armée de terre.
 */
function wantedCategories(ctx: Ctx): Category[] {
  const enemy: Record<string, number> = {};
  let total = 0;
  for (const e of ctx.enemies) {
    if (!e.sys) continue;
    const k = AIR_CATEGORIES.has(e.sys.category) ? 'air' : e.sys.category;
    enemy[k] = (enemy[k] ?? 0) + e.value;
    total += e.value;
  }
  const share = (k: string): number => (total > 0 ? (enemy[k] ?? 0) / total : 0);
  const want: Record<string, number> = {
    infantry: 1 + share('infantry'),
    tank: 1 + 1.5 * (share('tank') + share('ifv')),
    ifv: 1 + share('infantry'),
    artillery: 0.7 + share('tank') + share('artillery'),
    air_defense: 0.5 + 4 * share('air'),
  };
  // Composition actuelle en nombre de piles (commandes en cours comprises : pas cinq défenses
  // antiaériennes d'affilée) ; en valeur, les systèmes bon marché resteraient toujours « en manque ».
  const have: Record<string, number> = {};
  let haveTotal = 0;
  for (const m of ctx.land) {
    have[m.s.category] = (have[m.s.category] ?? 0) + 1;
    haveTotal++;
  }
  for (const it of ctx.state.nations[ctx.n]!.production) {
    const s = ctx.state.world.catalog.get(it.systemId);
    if (!s) continue;
    have[s.category] = (have[s.category] ?? 0) + 1;
    haveTotal++;
  }
  const wantTotal = LAND_CATEGORIES.reduce((a, c) => a + want[c]!, 0);
  const gap = (c: Category): number =>
    want[c]! / wantTotal - (haveTotal > 0 ? (have[c] ?? 0) / haveTotal : 0);
  return [...LAND_CATEGORIES].sort((a, b) => gap(b) - gap(a) || (a < b ? -1 : 1));
}

/**
 * Production terrestre quand l'argent le permet, sans entamer la réserve (jours de budget et déficit
 * structurel). En guerre, si le niveau le prévoit, la catégorie suit la menace observée.
 */
function produce(state: EngineState, n: NationId, peaceful: boolean, ctx: Ctx | null): void {
  const ns = state.nations[n]!;
  const T = aiCfg(state.world).tactical;
  if (ns.production.length >= (peaceful ? T.maxQueuePeace : T.maxQueueWar)) return;
  const maxUnits = peaceful
    ? T.peaceUnitsBase + T.peaceUnitsPerProvince * ns.provinceCount
    : T.warUnitsBase + T.warUnitsPerProvince * ns.provinceCount;
  if ((state.rt.byNation.get(n)?.size ?? 0) + ns.production.length >= maxUnits) return;
  const siteOf = productionSites(state, n, ctx);
  if (!siteOf) return;
  const sites = new Map<string, ProvinceId>();
  // Réserve calculée seulement si une option est abordable (le grand livre n'est lu qu'au besoin).
  let reserve: number | null = null;
  const factor = peaceful ? aiCfg(state.world).economy.peaceReserveFactor : 1;
  const ok = (s: WeaponSystem): boolean => {
    if (ns.money < s.cost.money * factor) return false;
    const site = siteOf(s);
    const price = aiUnitPrice(state, n, s, site);
    if (price === null || ns.money < price * factor) return false;
    reserve ??= aiReserve(state, n, !peaceful, ctx?.critical ?? false);
    if (ns.money - price < reserve) return false;
    sites.set(s.id, site);
    return true;
  };
  const cat = landCatalog(state);
  let options: WeaponSystem[] = [];
  if (ctx && ctx.L.adaptiveProduction) {
    // Catégorie la plus utile, puis les deux meilleurs systèmes abordables de cette catégorie.
    for (const c of wantedCategories(ctx)) {
      for (const s of cat.by.get(c) ?? []) {
        if (!ok(s)) continue;
        options.push(s);
        if (options.length >= 2) break;
      }
      if (options.length > 0) break;
    }
  } else {
    // Valeur défensive par coût : tirage parmi les trois meilleures options abordables.
    for (const s of cat.all) {
      if (!ok(s)) continue;
      options.push(s);
      if (options.length >= 3) break;
    }
  }
  if (options.length === 0) return;
  options = options.slice(0, 3);
  const pick = options[nextInt(state.rng, options.length)]!;
  order(state, n, { kind: 'produce', provinceId: sites.get(pick.id)!, systemId: pick.id });
}

/** Une usine 1 000 km plus près du front vaut une usine deux fois plus rapide. */
const FRONT_KM = 1000;

/**
 * Lieu de production d'un système : la province possédée la mieux équipée pour le fabriquer (vitesse
 * de production de ses bâtiments) et la plus proche du front, hors villes menacées ; importation (ou
 * recherche manquante) : la ville sûre la plus proche du front. En paix : la mieux équipée (capitale à
 * égalité). Sans économie réelle : la capitale. null si la nation n'a plus de province.
 */
function productionSites(
  state: EngineState,
  n: NationId,
  ctx: Ctx | null,
): ((s: WeaponSystem) => ProvinceId) | null {
  const w = wi(state.world);
  const provs = provincesOf(state, n);
  if (provs.length === 0) return null;
  const cap = w.nationById.get(n)?.capitalProvinceId;
  const home = cap && state.provinces[cap]?.owner === n ? cap : provs[0]!;
  if (!eco(state).live) return () => home;
  const front = ctx ? frontPoint(ctx) : null;
  const near = (pid: ProvinceId): number =>
    front ? 1 + distanceKm(cityPoint(state, pid), front) / FRONT_KM : 1;
  let forward: ProvinceId | null = null;
  if (front) {
    let bestD = Infinity;
    for (const pid of provs) {
      if (ctx?.threat.has(pid)) continue;
      const d = near(pid);
      if (d < bestD) {
        bestD = d;
        forward = pid;
      }
    }
  }
  const imports = forward ?? home;
  const factories = new Map<string, ProvinceId | null>();
  // Capitale menacée ou dégarnie : les renforts sortent sur place (ils la défendent aussitôt).
  if ((ctx?.critical || ctx?.capShort) && home === cap) return () => home;
  return (s: WeaponSystem): ProvinceId => {
    const need = requiredBuildings(s);
    const key = need.join(',');
    let site = factories.get(key);
    if (site === undefined) {
      site = null;
      let best = 0;
      for (const pid of provs) {
        if (ctx?.threat.has(pid)) continue;
        const sp = provinceProductionSpeed(state, pid, need);
        if (sp <= 0) continue;
        const score = sp / near(pid);
        if (score > best || (score === best && pid === home)) {
          best = score;
          site = pid;
        }
      }
      factories.set(key, site);
    }
    return site && !localCheck(state, n, s, site) ? site : imports;
  };
}

/** Direction du front : capitale de son premier ennemi régulier (ou de la nation menacée), sinon null. */
function frontPoint(ctx: Ctx): LngLat | null {
  const { state, n } = ctx;
  const plan = warPlanOf(state, n);
  const targets = plan ? [plan.t] : warsOf(state, n);
  const nb = neighborNations(state, n);
  const sorted = [...targets].sort(
    (a, b) => Number(nb.includes(b)) - Number(nb.includes(a)) || (a < b ? -1 : 1),
  );
  for (const e of sorted) {
    const cap = capitalOf(state, e);
    if (cap && state.provinces[cap]?.owner === e) return cityPoint(state, cap);
    const first = provincesOf(state, e)[0];
    if (first) return cityPoint(state, first);
  }
  return null;
}
