import { distanceKm, type NationId, type Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { retireUnit } from '../../combat/combat.js';
import { refreshUnitPairs } from '../../encounters/pairs.js';
import { zoneKm } from '../../encounters/profile.js';
import { sysOf } from '../../state/access.js';
import { addToIndex, removeFromIndex } from '../../state/runtime.js';
import { mixClassOf, partsOf, rawParts, setParts, stackBal } from '../../state/stack.js';
import type { EngineState, StackPart, Unit } from '../../state/types.js';
import { spawnStack } from '../../state/units.js';
import { armFuel, newMission } from './air.js';
import { mil, milBal } from './state.js';
import { OK, fail, posOf, resolveOwn } from './util.js';

/**
 * Ordres de piles (journalisés comme tout ordre, donc rejoués à l'identique) :
 *  - `split` : détacher `count` éléments (pile mixte : au prorata de chaque matériel), des éléments
 *    précis par matériel (`parts`), diviser en deux (`mode: 'half'`) ou une pile par matériel
 *    (`mode: 'type'`, le matériel principal reste dans la pile d'origine). Les nouvelles piles tiennent
 *    la position, gardent posture, expérience, mission aérienne et général. La santé est conservée :
 *    PV totaux identiques, même rapport PV / PV des éléments vivants dans chaque pile ;
 *  - `merge` : réunir des piles à l'arrêt, à moins de `stacks.mergeKm`, du même matériel (toujours
 *    possible) ou de matériels d'une même classe de fusion (`stacks.classes`, pile mixte). PV, effectifs
 *    et expérience (moyenne pondérée par l'effectif) s'additionnent ; carburant le plus bas,
 *    disponibilité la plus tardive. Refusé pour un aéronef en vol (pile mixte) et les unités fixes.
 */

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Répartition de N éléments au prorata des effectifs (plus forts restes, puis ordre). */
export function proportional(cs: number[], N: number): number[] {
  const C = sum(cs);
  if (N <= 0 || C <= 0) return cs.map(() => 0);
  const exact = cs.map((c) => (c * Math.min(N, C)) / C);
  const out = exact.map((x) => Math.floor(x));
  let left = Math.min(N, C) - sum(out);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (out[i]! < cs[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

export function orderSplit(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'split' }>,
): OrderResult {
  const res = resolveOwn(state, n, [o.unitId], true);
  if (!Array.isArray(res)) return res;
  const u = res[0]!;
  const m = mil(state);
  if (m.fixedOf[u.id]) return fail('not_allowed', 'Unité fixe.');
  const kinds = (o.count !== undefined ? 1 : 0) + (o.parts ? 1 : 0) + (o.mode ? 1 : 0);
  if (kinds !== 1)
    return fail('invalid_target', 'Préciser un effectif, des matériels ou un mode de scission.');
  const cur = rawParts(u);
  const short = (): OrderResult => fail('invalid_target', 'Effectif insuffisant pour scinder.');
  let pieces: number[][];
  if (o.mode === 'type') {
    if (cur.length < 2) return fail('invalid_target', 'Un seul matériel : rien à séparer.');
    pieces = cur
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.sys !== u.sys)
      .map(({ i }) => cur.map((q, j) => (j === i ? q.c : 0)));
  } else {
    let take: number[];
    if (o.parts) {
      take = cur.map(() => 0);
      for (const q of o.parts) {
        const i = cur.findIndex((p) => p.sys === q.systemId);
        if (i < 0) return fail('invalid_target', `Matériel absent de la pile : ${q.systemId}.`);
        take[i]! += q.count;
        if (take[i]! > cur[i]!.c) return short();
      }
    } else {
      const N = o.mode === 'half' ? Math.floor(u.count / 2) : o.count!;
      if (N >= u.count) return short();
      take = proportional(
        cur.map((p) => p.c),
        N,
      );
    }
    const total = sum(take);
    if (total <= 0 || total >= u.count) return short();
    pieces = [take];
  }
  splitInto(state, u, cur, pieces);
  return OK;
}

/**
 * Grandeurs dont dépendent les paires d'une unité (zone indexée, portées, détection, furtivité,
 * brouillage, classe de cible) : si elles ne changent pas, ses paires restent valables.
 */
function pairProfile(state: EngineState, u: Unit): string {
  const s = sysOf(state, u);
  const sn = s.sensor;
  return [
    u.sys,
    zoneKm(state, u),
    s.weaponRangeKm.min,
    s.weaponRangeKm.max,
    s.detectionRangeKm,
    s.stealth,
    s.ew.jamming,
    s.targetClass,
    sn ? `${sn.kind}:${sn.rangeKm}:${sn.stealthDetect}` : '',
    s.naval?.asw ?? 0,
  ].join('|');
}

/** Index des brouilleurs après un changement de composition (brouillage = meilleur élément). */
function syncJammer(state: EngineState, u: Unit): void {
  if (sysOf(state, u).ew.jamming > 0) addToIndex(state.rt.jammers, u.owner, u.id);
  else removeFromIndex(state.rt.jammers, u.owner, u.id);
}

/** Détache des piles (`pieces` : éléments pris à chaque matériel de `cur`, par nouvelle pile). */
function splitInto(state: EngineState, u: Unit, cur: StackPart[], pieces: number[][]): Unit[] {
  const m = mil(state);
  const hpOf = (sys: string): number => state.world.catalog.get(sys)!.hp;
  // Santé des éléments vivants (≤ 1) : conservée dans chaque pile, donc PV totaux conservés.
  let alive = 0;
  for (const p of cur) alive += p.c * hpOf(p.sys);
  const rho = alive > 0 ? Math.min(1, u.hp / alive) : 1;
  const left = cur.map((p) => p.c);
  for (const take of pieces) for (let i = 0; i < take.length; i++) left[i]! -= take[i]!;
  const pos = posOf(state, u);
  const src = m.ms[u.id];
  const gid = m.unitGen[u.id];
  const created: Unit[] = [];
  const before = pairProfile(state, u);
  // Pile d'origine d'abord (ses invariants avant les apparitions, qui calculent des paires).
  setParts(
    u,
    cur.map((p, i) => ({ sys: p.sys, c: left[i]!, m: left[i]! * hpOf(p.sys) })),
  );
  u.hp = u.maxHp * rho;
  syncJammer(state, u);
  for (const take of pieces) {
    const parts = cur.map((p, i) => ({ sys: p.sys, count: take[i]! })).filter((p) => p.count > 0);
    const nu = spawnStack(state, u.owner, parts, pos, (x) => {
      x.stance = u.stance;
      x.xp = u.xp;
      x.hp = x.maxHp * rho;
      if (u.off) x.off = true;
    });
    if (src) {
      // La nouvelle pile garde base, carburant et embarquement ; elle tient sa position.
      const copy = newMission(src.fa);
      copy.bk = src.bk;
      copy.base = src.base;
      copy.up = src.up;
      copy.fuel = src.fuel;
      copy.ft = src.ft;
      copy.ready = src.ready;
      copy.give = src.give;
      copy.emb = src.emb;
      m.ms[nu.id] = copy;
      if (copy.fa && copy.up) armFuel(state, nu);
    }
    const g = gid ? m.gens[gid] : undefined;
    if (g && g.units.length < milBal(state).generals.maxUnits) {
      g.units = [...g.units, nu.id].sort();
      m.unitGen[nu.id] = g.id;
    }
    if (!nu.off) refreshUnitPairs(state, nu);
    state.rt.dirtyCombat.add(nu.id);
    created.push(nu);
  }
  // Portées, détection ou furtivité changées : paires de la pile d'origine recalculées.
  if (!u.off && pairProfile(state, u) !== before) refreshUnitPairs(state, u);
  state.rt.dirtyCombat.add(u.id);
  return created;
}

/** Les piles peuvent-elles être réunies ? null si oui, sinon le refus. */
export function mergeRefusal(state: EngineState, units: Unit[]): OrderResult | null {
  if (units.length < 2) return fail('invalid_target', 'Il faut au moins deux unités.');
  const m = mil(state);
  const sb = stackBal(state.world);
  const first = units[0]!;
  const p0 = posOf(state, first);
  const sameSys = units.every((u) => !u.mix && u.sys === first.sys);
  for (const u of units) {
    if (u.move) return fail('not_allowed', 'Les unités doivent être à l’arrêt.');
    if (!!u.off !== !!first.off) return fail('not_allowed', 'Unités embarquées et non embarquées.');
    if (distanceKm(posOf(state, u), p0) > sb.mergeKm)
      return fail('out_of_range', `Unités trop éloignées (${sb.mergeKm} km).`);
    if (m.fixedOf[u.id]) return fail('not_allowed', 'Unité fixe.');
  }
  if (sameSys) return null;
  let cls: string | null = null;
  const systems = new Set<string>();
  for (const u of units) {
    if (u.off) return fail('not_allowed', 'Unités embarquées : fusion du même type seulement.');
    if (m.ms[u.id]?.up) return fail('not_allowed', 'Aéronefs en vol : fusion au sol seulement.');
    for (const p of partsOf(state, u)) {
      const c = mixClassOf(state.world, p.sys);
      if (!c)
        return fail('invalid_target', `${p.sys.name} ne se mélange pas avec d’autres matériels.`);
      if (cls && c !== cls) return fail('invalid_target', 'Matériels de domaines différents.');
      cls = c;
      systems.add(p.sys.id);
    }
  }
  if (systems.size > sb.maxSystems)
    return fail('invalid_target', `Pas plus de ${sb.maxSystems} matériels par pile.`);
  return null;
}

export function orderMerge(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'merge' }>,
): OrderResult {
  const units = resolveOwn(state, n, o.unitIds, true);
  if (!Array.isArray(units)) return units;
  const refusal = mergeRefusal(state, units);
  if (refusal) return refusal;
  mergeUnits(state, units);
  return OK;
}

/** Réunit des piles (vérifiées par mergeRefusal) dans la première ; renvoie celle-ci. */
export function mergeUnits(state: EngineState, units: Unit[]): Unit {
  const m = mil(state);
  const first = units[0]!;
  const before = first.mix ? first.mix : first.sys;
  let hp = 0;
  let count = 0;
  let xp = 0;
  const parts: StackPart[] = [];
  for (const u of units) {
    hp += u.hp;
    count += u.count;
    xp += u.xp * u.count;
    parts.push(...rawParts(u));
  }
  const fuelMin = Math.min(...units.map((u) => m.ms[u.id]?.fuel ?? Infinity));
  const readyMax = Math.max(...units.map((u) => m.ms[u.id]?.ready ?? -Infinity));
  for (const u of units.slice(1)) retireUnit(state, u);
  setParts(first, parts);
  first.hp = hp;
  first.xp = xp / Math.max(1, count);
  syncJammer(state, first);
  const fm = m.ms[first.id];
  if (fm && Number.isFinite(fuelMin)) fm.fuel = Math.min(fm.fuel, fuelMin);
  if (fm && Number.isFinite(readyMax)) fm.ready = Math.max(fm.ready, readyMax);
  if ((first.mix || before !== first.sys) && !first.off) refreshUnitPairs(state, first);
  state.rt.dirtyCombat.add(first.id);
  return first;
}
