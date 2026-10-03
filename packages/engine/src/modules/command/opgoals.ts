import {
  HOUR,
  distanceKm,
  type BuildingType,
  type LngLat,
  type NationId,
  type OpGoalDef,
  type OpMetric,
  type ProvinceId,
} from '@redline/shared';
import { atWar, provincesOf, sortedKeys, sysOf, unitPosAt, warsOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../../state/world.js';
import { board } from '../registry.js';
import { health as bldHealth } from '../eco/buildings.js';
import { knowledge } from '../intel/provinces.js';
import { ds } from '../diplo/state.js';
import { mil } from '../mil/state.js';
import { statOf } from '../mil/stats.js';
import { airfieldsOf, buildingsOf, portsOf } from '../mil/util.js';
import { hasCargo } from '../mil/transport.js';
import { cmd, cmdBal, type OpSt } from './state.js';

/**
 * Objectifs d'opération ajoutés aux neuf d'origine : cibles (provinces à prendre, lignes, sites,
 * axes), mesures chiffrées et critère de réussite, objectifs de durée tenus. La conduite (ordres des
 * généraux) est dans opbrain.ts, qui s'appuie sur ces données. Tout est déterministe (ordres triés).
 *
 * Terre : contre-offensive (provinces perdues), libération (provinces d'un allié), encerclement
 * (goulot puis poche), percée (axe en profondeur), raid (arrière ennemi puis repli), siège (anneau
 * puis ville), défense en profondeur (lignes successives), défense de la capitale, pacification
 * (provinces conquises, rebelles), démonstration de force (sans franchir).
 * Air : interdiction (logistique, mouvements), appui rapproché, bombardement stratégique continu,
 * défense aérienne du territoire, redéploiement aérien, reconnaissance armée.
 * Mer : supériorité navale, guerre anti-navires, escorte des transports, assaut amphibie, blocus
 * renforcé des ports, frappes depuis la mer.
 * DCA et missiles : bouclier antimissile, parapluie de DCA, campagne de frappes de missiles.
 * Interarmées : guerre éclair et opération combinée (phases enchaînées), soutien à un allié.
 */

/** Objectifs qui prennent des provinces (op.targets). */
export const TAKING = new Set([
  'conquest',
  'occupy',
  'decapitation',
  'counteroffensive',
  'liberation',
  'encircle',
  'breakthrough',
  'siege',
  'amphibious',
]);

/** Objectifs dont les cibles sont calculées ici (et non les provinces des pays visés). */
export const CUSTOM = new Set([
  'counteroffensive',
  'liberation',
  'encircle',
  'breakthrough',
  'siege',
  'amphibious',
  'raid',
]);

/** Frappes larges sur tout le pays visé (défenses sol-air en premier, partout). */
export const WIDE = new Set([
  'sead',
  'air_control',
  'attrition',
  'missile_campaign',
  'armed_recon',
  'interdiction',
]);

/** Installations logistiques (interdiction). */
const LOGISTICS: Partial<Record<BuildingType, number>> = {
  military_base: 3,
  forward_base: 3,
  port: 2,
  naval_base: 2,
  refinery: 2,
  oil_field: 1,
  recruiting_office: 1,
};

export function isLogistics(b: BuildingType): boolean {
  return LOGISTICS[b] !== undefined;
}

export function goalParam(def: OpGoalDef | null, key: string, d: number): number {
  const v = def?.params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function cityAt(state: EngineState, pid: ProvinceId): LngLat {
  return wi(state.world).provById.get(pid)!.cityPoint;
}

/** Propriétaire d'origine (scénario « monde actuel ») d'une province. */
export function origOwner(state: EngineState, pid: ProvinceId): NationId {
  return wi(state.world).provById.get(pid)?.nationId ?? '';
}

function neighbors(state: EngineState, pid: ProvinceId): readonly ProvinceId[] {
  return wi(state.world).provById.get(pid)?.neighbors ?? [];
}

export function capitalOf(state: EngineState, o: NationId): ProvinceId | null {
  return wi(state.world).nationById.get(o)?.capitalProvinceId ?? null;
}

/** Alliés de la nation (même alliance). */
export function alliesOf(state: EngineState, n: NationId): NationId[] {
  const id = board(state).allianceOf[n];
  if (!id) return [];
  return sortedKeys(board(state).allianceOf).filter(
    (x) => x !== n && board(state).allianceOf[x] === id && state.nations[x]?.alive,
  );
}

/** Provinces de la nation qui bordent l'une des nations données. */
export function borderWith(state: EngineState, n: NationId, foes: Set<NationId>): ProvinceId[] {
  return provincesOf(state, n).filter((p) =>
    neighbors(state, p).some((x) => {
      const o = state.provinces[x]?.owner;
      return !!o && o !== n && foes.has(o);
    }),
  );
}

/** Province à soi la plus proche d'un point. */
export function nearestOwn(state: EngineState, n: NationId, at: LngLat): ProvinceId | null {
  let best: ProvinceId | null = null;
  let bd = Infinity;
  for (const q of provincesOf(state, n)) {
    const d = distanceKm(cityAt(state, q), at);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** Plus court chemin (provinces) d'une de ses provinces vers `to`, à travers les provinces `ok`. */
function pathTo(
  state: EngineState,
  n: NationId,
  to: ProvinceId,
  ok: (p: ProvinceId) => boolean,
): ProvinceId[] {
  const prev = new Map<ProvinceId, ProvinceId | null>();
  const queue: ProvinceId[] = [];
  for (const p of provincesOf(state, n))
    for (const x of neighbors(state, p))
      if (ok(x) && !prev.has(x)) {
        prev.set(x, null);
        queue.push(x);
      }
  queue.sort();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (p === to) break;
    for (const x of [...neighbors(state, p)].sort())
      if (ok(x) && !prev.has(x)) {
        prev.set(x, p);
        queue.push(x);
      }
  }
  if (!prev.has(to)) return [];
  const out: ProvinceId[] = [];
  for (let p: ProvinceId | null = to; p; p = prev.get(p) ?? null) out.unshift(p);
  return out;
}

/** Profondeur (sauts) des provinces d'une nation depuis la frontière d'une autre (BFS). */
function depthFrom(state: EngineState, n: NationId, o: NationId): Map<ProvinceId, number> {
  const out = new Map<ProvinceId, number>();
  const queue: ProvinceId[] = [];
  for (const p of provincesOf(state, o))
    if (neighbors(state, p).some((x) => state.provinces[x]?.owner === n)) {
      out.set(p, 1);
      queue.push(p);
    }
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const x of [...neighbors(state, p)].sort())
      if (state.provinces[x]?.owner === o && !out.has(x)) {
        out.set(x, out.get(p)! + 1);
        queue.push(x);
      }
  }
  return out;
}

// ——— Cibles d'une phase ———

/**
 * Cibles d'un objectif ajouté : provinces à prendre et données propres (lignes, anneau, axe, sites).
 * Appelé au lancement, au changement d'objectif et à chaque nouvelle phase.
 */
export function setupGoal(state: EngineState, op: OpSt, def: OpGoalDef | null): void {
  const n = op.owner;
  const gd: NonNullable<OpSt['gd']> = {};
  op.gd = gd;
  op.cnt = { ic0: statOf(state, n).intercepted };
  const foes = new Set(op.nations);
  const alive = (o: NationId) => !!state.nations[o]?.alive;
  switch (op.goal) {
    case 'counteroffensive': {
      // Ses provinces d'origine tenues par un autre (les pays désignés seulement, s'il y en a).
      const out: ProvinceId[] = [];
      for (const p of Object.keys(state.provinces).sort()) {
        const o = state.provinces[p]!.owner;
        if (o === n || origOwner(state, p) !== n || !alive(o)) continue;
        if (foes.size && !foes.has(o)) continue;
        out.push(p);
      }
      op.targets = out;
      break;
    }
    case 'liberation': {
      gd.allies = [...op.nations].sort();
      const allies = new Set(op.nations);
      const out: ProvinceId[] = [];
      for (const p of Object.keys(state.provinces).sort()) {
        const o = state.provinces[p]!.owner;
        if (!allies.has(origOwner(state, p)) || allies.has(o) || o === n) continue;
        out.push(p);
      }
      op.targets = out;
      break;
    }
    case 'encircle': {
      // Poche : provinces désignées, sinon la bande ennemie au contact (et ses voisines).
      let pocket = (op.provinces ?? []).filter((p) => state.provinces[p]?.owner !== n);
      if (!pocket.length) {
        const set = new Set<ProvinceId>();
        for (const o of op.nations)
          for (const p of provincesOf(state, o))
            if (neighbors(state, p).some((x) => state.provinces[x]?.owner === n)) set.add(p);
        pocket = [...set].sort();
      }
      const inPocket = new Set(pocket);
      // Goulot : provinces de la poche qui la relient au reste du territoire ennemi.
      gd.neck = pocket.filter((p) => {
        const o = state.provinces[p]!.owner;
        return neighbors(state, p).some((x) => !inPocket.has(x) && state.provinces[x]?.owner === o);
      });
      op.targets = pocket.sort();
      break;
    }
    case 'breakthrough': {
      const depth = Math.max(1, Math.round(goalParam(def, 'depth', 4)));
      const enemy = (p: ProvinceId) => {
        const o = state.provinces[p]?.owner;
        return !!o && o !== n && (foes.size ? foes.has(o) : atWar(state, n, o));
      };
      const aim =
        (op.provinces ?? []).find(enemy) ??
        op.nations.map((o) => capitalOf(state, o)).find((p): p is ProvinceId => !!p && enemy(p));
      let axis = aim ? pathTo(state, n, aim, enemy) : [];
      if (!axis.length && aim) axis = [aim];
      gd.axis = axis.slice(0, depth);
      op.targets = [...gd.axis];
      break;
    }
    case 'siege': {
      const city =
        (op.provinces ?? []).find((p) => state.provinces[p]?.owner !== n) ??
        op.nations.map((o) => capitalOf(state, o)).find((p): p is ProvinceId => !!p) ??
        null;
      if (!city) {
        op.targets = [];
        break;
      }
      gd.city = city;
      const owner = state.provinces[city]!.owner;
      gd.ring = [...neighbors(state, city)]
        .filter((x) => {
          const o = state.provinces[x]?.owner;
          return !!o && o !== n && (o === owner || foes.has(o));
        })
        .sort();
      op.targets = [...gd.ring, city].sort();
      break;
    }
    case 'amphibious': {
      // Côte ou île désignée ; sinon les provinces côtières du pays visé les plus proches de ses ports.
      let out = (op.provinces ?? []).filter((p) => state.provinces[p]?.owner !== n);
      if (!out.length) {
        const ports = portsOf(state, n).map((p) => cityAt(state, p));
        const coast: { p: ProvinceId; d: number }[] = [];
        for (const o of op.nations)
          for (const p of provincesOf(state, o)) {
            if (!wi(state.world).seaSpawn.get(p)) continue;
            const at = cityAt(state, p);
            let d = Infinity;
            for (const q of ports) d = Math.min(d, distanceKm(q, at));
            coast.push({ p, d });
          }
        coast.sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : 1));
        out = coast.slice(0, Math.max(1, Math.round(goalParam(def, 'beaches', 2)))).map((x) => x.p);
      }
      op.targets = out.sort();
      break;
    }
    case 'raid': {
      // Arrière : provinces à au moins deux sauts de sa frontière, les mieux dotées en installations.
      const k = Math.max(1, Math.round(goalParam(def, 'targets', 4)));
      const cands: { p: ProvinceId; score: number }[] = [];
      for (const o of op.nations) {
        const depth = depthFrom(state, n, o);
        for (const [p, d] of depth) {
          let score = 0;
          for (const b of buildingsOf(state, p))
            score += LOGISTICS[b] ?? (b === 'air_base' || b === 'arms_factory' ? 2 : 0);
          if (score <= 0) continue;
          cands.push({ p, score: score * (d >= 2 ? 1 : 0.3) });
        }
      }
      cands.sort((a, b) => b.score - a.score || (a.p < b.p ? -1 : 1));
      gd.rear = cands.slice(0, k).map((x) => x.p);
      gd.withdrawAt = state.time + goalParam(def, 'hours', 24) * HOUR;
      op.targets = [...gd.rear];
      break;
    }
    case 'defense_depth': {
      const enemies = new Set(op.nations.length ? op.nations : warsOf(state, n));
      if (!enemies.size)
        for (const p of provincesOf(state, n))
          for (const x of neighbors(state, p)) {
            const o = state.provinces[x]?.owner;
            if (o && o !== n) enemies.add(o);
          }
      const lines: ProvinceId[][] = [];
      const seen = new Set<ProvinceId>();
      let cur = borderWith(state, n, enemies);
      const max = Math.max(1, Math.round(goalParam(def, 'lines', 3)));
      while (cur.length && lines.length < max) {
        for (const p of cur) seen.add(p);
        lines.push(cur);
        const next = new Set<ProvinceId>();
        for (const p of cur)
          for (const x of neighbors(state, p))
            if (!seen.has(x) && state.provinces[x]?.owner === n) next.add(x);
        cur = [...next].sort();
      }
      gd.lines = lines;
      break;
    }
    case 'defend_capital': {
      const cap = capitalOf(state, n);
      gd.sites = cap
        ? [cap, ...[...neighbors(state, cap)].filter((x) => state.provinces[x]?.owner === n).sort()]
        : [];
      break;
    }
    case 'show_of_force': {
      gd.sites = borderWith(state, n, foes);
      break;
    }
    case 'missile_shield':
    case 'air_defense_territory': {
      const cap = capitalOf(state, n);
      const w = wi(state.world);
      const k = Math.max(1, Math.round(goalParam(def, 'sites', 6)));
      const sites = provincesOf(state, n)
        .filter(
          (p) =>
            p === cap ||
            buildingsOf(state, p).some(
              (b) => b === 'air_base' || b === 'military_base' || b === 'naval_base',
            ),
        )
        .sort(
          (x, y) =>
            Number(y === cap) - Number(x === cap) ||
            w.provById.get(y)!.income.money - w.provById.get(x)!.income.money ||
            (x < y ? -1 : 1),
        );
      gd.sites = sites.slice(0, k);
      break;
    }
    case 'air_redeploy': {
      const pts = [
        ...(op.provinces ?? []).map((p) => cityAt(state, p)),
        ...op.nations.flatMap((o) => {
          const c = capitalOf(state, o);
          return c ? [cityAt(state, c)] : [];
        }),
      ];
      const aim = pts[0];
      gd.fields = aim
        ? airfieldsOf(state, n)
            .map((p) => ({ p, d: distanceKm(cityAt(state, p), aim) }))
            .sort((a, b) => a.d - b.d || (a.p < b.p ? -1 : 1))
            .slice(0, 3)
            .map((x) => x.p)
        : [];
      break;
    }
    case 'ally_support': {
      gd.allies = [...op.nations].sort();
      gd.sites = op.nations.flatMap((o) => provincesOf(state, o)).sort();
      break;
    }
  }
}

// ——— Mesures ———

/** Provinces conquises (d'origine étrangère) ou agitées, à pacifier. */
export function pacifySites(state: EngineState, n: NationId): ProvinceId[] {
  const unrest = ds(state).unrest ?? {};
  return provincesOf(state, n).filter((p) => origOwner(state, p) !== n || (unrest[p] ?? 0) >= 10);
}

/** Une province a-t-elle une garnison terrestre (pile à soi au contact de la ville) ? */
function garrisoned(state: EngineState, n: NationId, pid: ProvinceId, mine: Unit[]): boolean {
  const at = cityAt(state, pid);
  const gc = Math.max(state.world.balance.combat.groundContactKm, CAPTURE_RADIUS_KM);
  return mine.some((u) => distanceKm(unitPosAt(state, u, state.time), at) <= gc);
}

/** Ennemis terrestres (en guerre) à moins de `km` d'un point. */
function hostileNear(state: EngineState, n: NationId, at: LngLat, km: number): boolean {
  const known = state.know[n];
  if (!known) return false;
  for (const id of sortedKeys(known)) {
    const k = known[id]!;
    const u = state.units[id];
    if (!k.seen || !u || u.off || u.role || !atWar(state, n, u.owner)) continue;
    if (sysOf(state, u).movement !== 'land') continue;
    if (distanceKm(unitPosAt(state, u, state.time), at) <= km) return true;
  }
  return false;
}

/** Piles terrestres de combat d'une opération. */
function opGround(state: EngineState, op: OpSt): Unit[] {
  const c = cmd(state);
  const out: Unit[] = [];
  for (const id of op.armies)
    for (const u of c.armies[id]?.units ?? []) {
      const x = state.units[u];
      if (!x || x.off) continue;
      const s = sysOf(state, x);
      if (s.movement === 'land' && s.speedKmh > 0 && s.category !== 'air_defense') out.push(x);
    }
  return out;
}

/** Points à couvrir par le parapluie de DCA : objectifs en cours des offensives de la nation. */
export function umbrellaAims(state: EngineState, op: OpSt): LngLat[] {
  const c = cmd(state);
  const out: LngLat[] = [];
  for (const id of Object.keys(c.ops ?? {}).sort()) {
    const o = c.ops![id]!;
    if (o.owner !== op.owner || o.id === op.id || o.status === 'success' || o.status === 'failed')
      continue;
    for (const p of o.focus ?? []) if (out.length < 8) out.push(p);
  }
  for (const id of Object.keys(c.armies).sort()) {
    const a = c.armies[id]!;
    if (a.owner !== op.owner || a.op || !a.mission || a.status !== 'active') continue;
    for (const p of a.aims) if (out.length < 8) out.push(p);
  }
  return out;
}

/** Une défense sol-air de la nation couvre-t-elle ce point (pile au sol à portée) ? */
export function adCovers(state: EngineState, n: NationId, at: LngLat, ads: Unit[]): boolean {
  return ads.some((u) => {
    const s = sysOf(state, u);
    return distanceKm(unitPosAt(state, u, state.time), at) <= Math.max(30, s.weaponRangeKm.max);
  });
}

/** Défenses sol-air (au sol) des armées d'une opération. */
function opAds(state: EngineState, op: OpSt): Unit[] {
  const c = cmd(state);
  const out: Unit[] = [];
  for (const id of op.armies)
    for (const u of c.armies[id]?.units ?? []) {
      const x = state.units[u];
      if (!x || x.off) continue;
      const s = sysOf(state, x);
      if (s.movement === 'land' && s.category === 'air_defense') out.push(x);
    }
  return out;
}

/**
 * Mesures d'un objectif ajouté (`add` : mesure affichée) ; renvoie la part de la mesure principale
 * (0 à 1), ou null pour un objectif d'origine.
 */
export function measureGoal(
  state: EngineState,
  op: OpSt,
  I: { ships: { u: Unit }[]; blds: { pid: ProvinceId; b: BuildingType; kind: string }[] },
  add: (key: OpMetric, done: number, total: number) => void,
): number | null {
  const n = op.owner;
  const gd = op.gd ?? {};
  const mine = (p: ProvinceId) => state.provinces[p]?.owner === n;
  const share = (d: number, t: number, empty = 0) => (t > 0 ? d / t : empty);
  const killed = op.kills ?? 0;
  switch (op.goal) {
    case 'counteroffensive': {
      const done = op.targets.filter(mine).length;
      add('retaken', done, op.targets.length);
      add('forces', killed, op.base.enemy);
      return share(done, op.targets.length);
    }
    case 'liberation': {
      const allies = new Set(gd.allies ?? []);
      const done = op.targets.filter((p) => {
        const o = state.provinces[p]?.owner;
        return o === n || (!!o && allies.has(o));
      }).length;
      add('liberated', done, op.targets.length);
      add('forces', killed, op.base.enemy);
      return share(done, op.targets.length);
    }
    case 'encircle': {
      const neck = gd.neck ?? [];
      add('neck', neck.filter(mine).length, neck.length);
      const done = op.targets.filter(mine).length;
      add('provinces', done, op.targets.length);
      return share(done, op.targets.length);
    }
    case 'breakthrough': {
      const axis = gd.axis ?? [];
      const done = axis.filter(mine).length;
      add('depth', done, axis.length);
      add('forces', killed, op.base.enemy);
      return share(done, axis.length);
    }
    case 'siege': {
      const ring = gd.ring ?? [];
      add('ring', ring.filter(mine).length, ring.length);
      const city = gd.city && mine(gd.city) ? 1 : 0;
      add('city', city, gd.city ? 1 : 0);
      return city;
    }
    case 'amphibious': {
      const done = op.targets.filter(mine).length;
      add('provinces', done, op.targets.length);
      return share(done, op.targets.length);
    }
    case 'raid': {
      const rear = new Set(gd.rear ?? []);
      const known = op.seen.bld.filter((k) => rear.has(k.split(':')[0]!));
      const down = known.filter((k) => {
        const [pid, b] = k.split(':') as [ProvinceId, BuildingType];
        return bldHealth(state, pid, b) <= 0 || mine(pid);
      }).length;
      const taken = [...rear].filter(mine).length;
      add('raids', down + taken, known.length + rear.size);
      const ground = opGround(state, op);
      const home = ground.filter((u) => {
        const pid = wi(state.world).nav.cellProv.get(
          wi(state.world).nav.cellOfPos(unitPosAt(state, u, state.time)),
        );
        return !!pid && mine(pid) && !rear.has(pid);
      }).length;
      add('withdrawn', home, ground.length);
      const struck = share(down + taken, known.length + rear.size);
      // Réussite : arrière frappé, puis forces terrestres rentrées.
      if (op.phase !== 'withdraw') return Math.min(0.5, struck / 2);
      return 0.5 + 0.5 * share(home, ground.length, 1);
    }
    case 'defense_depth': {
      const lines = gd.lines ?? [];
      let held = 0;
      let total = 0;
      for (const l of lines) {
        held += l.filter(mine).length;
        total += l.length;
      }
      add('lines', held, total);
      add('forces', killed, op.base.enemy);
      return share(held, total, 1);
    }
    case 'defend_capital': {
      const sites = gd.sites ?? [];
      const cap = sites[0];
      add('capital', cap && mine(cap) ? 1 : 0, cap ? 1 : 0);
      add('ring', sites.slice(1).filter(mine).length, Math.max(0, sites.length - 1));
      return share(sites.filter(mine).length, sites.length, 1);
    }
    case 'pacify': {
      const sites = pacifySites(state, n);
      const ground = opGround(state, op);
      const huntKm = goalParam(cmdBal(state).operations.goals[op.goal] ?? null, 'huntKm', 120);
      const ok = sites.filter(
        (p) =>
          garrisoned(state, n, p, ground) && !hostileNear(state, n, cityAt(state, p), huntKm / 2),
      ).length;
      add('secured', ok, sites.length);
      return share(ok, sites.length, 1);
    }
    case 'show_of_force': {
      const sites = (gd.sites ?? []).filter(mine);
      const def = cmdBal(state).operations.goals[op.goal] ?? null;
      const km = goalParam(def, 'borderKm', 120);
      const ground = opGround(state, op);
      const at = ground.filter((u) =>
        sites.some((p) => distanceKm(unitPosAt(state, u, state.time), cityAt(state, p)) <= km),
      ).length;
      add('deployed', at, ground.length);
      add('front', sites.filter((p) => garrisoned(state, n, p, ground)).length, sites.length);
      return share(at, ground.length);
    }
    case 'interdiction': {
      const known = op.seen.bld;
      const down = known.filter((k) => {
        const [pid, b] = k.split(':') as [ProvinceId, BuildingType];
        return bldHealth(state, pid, b) <= 0 || mine(pid);
      }).length;
      add('logistics', down, known.length);
      add('moving', op.cnt?.moving ?? 0, Math.max(op.cnt?.moving ?? 0, op.cnt?.movingSeen ?? 0));
      add('forces', killed, op.base.enemy);
      return share(down, known.length);
    }
    case 'cas': {
      add('forces', killed, op.base.enemy);
      return share(killed, op.base.enemy);
    }
    case 'strategic_bombing':
    case 'naval_strikes':
    case 'missile_campaign': {
      const known = op.seen.bld;
      const down = known.filter((k) => {
        const [pid, b] = k.split(':') as [ProvinceId, BuildingType];
        return bldHealth(state, pid, b) <= 0 || mine(pid);
      }).length;
      if (op.goal === 'missile_campaign') {
        const sams = op.seen.sams.filter((id) => {
          const u = state.units[id];
          return !u || u.off || u.owner === n;
        }).length;
        add('targets', down + sams, known.length + op.seen.sams.length);
        add('forces', killed, op.base.enemy);
        return share(down + sams, known.length + op.seen.sams.length);
      }
      add('buildings', down, known.length);
      add('forces', killed, op.base.enemy);
      return share(down, known.length);
    }
    case 'air_defense_territory': {
      add('aircraft', op.cnt?.downed ?? 0, Math.max(op.cnt?.downed ?? 0, op.seen.air.length));
      add('sites', (gd.sites ?? []).filter(mine).length, (gd.sites ?? []).length);
      const seen = Math.max(op.cnt?.downed ?? 0, op.seen.air.length);
      return seen > 0 ? Math.min(1, (op.cnt?.downed ?? 0) / seen) : 1;
    }
    case 'air_redeploy': {
      const c = cmd(state);
      const fields = (gd.fields ?? []).filter(mine);
      let total = 0;
      let done = 0;
      const ms = mil(state).ms;
      for (const id of op.armies)
        for (const u of c.armies[id]?.units ?? []) {
          const x = state.units[u];
          if (!x || sysOf(state, x).movement !== 'air' || !ms[u]) continue;
          total++;
          if (ms[u]!.base && fields.includes(ms[u]!.base!)) done++;
        }
      add('rebased', done, total);
      return share(done, total);
    }
    case 'armed_recon': {
      const provs = op.nations.flatMap((o) => provincesOf(state, o));
      const seen = provs.filter((p) => {
        const k = knowledge(state, n, p);
        return !!k && (k.m > 0 || k.e > 0);
      }).length;
      add('revealed', seen, provs.length);
      add('forces', killed, op.base.enemy);
      return share(seen, provs.length);
    }
    case 'naval_supremacy':
    case 'antiship': {
      const list = op.ships ?? [];
      const sunk = list.filter((id) => {
        const u = state.units[id];
        return !u || u.off || u.owner === n;
      }).length;
      add('ships', sunk, list.length);
      add('ports', blockedFor(state, op), portsCount(state, op));
      return share(sunk, list.length);
    }
    case 'convoy_escort': {
      const c = cmd(state);
      const ms = mil(state).ms;
      let total = 0;
      let done = 0;
      const ships: Unit[] = [];
      for (const id of op.armies)
        for (const u of c.armies[id]?.units ?? []) {
          const x = state.units[u];
          if (x && !x.off && sysOf(state, x).movement === 'sea') ships.push(x);
        }
      for (const id of sortedKeys(state.units)) {
        const u = state.units[id]!;
        if (u.owner !== n || !hasCargo(state, id)) continue;
        total++;
        if (ships.some((s) => ms[s.id]?.mis === 'escort' && s.target === id)) done++;
      }
      add('escorted', done, total);
      return share(done, total, 1);
    }
    case 'port_blockade': {
      const k = blockedFor(state, op);
      add('ports', k, op.base.ports);
      return share(k, op.base.ports);
    }
    case 'missile_shield': {
      const ads = opAds(state, op);
      const sites = (gd.sites ?? []).filter(mine);
      const covered = sites.filter((p) => adCovers(state, n, cityAt(state, p), ads)).length;
      add('sites', covered, sites.length);
      add('intercepts', statOf(state, n).intercepted - (op.cnt?.ic0 ?? 0), 0);
      return share(covered, sites.length, 1);
    }
    case 'ad_umbrella': {
      const aims = umbrellaAims(state, op);
      const ads = opAds(state, op);
      const covered = aims.filter((p) => adCovers(state, n, p, ads)).length;
      add('covered', covered, aims.length);
      return share(covered, aims.length, 1);
    }
    case 'ally_support': {
      const allies = new Set(gd.allies ?? []);
      const sites = gd.sites ?? [];
      const held = sites.filter((p) => {
        const o = state.provinces[p]?.owner;
        return o === n || (!!o && allies.has(o));
      }).length;
      add('front', held, sites.length);
      add('forces', killed, op.base.enemy);
      return share(held, sites.length, 1);
    }
  }
  return null;
}

/** Ports des pays visés, et ceux tenus en blocus par la nation. */
function portsCount(state: EngineState, op: OpSt): number {
  let k = 0;
  for (const o of op.nations) k += portsOf(state, o).length;
  return k;
}

function blockedFor(state: EngineState, op: OpSt): number {
  const blk = mil(state).blk;
  const ports = new Set<string>();
  for (const o of op.nations) for (const p of portsOf(state, o)) ports.add(p);
  const done = new Set<string>();
  for (const id of sortedKeys(blk)) {
    const b = blk[id]!;
    if (b.by !== op.owner || !('provinceId' in b.target)) continue;
    if (ports.has(b.target.provinceId)) done.add(b.target.provinceId);
  }
  return done.size;
}

/** Objectif de durée (ajouté) atteint et tenu ? null : objectif d'origine. */
export function holdingGoal(state: EngineState, op: OpSt, def: OpGoalDef | null): boolean | null {
  const ok = op.pct >= (def?.success ?? 1) - 1e-9;
  switch (op.goal) {
    case 'defense_depth':
    case 'defend_capital':
    case 'pacify':
    case 'show_of_force':
    case 'missile_shield':
    case 'ad_umbrella':
    case 'convoy_escort':
    case 'ally_support':
    case 'air_defense_territory':
      return ok && state.time >= op.stageUntil;
    case 'cas':
      return (op.kills ?? 0) > 0 && ok;
    case 'strategic_bombing':
    case 'antiship':
      return op.prog[0]!.total > 0 && ok;
    case 'port_blockade':
      return op.base.ports > 0 && ok;
  }
  return null;
}

/** Contacts navals suivis (supériorité navale, guerre anti-navires). */
export function trackShips(op: OpSt, ids: string[]): void {
  if (op.goal !== 'naval_supremacy' && op.goal !== 'antiship') return;
  const list = (op.ships ??= []);
  for (const id of ids) if (!list.includes(id) && list.length < 400) list.push(id);
}

/** Aéronef ou munition abattu par la nation : compteurs des opérations de défense. */
export function goalKill(state: EngineState, u: Unit, killer: Unit | null): void {
  const ops = cmd(state).ops;
  if (!ops || !killer) return;
  const air = !u.role && sysOf(state, u).movement === 'air';
  if (!air) return;
  for (const id of sortedKeys(ops)) {
    const op = ops[id]!;
    if (op.owner !== killer.owner || op.goal !== 'air_defense_territory') continue;
    if (op.status === 'success' || op.status === 'failed') continue;
    op.cnt ??= {};
    op.cnt.downed = (op.cnt.downed ?? 0) + 1;
  }
}
