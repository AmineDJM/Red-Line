import {
  HOUR,
  airDefenseLine,
  distanceKm,
  type LngLat,
  type NationId,
  type ProvinceId,
} from '@redline/shared';
import { counterattack, garrison, safeLegs, type Ctx } from '../../ai/ai.js';
import { atWar, provincesOf, sortedKeys, sysOf, unitPosAt } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../../state/world.js';
import { hasPassage } from '../../state/war.js';
import { isLauncher } from '../../encounters/profile.js';
import { canEscort } from '../mil/escort.js';
import { canFly, ready } from '../mil/ai.js';
import { mil, milBal } from '../mil/state.js';
import { cellsLeft, missileForShip } from '../mil/strike.js';
import { hasCargo, capacityOf, placesOf } from '../mil/transport.js';
import { airfieldsOf, isFuelAir, launchCells, portsOf, strikeRangeKm } from '../mil/util.js';
import { maxFuel } from '../mil/air.js';
import { leaveOp, goalDef, opNations, type OpIntel } from './ops.js';
import {
  airUnits,
  centroid,
  cityOf,
  commanded,
  holdGround,
  order,
  seaUnits,
  type Think,
} from './brain.js';
import { journal, opJournal } from './journal.js';
import {
  alliesOf,
  borderWith,
  capitalOf,
  goalParam,
  nearestOwn,
  pacifySites,
  umbrellaAims,
} from './opgoals.js';
import { cmd, cmdBal, type OpSt } from './state.js';

/**
 * Conduite propre aux objectifs ajoutés (opgoals.ts) et posture des forces après une opération :
 * garnisons par lignes (défense en profondeur), capitale, pacification, démonstration de force,
 * soutien d'un allié, raid puis repli, redéploiement aérien, chasse navale, escorte des transports,
 * blocus renforcé, salves de missiles coordonnées, placement de la DCA (bouclier, parapluie). Tous les
 * ordres passent par `order` (mêmes validations que ceux du joueur) ; aucun tirage, ordre trié.
 */

const reachOf = (state: EngineState) => cmdBal(state).tactics.reachKm;

/** Province à soi (ou alliée, avec droit de passage) : on peut y stationner sans déclarer la guerre. */
function enterable(state: EngineState, n: NationId, pid: ProvinceId): boolean {
  const o = state.provinces[pid]?.owner;
  return o === n || (!!o && hasPassage(state, n, o));
}

/** Garnisons réparties sur des provinces (dans l'ordre donné), `count` piles au total. */
function spread(t: Think, ctx: Ctx, pids: ProvinceId[], count: number, recall = false): void {
  const { state, L } = t;
  if (!pids.length || count <= 0) return;
  const slots = Math.min(pids.length, count);
  const per = Math.max(1, Math.floor(count / slots));
  for (const pid of pids.slice(0, slots)) {
    const threat = ctx.threat.get(pid) ?? 0;
    garrison(ctx, pid, per, threat * L.attackRatio, 0.6, recall, reachOf(state));
  }
}

/** Provinces triées par menace connue, puis revenu. */
function byThreat(state: EngineState, ctx: Ctx, pids: ProvinceId[]): ProvinceId[] {
  const w = wi(state.world);
  return [...pids].sort(
    (x, y) =>
      (ctx.threat.get(y) ?? 0) - (ctx.threat.get(x) ?? 0) ||
      w.provById.get(y)!.income.money - w.provById.get(x)!.income.money ||
      (x < y ? -1 : 1),
  );
}

function groundCount(ctx: Ctx): number {
  return ctx.land.filter((m) => m.ground).length;
}

// ——— Terre ———

/** Défense en profondeur : lignes successives tenues par parts, contre-attaques, repli ordonné. */
export function depthLand(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, n, L } = t;
  const def = goalDef(state, op.goal);
  const lines = (op.gd?.lines ?? []).map((l) => l.filter((p) => state.provinces[p]?.owner === n));
  if (L.counterattack) counterattack(ctx);
  const ground = groundCount(ctx);
  const s1 = goalParam(def, 'line1', 0.45);
  const s2 = goalParam(def, 'line2', 0.35);
  const shares = [s1, s2, Math.max(0, 1 - s1 - s2)];
  // Une ligne perdue : ses parts passent à la suivante (repli ordonné sur la ligne arrière).
  let carry = 0;
  lines.forEach((line, i) => {
    const want = Math.round(ground * (shares[i] ?? 0)) + carry;
    if (!line.length) {
      carry = want;
      return;
    }
    carry = 0;
    spread(t, ctx, byThreat(state, ctx, line), want);
  });
  for (const p of (lines[0] ?? []).slice(0, 3)) aims.push(cityOf(state, p));
}

/** Défense de la capitale : la capitale d'abord (part dédiée, rappel des piles), puis sa couronne. */
export function capitalLand(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, n, L } = t;
  const sites = (op.gd?.sites ?? []).filter((p) => state.provinces[p]?.owner === n);
  const lostCap = op.gd?.sites?.[0];
  if (L.counterattack) counterattack(ctx);
  const ground = groundCount(ctx);
  const share = goalParam(goalDef(state, op.goal), 'capitalShare', 0.5);
  const cap = sites[0] === lostCap ? sites[0] : undefined;
  if (cap) {
    const k = Math.max(1, Math.round(ground * share));
    garrison(ctx, cap, k, (ctx.threat.get(cap) ?? 0) * L.attackRatio, 0.6, true, reachOf(state));
    aims.push(cityOf(state, cap));
  }
  spread(
    t,
    ctx,
    byThreat(
      state,
      ctx,
      sites.filter((p) => p !== cap),
    ),
    ground,
  );
}

/**
 * Pacification : une garnison par province conquise ou agitée (les plus agitées et menacées d'abord),
 * chasse des rebelles et des intrus vus sur son territoire.
 */
export function pacifyLand(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, n, L } = t;
  const def = goalDef(state, op.goal);
  const huntKm = goalParam(def, 'huntKm', 120);
  const sites = pacifySites(state, n);
  const nav = wi(state.world).nav;
  // Intrus : forces terrestres vues dans ses provinces, appartenant à une nation en guerre avec soi.
  const prey = ctx.enemies
    .filter((e) => {
      if (!e.seen || e.medium !== 'land') return false;
      const u = state.units[e.id];
      if (!u || !atWar(state, n, u.owner)) return false;
      const pid = nav.cellProv.get(nav.cellOfPos(e.pos));
      return !!pid && state.provinces[pid]?.owner === n;
    })
    .sort((x, y) => y.value - x.value || (x.id < y.id ? -1 : 1));
  let groups = 0;
  for (const e of prey) {
    if (groups >= L.maxOffensivePerThink || ctx.paths <= 0) break;
    const need = e.value * L.attackRatio;
    const cands = ctx.land
      .filter((m) => ctx.idle.has(m.u.id) && m.ground)
      .map((m) => ({ m, d: distanceKm(m.pos, e.pos) }))
      .filter((x) => x.d <= huntKm * 3)
      .sort((x, y) => x.d - y.d || (x.m.u.id < y.m.u.id ? -1 : 1));
    const group: string[] = [];
    let force = 0;
    for (const { m } of cands) {
      if (force >= need || group.length >= L.groupMax || ctx.paths <= 0) break;
      ctx.paths--;
      if (!safeLegs(state, n, m.u, e.pos)) continue;
      group.push(m.u.id);
      force += m.value;
    }
    if (!group.length || force < need * 0.75) continue;
    if (order(state, n, { kind: 'attack', unitIds: group, targetId: e.id })) {
      for (const id of group) ctx.idle.delete(id);
      groups++;
      opJournal(state, op, 'hunt', { army: t.a.name });
    }
  }
  spread(t, ctx, byThreat(state, ctx, sites), groundCount(ctx));
  for (const p of sites.slice(0, 3)) aims.push(cityOf(state, p));
}

/** Démonstration de force : forces massées dans ses villes frontalières, sans jamais franchir. */
export function showLand(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, n } = t;
  const sites = (op.gd?.sites ?? []).filter((p) => state.provinces[p]?.owner === n);
  spread(t, ctx, byThreat(state, ctx, sites), groundCount(ctx));
  for (const p of sites.slice(0, 4)) aims.push(cityOf(state, p));
}

/** Front d'un allié face à ses ennemis (provinces alliées à leur contact), sinon sa capitale. */
export function allyFront(state: EngineState, op: OpSt): ProvinceId[] {
  const foes = new Set(opNations(state, op));
  const out: ProvinceId[] = [];
  for (const a of op.gd?.allies ?? op.nations) out.push(...borderWith(state, a, foes));
  if (out.length) return [...new Set(out)].sort();
  return (op.gd?.allies ?? op.nations)
    .map((a) => capitalOf(state, a))
    .filter((p): p is ProvinceId => !!p && !!state.provinces[p]);
}

/**
 * Soutien d'un allié : garnisons sur son front (droit de passage), sinon dans ses propres villes les
 * plus proches de lui ; contre-attaques des provinces alliées perdues quand la guerre est ouverte.
 */
export function allyLand(t: Think, ctx: Ctx, op: OpSt, aims: LngLat[]): void {
  const { state, n } = t;
  const front = allyFront(state, op);
  const there = front.filter((p) => enterable(state, n, p));
  let holds = there;
  if (!holds.length) {
    const set = new Set<ProvinceId>();
    for (const p of front) {
      const q = nearestOwn(state, n, cityOf(state, p));
      if (q) set.add(q);
    }
    holds = [...set].sort();
  }
  spread(t, ctx, byThreat(state, ctx, holds), groundCount(ctx));
  for (const p of front.slice(0, 4)) aims.push(cityOf(state, p));
}

/** Raid, repli : toutes les piles terrestres rentrent dans la ville amie la plus proche. */
export function raidWithdraw(t: Think, ctx: Ctx, aims: LngLat[]): void {
  const { state, a, n } = t;
  const at = centroid(state, a);
  const home = at ? nearestOwn(state, n, at) : null;
  if (!home) return;
  garrison(ctx, home, ctx.land.length, 0, 0, true, reachOf(state));
  aims.push(cityOf(state, home));
}

// ——— Air ———

/** Redéploiement aérien : chaque appareil rejoint le terrain de destination le plus proche qu'il atteint. */
export function redeployAir(t: Think, op: OpSt, aims: LngLat[]): void {
  const { state, a, n } = t;
  const fields = (op.gd?.fields ?? []).filter((p) => state.provinces[p]?.owner === n);
  if (!fields.length) {
    a.why = 'noTargets';
    return;
  }
  const ms = mil(state).ms;
  const memo = (a.mem.capFail ??= {});
  const dest = cityOf(state, fields[0]!);
  const all = airfieldsOf(state, n);
  let left = 8;
  for (const u of airUnits(state, a)) {
    if (left <= 0) break;
    const m = ms[u.id];
    const s = sysOf(state, u);
    if (!m || !isFuelAir(s) || m.emb || (m.base && fields.includes(m.base)) || !ready(state, u))
      continue;
    if ((memo[`r:${u.id}`] ?? 0) > state.time) continue;
    const here = unitPosAt(state, u, state.time);
    // Convoyage d'une traite : destination si elle est à portée, sinon le terrain ami le plus proche
    // d'elle parmi ceux qu'il atteint (étape), jamais un terrain plus loin que sa base actuelle.
    const ferry = Math.max(0, maxFuel(state, u) - milBal(state).air.reserveH) * s.speedKmh * 0.95;
    const cur =
      m.base && state.provinces[m.base] ? distanceKm(cityOf(state, m.base), dest) : Infinity;
    const step = [...fields, ...all.filter((p) => !fields.includes(p))]
      .filter((p) => distanceKm(cityOf(state, p), here) <= ferry && p !== m.base)
      .map((p) => ({ p, d: fields.includes(p) ? -1 : distanceKm(cityOf(state, p), dest) }))
      .filter((x) => x.d < cur)
      .sort((x, y) => x.d - y.d || (x.p < y.p ? -1 : 1))[0];
    left--;
    if (!step || !order(state, n, { kind: 'rebase', unitIds: [u.id], provinceId: step.p }))
      memo[`r:${u.id}`] = state.time + 6 * HOUR;
  }
  for (const p of fields) aims.push(cityOf(state, p));
}

// ——— Mer ———

/**
 * Un navire engage un navire ennemi vu : à portée de ses armes ou de ses missiles (cellules
 * chargées) il attaque, sinon il fait route vers le contact (patrouille sur sa position connue) au
 * lieu d'un ordre refusé. Vrai si un ordre est donné.
 */
export function engageShip(t: Think, ship: Unit, e: { u: Unit; pos: LngLat }): boolean {
  const { state, n } = t;
  const s = sysOf(state, ship);
  const here = unitPosAt(state, ship, state.time);
  const d = distanceKm(here, e.pos);
  const cells = launchCells(s) > 0 && cellsLeft(state, ship) > 0;
  const msys = cells ? missileForShip(state, s, true) : null;
  // Marge : la position connue d'un navire vieillit (il a pu s'éloigner).
  const range = Math.max(s.weaponRangeKm.max, msys ? strikeRangeKm(msys) * 0.8 : 0);
  if (d <= range && order(state, n, { kind: 'attack', unitIds: [ship.id], targetId: e.u.id }))
    return true;
  if (d <= Math.max(30, range) || ship.move || !safeLegs(state, n, ship, e.pos)) return false;
  return order(state, n, { kind: 'patrol', unitIds: [ship.id], at: e.pos, radiusKm: 60 });
}

/**
 * Supériorité navale, guerre anti-navires : tous les navires libres traquent les navires ennemis vus
 * (sous-marins et navires armés contre navires, les plus proches d'abord), le reste patrouille au
 * large des ports ennemis pour les débusquer.
 */
export function huntShips(t: Think, op: OpSt, I: OpIntel, free: Unit[]): void {
  const { state, n } = t;
  const km = goalParam(goalDef(state, op.goal), 'huntKm', 1500);
  const targets = [...I.ships].sort((x, y) => (x.u.id < y.u.id ? -1 : 1));
  for (const e of targets) {
    const hunters = free
      .filter((u) => {
        const s = sysOf(state, u);
        return (
          ((s.damage as Record<string, number>).ship ?? 0) > 0 &&
          distanceKm(unitPosAt(state, u, state.time), e.pos) <= km
        );
      })
      .sort(
        (x, y) =>
          distanceKm(unitPosAt(state, x, state.time), e.pos) -
            distanceKm(unitPosAt(state, y, state.time), e.pos) || (x.id < y.id ? -1 : 1),
      )
      .slice(0, 2);
    for (const h of hunters) if (engageShip(t, h, e)) free.splice(free.indexOf(h), 1);
  }
}

/** Escorte des transports chargés de la nation (ses convois) et patrouille au large de ses ports. */
export function escortConvoys(t: Think, free: Unit[], aims: LngLat[]): void {
  const { state, n } = t;
  const ms = mil(state).ms;
  for (const id of sortedKeys(state.units)) {
    const tr = state.units[id]!;
    if (tr.owner !== n || tr.off || !hasCargo(state, id)) continue;
    let escorted = false;
    for (const x of sortedKeys(ms)) {
      if (ms[x]!.mis === 'escort' && state.units[x]?.target === id) {
        escorted = true;
        break;
      }
    }
    if (escorted) continue;
    const e = free
      .filter((u) => canEscort(state, u) && u.id !== id)
      .sort(
        (x, y) =>
          distanceKm(unitPosAt(state, x, state.time), unitPosAt(state, tr, state.time)) -
            distanceKm(unitPosAt(state, y, state.time), unitPosAt(state, tr, state.time)) ||
          (x.id < y.id ? -1 : 1),
      )[0];
    if (e && order(state, n, { kind: 'escort', unitIds: [e.id], targetId: id })) {
      free.splice(free.indexOf(e), 1);
      aims.push(unitPosAt(state, tr, state.time));
    }
  }
  // Routes maritimes : patrouille au large de ses ports les plus actifs.
  const w = wi(state.world);
  const ports = portsOf(state, n)
    .map((p) => w.seaSpawn.get(p))
    .filter((p): p is LngLat => !!p);
  let tries = 4;
  for (const u of free) {
    if (tries-- <= 0 || !ports.length) break;
    const here = unitPosAt(state, u, state.time);
    const at = [...ports].sort((x, y) => distanceKm(x, here) - distanceKm(y, here))[0]!;
    if (distanceKm(here, at) <= 150) continue;
    if (!safeLegs(state, n, u, at)) continue;
    order(state, n, { kind: 'patrol', unitIds: [u.id], at, radiusKm: 150 });
  }
}

// ——— Feux ———

/**
 * Campagne de frappes de missiles : salves coordonnées. Les lanceurs prêts attendent d'être assez
 * nombreux (part `readyShare` des lanceurs de l'armée, au plus `waitHours` depuis la dernière salve)
 * puis tirent ensemble.
 */
export function salvoReady(t: Think, op: OpSt, launchers: Unit[]): boolean {
  const { state, a } = t;
  const def = goalDef(state, op.goal);
  const reload = mil(state).reload;
  const ready = launchers.filter((u) => (reload[u.id] ?? 0) <= state.time).length;
  if (!ready) return false;
  const share = goalParam(def, 'readyShare', 0.5);
  const wait = goalParam(def, 'waitHours', 2) * HOUR;
  const last = op.cnt?.[`salvo:${a.id}`] ?? op.phaseAt ?? op.since;
  return ready >= Math.ceil(launchers.length * share) || state.time - last >= wait;
}

export function salvoFired(t: Think, op: OpSt, fired: number): void {
  if (!fired) return;
  op.cnt ??= {};
  op.cnt[`salvo:${t.a.id}`] = t.state.time;
  opJournal(t.state, op, 'salvo', { army: t.a.name, count: fired });
}

/** Lanceurs (sol-sol, croisière) et navires lance-missiles commandés, armes nucléaires exclues. */
export function launchersOf(t: Think): Unit[] {
  const { state, a } = t;
  return commanded(state, a)
    .map((id) => state.units[id]!)
    .filter((u) => {
      if (u.off) return false;
      const s = sysOf(state, u);
      const ship = s.movement === 'sea' && launchCells(s) > 0 && cellsLeft(state, u) > 0;
      if (!isLauncher(s) && !ship) return false;
      const msys = isLauncher(s) ? s : missileForShip(state, s, false);
      return !!msys && msys.missile?.warhead !== 'nuclear';
    });
}

// ——— Défense sol-air ———

/** Villes à couvrir par la DCA selon l'objectif ; null : placement d'origine. */
export function adHolds(t: Think, op: OpSt): ProvinceId[] | null {
  const { state, n } = t;
  const mine = (p: ProvinceId) => state.provinces[p]?.owner === n;
  switch (op.goal) {
    case 'missile_shield':
    case 'air_defense_territory':
    case 'defend_capital':
      return (op.gd?.sites ?? []).filter(mine);
    case 'defense_depth':
      return [...(op.gd?.lines?.[0] ?? []), ...(op.gd?.lines?.[1] ?? [])].filter(mine);
    case 'ad_umbrella': {
      const out: ProvinceId[] = [];
      for (const p of umbrellaAims(state, op)) {
        const q = nearestOwn(state, n, p);
        if (q && !out.includes(q)) out.push(q);
      }
      if (!out.length) {
        const cap = capitalOf(state, n);
        if (cap && mine(cap)) out.push(cap);
      }
      return out;
    }
    case 'ally_support': {
      const out: ProvinceId[] = [];
      for (const p of allyFront(state, op)) {
        if (enterable(state, n, p)) out.push(p);
        else {
          const q = nearestOwn(state, n, cityOf(state, p));
          if (q && !out.includes(q)) out.push(q);
        }
      }
      return out;
    }
    case 'pacify':
      return pacifySites(state, n).slice(0, 6);
    case 'show_of_force':
      return (op.gd?.sites ?? []).filter(mine);
  }
  return null;
}

/** Défenses antimissiles (enveloppe balistique) d'abord sur les premiers sites (capitale). */
export function shieldOrder(state: EngineState, ads: Unit[]): Unit[] {
  const abm = (u: Unit) => (airDefenseLine(sysOf(state, u), 'ballistic_missile') ? 0 : 1);
  return [...ads].sort((x, y) => abm(x) - abm(y) || (x.id < y.id ? -1 : 1));
}

// ——— Après l'opération ———

/** Provinces que les forces tiennent après l'opération : gains, front face aux pays visés, villes proches. */
function holdsAfter(state: EngineState, op: OpSt, at: LngLat | null): ProvinceId[] {
  const n = op.owner;
  const ok = op.status === 'success';
  const gains = op.targets.filter((p) => {
    const o = state.provinces[p]?.owner;
    return o === n || (ok && !!o && atWar(state, n, o));
  });
  if (gains.length) return gains;
  const foes = new Set(opNations(state, op).filter((o) => atWar(state, n, o)));
  const front = foes.size ? borderWith(state, n, foes) : [];
  if (front.length) return front;
  if (op.gd?.sites?.length) return op.gd.sites.filter((p) => state.provinces[p]?.owner === n);
  if (!at) return [];
  return provincesOf(state, n)
    .map((p) => ({ p, d: distanceKm(cityOf(state, p), at) }))
    .sort((x, y) => x.d - y.d || (x.p < y.p ? -1 : 1))
    .slice(0, 2)
    .map((x) => x.p);
}

/** Exploitation : les forces tiennent les gains (garnisons, DCA, chasse si l'ennemi vole). */
export function holdOp(t: Think, op: OpSt): void {
  const { state, a } = t;
  const at = centroid(state, a);
  holdGround(t, holdsAfter(state, op, at), at);
}

/**
 * Rentrer à la base : piles terrestres vers la ville amie la plus proche de leur point de départ,
 * aviation à sa base, navires au port le plus proche ; une fois rentrées (ou au-delà du délai),
 * l'armée est rendue au joueur (forces d'office dissoutes, piles libres).
 */
export function returnHome(t: Think, op: OpSt): void {
  const { state, a, n } = t;
  const home = a.home ?? centroid(state, a);
  const city = home ? nearestOwn(state, n, home) : null;
  const ms = mil(state).ms;
  const w = wi(state.world);
  let away = 0;
  let paths = 12;
  for (const id of commanded(state, a)) {
    const u = state.units[id]!;
    if (u.off) continue;
    const s = sysOf(state, u);
    if (s.speedKmh <= 0) continue;
    const here = unitPosAt(state, u, state.time);
    if (s.movement === 'air') {
      const m = ms[id];
      if (m?.up) {
        away++;
        if (m.mis !== 'rtb') order(state, n, { kind: 'rtb', unitIds: [id] });
      }
      continue;
    }
    if (s.movement === 'sea') {
      if (capacityOf(state, u) > 0 && hasCargo(state, id)) {
        away++;
        continue;
      }
      const ports = portsOf(state, n)
        .map((p) => w.seaSpawn.get(p))
        .filter((p): p is LngLat => !!p)
        .sort((x, y) => distanceKm(x, here) - distanceKm(y, here));
      const port = ports[0];
      if (!port || distanceKm(port, here) <= 60) continue;
      away++;
      if (!u.move && paths-- > 0 && safeLegs(state, n, u, port))
        order(state, n, { kind: 'move', unitIds: [id], to: port });
      continue;
    }
    if (!city) continue;
    const to = cityOf(state, city);
    if (distanceKm(here, to) <= CAPTURE_RADIUS_KM * 2) continue;
    away++;
    if (!u.move && !u.target && paths-- > 0 && safeLegs(state, n, u, to))
      order(state, n, { kind: 'move', unitIds: [id], to });
  }
  a.aims = city ? [cityOf(state, city)] : [];
  if (away === 0 || state.time >= (op.postUntil ?? 0)) {
    journal(state, a, 'returned', { op: op.name }, 'good');
    opJournal(state, op, 'returned', { army: a.name }, 'good');
    leaveOp(state, a, true);
  }
}

/**
 * Assaut amphibie avec des brigades (piles mixtes trop grosses pour un navire) : le général détache
 * de sa plus grosse pile capable de prendre une ville un groupement à la taille du transport libre
 * (ordre `split`, la pile détachée reste dans l'armée). Une fois par réflexion, seulement si aucune
 * pile ne tient déjà à bord.
 */
export function fitTransports(t: Think, transports: string[]): void {
  const { state, a, n } = t;
  let cap = 0;
  for (const id of transports) {
    const tr = state.units[id];
    if (!tr || tr.off || hasCargo(state, id)) continue;
    cap = Math.max(cap, capacityOf(state, tr));
  }
  if (cap <= 0) return;
  const piles = commanded(state, a)
    .map((id) => state.units[id]!)
    .filter((u) => {
      // Pile déjà à bord (hors carte) : elle compte comme un groupement qui tient sur le navire.
      const s = sysOf(state, u);
      return s.movement === 'land' && s.canCapture && s.speedKmh > 0;
    });
  if (!piles.length || piles.some((u) => placesOf(state, u) <= cap)) return;
  const idle = piles.filter((u) => !u.off && !u.move && !u.target);
  if (!idle.length) return;
  const big = [...idle].sort((x, y) => y.count - x.count || (x.id < y.id ? -1 : 1))[0]!;
  const per = placesOf(state, big) / Math.max(1, big.count);
  const k = Math.floor(cap / Math.max(1e-9, per));
  if (k < 1 || k >= big.count) return;
  if (order(state, n, { kind: 'split', unitId: big.id, count: k }))
    journal(state, a, 'detached', { count: k });
}

/** Fronts d'alliés possibles pour une opération de soutien (interface : pays proposés). */
export function supportable(state: EngineState, n: NationId): NationId[] {
  return alliesOf(state, n);
}

/** Navires de l'armée prêts (libres). */
export function freeShips(t: Think): Unit[] {
  const { state, a } = t;
  const ms = mil(state).ms;
  return seaUnits(state, a).filter((u) => {
    if (u.move || u.target || hasCargo(state, u.id) || capacityOf(state, u) > 0) return false;
    const x = ms[u.id]?.mis;
    return !x || x === 'none';
  });
}

/** L'appareil atteint-il ce point (rayon d'action) ? */
export function reaches(state: EngineState, n: NationId, u: Unit, at: LngLat): boolean {
  return canFly(state, n, u, at);
}

/** Portée de frappe d'un lanceur ou d'un navire (km), 0 sinon. */
export function fireRange(state: EngineState, u: Unit): number {
  const s = sysOf(state, u);
  const msys = isLauncher(s) ? s : missileForShip(state, s, false);
  return msys ? strikeRangeKm(msys) : 0;
}
