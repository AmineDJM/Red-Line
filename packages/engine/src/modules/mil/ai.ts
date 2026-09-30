import {
  distanceKm,
  type LngLat,
  type NationId,
  type Order,
  type StrikeTarget,
} from '@redline/shared';
import { isLauncher, isRadarSensor, targetClassOf } from '../../encounters/profile.js';
import { applyOrderImpl } from '../../orders/orders.js';
import { sortedKeys, sortedSet, sysOf, warsOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { airFeasible, msOf } from './air.js';
import { mil } from './state.js';
import { cellsLeft } from './strike.js';
import {
  buildingsOf,
  cityOf,
  isAew,
  isFuelAir,
  isRecon,
  isTanker,
  launchCells,
  posOf,
  strikeRangeKm,
} from './util.js';

/**
 * IA de combat (crochet aiThink, nations tenues par l'IA et en guerre seulement). Elle ne triche pas :
 * elle ne vise que ce que sa nation voit (contacts observés) et les bâtiments publics de la carte.
 *  - Défense aérienne : une patrouille de chasse au-dessus de la capitale (deux en 'hard'), un avion
 *    radar en orbite s'il y en a ; les défenses sol-air interceptent automatiquement.
 *  - 'normal' et 'hard' : salves de missiles sur les menaces vues (défense aérienne et radars d'abord,
 *    puis concentrations), sinon sur les bases ennemies à portée ; frappes aériennes sur les unités
 *    ennemies vues sur son territoire ou près de ses villes.
 *  - Jamais de nucléaire (décision réservée aux joueurs humains).
 */

const AI = {
  capRadiusKm: 250,
  salvosPerThink: { easy: 0, normal: 1, hard: 2 },
  airStrikesPerThink: { easy: 0, normal: 1, hard: 2 },
  caps: { easy: 1, normal: 1, hard: 2 },
  /** Munitions tirées par salve (les stocks sont consommés). */
  salvoSize: { easy: 2, normal: 4, hard: 8 },
};

function order(state: EngineState, n: NationId, o: Order): boolean {
  return applyOrderImpl(state, n, o).ok;
}

export function combatAi(state: EngineState, n: NationId): void {
  if (!state.rt.enemies.get(n)?.size) return;
  // Réactive : rien à faire tant qu'aucun ennemi n'est observé (coût nul pour les guerres dormantes).
  const { threats, air } = visibleEnemies(state, n);
  if (threats.length === 0 && !air) return;
  const ns = state.nations[n]!;
  const level = ns.aiLevel;
  const units = sortedSet(state.rt.byNation.get(n))
    .map((id) => state.units[id]!)
    .filter((u) => !u.role);
  const w = wi(state.world);
  const capId = w.nationById.get(n)?.capitalProvinceId;
  const capital =
    capId && state.provinces[capId]?.owner === n ? w.provById.get(capId)!.cityPoint : null;

  // 1. Menace aérienne (avions, drones, missiles) : chasse et avion radar au-dessus de la capitale.
  if (capital && air) {
    const ms = mil(state).ms;
    const onCap = units.filter(
      (u) => ms[u.id]?.mis === 'patrol' && sysOf(state, u).movement === 'air',
    ).length;
    let want = AI.caps[level] - onCap;
    for (const u of units) {
      if (want <= 0) break;
      const s = sysOf(state, u);
      const m = msOf(state, u);
      if (!isFuelAir(s) || !m || m.up || m.ready > state.time) continue;
      if (isTanker(s) || isAew(s) || isRecon(s) || s.damage.aircraft <= 0) continue;
      if (
        order(state, n, { kind: 'patrol', unitIds: [u.id], at: capital, radiusKm: AI.capRadiusKm })
      )
        want--;
    }
    const aew = units.find((u) => {
      const m = msOf(state, u);
      return isAew(sysOf(state, u)) && m?.mis === 'awacs';
    });
    if (!aew) {
      for (const u of units) {
        const m = msOf(state, u);
        if (!isAew(sysOf(state, u)) || !m || m.up || m.ready > state.time) continue;
        if (order(state, n, { kind: 'patrol', unitIds: [u.id], at: capital, radiusKm: 100 })) break;
      }
    }
  }
  if (level === 'easy') return;

  // 2. Salves de missiles.
  let salvos = AI.salvosPerThink[level];
  let tries = 6;
  for (const u of units) {
    if (salvos <= 0 || tries <= 0) break;
    const s = sysOf(state, u);
    const isShip = s.movement === 'sea' && launchCells(s) > 0 && cellsLeft(state, u) > 0;
    if (!isLauncher(s) && !isShip) continue;
    if (s.missile?.warhead === 'nuclear' || s.category === 'space') continue;
    tries--;
    const range = isLauncher(s) ? strikeRangeKm(s) : 1500;
    const target = pickMissileTarget(state, n, u, range, threats, s.missile?.kind ?? 'cruise');
    if (!target) continue;
    const count = isLauncher(s) ? Math.min(u.count, AI.salvoSize[level]) : undefined;
    const o: Order = count
      ? { kind: 'strike', unitIds: [u.id], target, count }
      : { kind: 'strike', unitIds: [u.id], target };
    if (order(state, n, o)) salvos--;
  }
  // 3. Frappes aériennes sur les ennemis vus chez soi.
  let strikes = AI.airStrikesPerThink[level];
  for (const u of units) {
    if (strikes <= 0) break;
    const s = sysOf(state, u);
    const m = msOf(state, u);
    if (!isFuelAir(s) || !m || m.up || m.ready > state.time) continue;
    if (s.category !== 'bomber' && s.category !== 'air_support' && s.category !== 'drone') continue;
    const here = posOf(state, u);
    const t = threats
      .filter((x) => s.damage[targetClassOf(state, x)] > 0 && sysOf(state, x).movement === 'land')
      .filter((x) => nearOwn(state, n, posOf(state, x)))
      .sort(
        (a, b) =>
          distanceKm(posOf(state, a), here) - distanceKm(posOf(state, b), here) ||
          (a.id < b.id ? -1 : 1),
      )[0];
    if (!t) continue;
    if (airFeasible(state, u, posOf(state, t))) continue;
    if (
      order(state, n, { kind: 'strike', unitIds: [u.id], target: { type: 'unit', unitId: t.id } })
    )
      strikes--;
  }
}

/** Ennemis observés (hors missiles) et présence d'une menace aérienne (aéronef ou missile vu). */
function visibleEnemies(state: EngineState, n: NationId): { threats: Unit[]; air: boolean } {
  const threats: Unit[] = [];
  let air = false;
  const known = state.know[n];
  if (!known) return { threats, air };
  const enemies = state.rt.enemies.get(n);
  for (const id of sortedKeys(known)) {
    const c = known[id]!;
    const u = state.units[id];
    if (!c.seen || !u || u.off || !enemies?.has(u.owner)) continue;
    if (u.role === 'missile') {
      air = true;
      continue;
    }
    if (sysOf(state, u).movement === 'air') air = true;
    threats.push(u);
  }
  return { threats, air };
}

function nearOwn(state: EngineState, n: NationId, p: LngLat): boolean {
  const nav = wi(state.world).nav;
  const pid = nav.cellProv.get(nav.cellOfPos(p));
  return !!pid && state.provinces[pid]?.owner === n;
}

function pickMissileTarget(
  state: EngineState,
  n: NationId,
  launcher: Unit,
  range: number,
  threats: Unit[],
  kind: string,
): StrikeTarget | null {
  const here = posOf(state, launcher);
  const ls = sysOf(state, launcher);
  let best: Unit | null = null;
  let bestScore = 0;
  for (const t of threats) {
    const ts = sysOf(state, t);
    const d = distanceKm(posOf(state, t), here);
    if (d > range) continue;
    if (kind === 'antiship' && ts.movement !== 'sea') continue;
    if (kind === 'antiradiation' && !isRadarSensor(ts)) continue;
    if (ts.movement === 'air') continue; // trop mobiles pour un missile sol-sol
    const cls = targetClassOf(state, t);
    const dmg = ls.damage[cls] > 0 ? ls.damage[cls] : 0;
    if (dmg <= 0) continue;
    const priority = isRadarSensor(ts) ? 3 : ts.movement === 'sea' ? 2 : 1;
    const score = priority * dmg * t.count;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  if (best) return { type: 'unit', unitId: best.id };
  if (kind === 'antiship' || kind === 'antiradiation' || ls.damage.building <= 0) return null;
  // Sinon : base ennemie à portée (bâtiments publics de la carte).
  const enemies = warsOf(state, n);
  let bestB: StrikeTarget | null = null;
  let bestD = Infinity;
  for (const e of enemies) {
    for (const pid of sortedSet(state.rt.provsOf.get(e))) {
      const blds = buildingsOf(state, pid);
      const b = (['air_base', 'military_base', 'arms_factory'] as const).find((x) =>
        blds.includes(x),
      );
      if (!b) continue;
      const d = distanceKm(cityOf(state, pid)!, here);
      if (d <= range && d < bestD) {
        bestD = d;
        bestB = { type: 'building', provinceId: pid, building: b };
      }
    }
  }
  return bestB;
}
