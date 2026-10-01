import { distanceKm, type LngLat, type NationId } from '@redline/shared';
import { mergeRefusal } from '../modules/mil/stack-orders.js';
import { mil } from '../modules/mil/state.js';
import { nationUnits, provincesOf, sysOf, unitPosAt, warsOf } from '../state/access.js';
import { mixClassOf, stackBal } from '../state/stack.js';
import type { EngineState, Unit } from '../state/types.js';
import { citiesNear } from '../state/cities.js';
import { wi } from '../state/world.js';
import { aiCfg, aiLevelCfg } from './config.js';
import { unitValue } from './estimate.js';
import { aiOrder } from './trace.js';

/**
 * Emploi des piles par l'IA (réglages `stacks.ai`), avant sa réflexion tactique :
 *  - en guerre, elle veut au moins « garnison de la capitale + warStacksPerGroup × taille de groupe »
 *    piles de manœuvre terrestres, et autant que le front l'exige : min(warStacksPerProvince ×
 *    ses provinces, warStacksPerEnemyProvince × provinces ennemies). En dessous, elle divise en deux
 *    ses piles à l'arrêt chez elle, les plus proches du front d'abord (une moitié tient la ville,
 *    l'autre part en garnison ou en offensive) ;
 *  - au-delà de `mergeAbove` fois ce nombre (en paix : `peaceStacksPerProvince` par province, plus
 *    une), elle refond ses piles voisines à l'arrêt (les unités produites rejoignent les brigades,
 *    les détachements revenus se reforment), ce qui garde peu d'unités à simuler.
 * Ordres ordinaires (`split`, `merge`) : mêmes règles qu'un joueur, rejeu identique.
 */
export function manageStacks(state: EngineState, n: NationId, atWarNow: boolean): void {
  const sb = stackBal(state.world).ai;
  let ops = sb.maxOpsPerThink;
  if (ops <= 0) return;
  const ns = state.nations[n]!;
  const L = aiLevelCfg(state, ns.aiLevel);
  // Piles de manœuvre terrestres (matériels mélangeables) : ni défense aérienne, ni radars, ni lanceurs.
  const land: Unit[] = [];
  for (const id of nationUnits(state, n)) {
    const u = state.units[id]!;
    if (u.off || u.role || mil(state).fixedOf[u.id]) continue;
    const s = sysOf(state, u);
    if (s.movement !== 'land' || s.speedKmh <= 0) continue;
    // Une pile mixte ne réunit que des matériels mélangeables.
    if (!u.mix && !mixClassOf(state.world, s)) continue;
    land.push(u);
  }
  const w = wi(state.world);
  const enemies = atWarNow ? warsOf(state, n) : [];
  let enemyProvs = 0;
  for (const e of enemies) enemyProvs += state.rt.provsOf.get(e)?.size ?? 0;
  const want = atWarNow
    ? Math.max(
        1,
        L.capitalGarrison + sb.warStacksPerGroup * Math.max(1, L.groupMax),
        Math.ceil(
          Math.min(
            sb.warStacksPerProvince * ns.provinceCount,
            sb.warStacksPerEnemyProvince * enemyProvs,
          ),
        ),
      )
    : Math.ceil(sb.peaceStacksPerProvince * ns.provinceCount) + 1;
  let count = land.length;
  if (atWarNow ? count >= want && count <= want * sb.mergeAbove : count <= want * sb.mergeAbove)
    return;
  const nav = w.nav;
  const home = (u: Unit): boolean => {
    const pid = nav.cellProv.get(nav.cellOfPos(unitPosAt(state, u, state.time)));
    return !!pid && state.provinces[pid]?.owner === n;
  };
  const idle = (u: Unit): boolean => !u.move && !u.target && !u.engaged && home(u);
  if (atWarNow && count < want) {
    const enemyCities: LngLat[] = [];
    for (const e of enemies)
      for (const pid of provincesOf(state, e)) enemyCities.push(w.provById.get(pid)!.cityPoint);
    // Les plus proches du front d'abord (à portée d'offensive), puis les plus fortes.
    const reach = aiCfg(state.world).tactical.attackReachKm;
    const front = (u: Unit): number => {
      const at = unitPosAt(state, u, state.time);
      let d = Infinity;
      for (const c of enemyCities) d = Math.min(d, distanceKm(at, c));
      return d;
    };
    const big = land
      .filter((u) => u.count >= sb.minSplitElements && idle(u))
      .map((u) => ({ u, d: Math.round(front(u)), v: unitValue(state, u) }))
      .filter((x) => x.d <= reach)
      .sort((a, b) => a.d - b.d || b.v - a.v || (a.u.id < b.u.id ? -1 : 1));
    for (const { u } of big) {
      if (count >= want || ops <= 0) break;
      if (aiOrder(state, n, { kind: 'split', unitId: u.id, mode: 'half' }).ok) count++;
      ops--;
    }
    return;
  }
  if (count <= want * sb.mergeAbove) return;
  const mergeKm = stackBal(state.world).mergeKm;
  // Garnison préservée : deux piles ne fusionnent que si elles gardent la même ville (ou aucune).
  const gc = state.world.balance.combat.groundContactKm;
  const cityKey = (u: Unit): string =>
    citiesNear(state.world, unitPosAt(state, u, state.time), gc)
      .map((c) => c.pid)
      .sort()
      .join(',');
  // En paix, regroupement une réflexion calme sur `peaceMergeEvery` (décalé par nation).
  if (!atWarNow) {
    const period = state.world.balance.time.aiThinkMinutes * 60_000;
    const every = aiCfg(state.world).strategy.tacticalEveryCalm * sb.peaceMergeEvery;
    const k = Math.round(state.time / period) + state.nationIds.indexOf(n);
    if (every > 1 && k % every !== 0) return;
  }
  const cands = land.filter(idle).sort((a, b) => (a.id < b.id ? -1 : 1));
  const used = new Set<string>();
  for (const a of cands) {
    if (ops <= 0 || count <= want * sb.mergeAbove) break;
    if (used.has(a.id) || !state.units[a.id]) continue;
    const pa = unitPosAt(state, a, state.time);
    const b = cands.find(
      (x) =>
        x !== a &&
        !used.has(x.id) &&
        !!state.units[x.id] &&
        distanceKm(unitPosAt(state, x, state.time), pa) <= mergeKm &&
        cityKey(x) === cityKey(a) &&
        mergeRefusal(state, [a, x]) === null,
    );
    if (!b) continue;
    used.add(a.id);
    used.add(b.id);
    ops--;
    if (aiOrder(state, n, { kind: 'merge', unitIds: [a.id, b.id] }).ok) count--;
  }
}

/**
 * Nombre d'unités « équivalentes » d'une nation pour ses plafonds de production : une pile mixte
 * compte pour autant de piles qu'elle réunit de matériels (une pile par matériel avant le
 * regroupement) ; une pile simple compte pour une.
 */
export function stackEquivalents(state: EngineState, n: NationId): number {
  let k = 0;
  for (const id of state.rt.byNation.get(n) ?? []) k += state.units[id]?.mix?.length ?? 1;
  return k;
}
