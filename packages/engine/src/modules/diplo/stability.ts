import type { NationId, ProvinceId, StabilityView } from '@redline/shared';
import type { EngineState, Unit } from '../../state/types.js';
import { atWar, notify, provincesOf, sortedKeys, unitPosAt } from '../../state/access.js';
import { wi } from '../../state/world.js';
import { nextFloat, nextInt } from '../../rng/rng.js';
import { board, modifier, signal } from '../registry.js';
import {
  addReputation,
  addStability,
  allianceOf,
  cfg,
  clamp,
  ds,
  isRegular,
  nationName,
  round1,
  stabDetail,
  stabilityOf,
} from './state.js';
import { news, throttled } from './news.js';
import { capitalPoint, orderProposePeace, ownerAt, regularEnemies } from './relations.js';
import { removeMember } from './alliances.js';
import { disbanding } from './unrest.js';

/** Unité détruite : pertes (stabilité) et combats sur son propre sol (réfugiés). */
export function onUnitLost(state: EngineState, u: Unit): void {
  const d = ds(state);
  const irregular = d.irregular[u.id];
  if (irregular) {
    delete d.irregular[u.id];
    return;
  }
  if (disbanding.has(u.id) || !isRegular(state, u.owner)) return;
  stabDetail(state, u.owner).lost++;
  if (ownerAt(state, unitPosAt(state, u, state.time)) === u.owner) {
    d.hurt[u.owner] = (d.hurt[u.owner] ?? 0) + 1;
  }
}

export function onProvinceLost(
  state: EngineState,
  pid: ProvinceId,
  from: NationId,
  to: NationId,
): void {
  const c = cfg(state);
  const w = wi(state.world);
  const capital = w.nationById.get(from)?.capitalProvinceId === pid;
  if (isRegular(state, from)) {
    addStability(state, from, -(capital ? c.capitalLost : c.provinceLost), 'Territoire perdu');
    stabDetail(state, from).provLost++;
    ds(state).hurt[from] = (ds(state).hurt[from] ?? 0) + 3;
  }
  if (isRegular(state, to)) addStability(state, to, c.provinceGained, 'Territoire conquis');
  if (!isRegular(state, to) || !isRegular(state, from)) return;
  const def = w.provById.get(pid)!;
  if (capital) news(state, 'capital', { A: to, B: from, P: def.name }, def.cityPoint, [to, from]);
  else if (!throttled(state, `cap|${to}|${from}`, 12 * 3_600_000))
    news(state, 'capture', { A: to, B: from, P: def.name }, def.cityPoint, [to, from]);
}

/** Frappe nucléaire : choc mondial. */
export function onNuclear(state: EngineState, by: NationId, victim: NationId): void {
  const c = cfg(state);
  addStability(state, victim, -c.nuclearVictim, 'Frappe nucléaire subie');
  addStability(state, by, -c.nuclearUser, 'Emploi de l’arme nucléaire');
  addReputation(state, by, -30);
  for (const n of state.nationIds) {
    if (n !== by && n !== victim) addStability(state, n, -c.nuclearWorld, 'Choc nucléaire mondial');
  }
}

/** Multiplicateur de production et de revenus dû à une stabilité basse. */
export function stabilityFactor(state: EngineState, n: NationId): number {
  if (!isRegular(state, n)) return 1;
  const c = cfg(state);
  const s = stabilityOf(state, n);
  if (s >= c.lowThreshold) return 1;
  return c.lowMinFactor + (1 - c.lowMinFactor) * (s / Math.max(1, c.lowThreshold));
}

/** Nations voisines (provinces adjacentes) d'une nation. */
function neighborsOf(state: EngineState, n: NationId): NationId[] {
  const w = wi(state.world);
  const out = new Set<NationId>();
  for (const pid of provincesOf(state, n)) {
    for (const nb of w.provById.get(pid)!.neighbors) {
      const o = state.provinces[nb]?.owner;
      if (o && o !== n && isRegular(state, o)) out.add(o);
    }
  }
  return [...out].sort();
}

/** Tick journalier de la stabilité (après révoltes et zones disputées). */
export function stabilityDaily(state: EngineState): void {
  const c = cfg(state);
  const b = board(state);
  const d = ds(state);
  // Réfugiés : une guerre sur son sol fait fuir la population vers les voisins en paix avec elle.
  for (const x of sortedKeys(d.hurt)) {
    const h = d.hurt[x]!;
    if (!(h > 0) || !isRegular(state, x) || regularEnemies(state, x).length === 0) continue;
    // Il faut des combats notables sur son sol (au moins une province perdue ou plusieurs unités détruites).
    if (h < 3) continue;
    const hosts = neighborsOf(state, x).filter((y) => !atWar(state, x, y));
    const hit = Math.min(c.refugeeCapPerDay, c.refugeePerDay * Math.sqrt(h));
    for (const y of hosts) {
      addStability(state, y, -hit, 'Réfugiés');
      d.refugees[y] = (d.refugees[y] ?? 0) + Math.round(h * 5000);
    }
    if (hosts.length > 0 && !throttled(state, `refugees|${x}`, 7 * 86_400_000)) {
      news(
        state,
        'refugees',
        {
          A: x,
          X: hosts
            .slice(0, 4)
            .map((y) => nationName(state, y))
            .join(', '),
        },
        capitalPoint(state, x),
        [x, ...hosts],
      );
    }
  }
  d.hurt = {};
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive) continue;
    const det = stabDetail(state, n);
    const before = stabilityOf(state, n);
    let negative = before < det.prev;
    if (det.lost > 0) {
      addStability(
        state,
        n,
        -Math.min(c.lossCapPerDay, det.lost * c.lossPerUnit),
        'Pertes militaires',
      );
      negative = true;
    }
    if ((b.sanctions[n] ?? 1) < 1) {
      addStability(state, n, -c.sanctionsStabilityPerDay, 'Sanctions');
      negative = true;
    }
    if (b.embargoed[n]) addStability(state, n, -c.sanctionsStabilityPerDay / 2, 'Embargo');
    if (b.mobilized[n]) {
      addStability(state, n, -c.mobilizationStabilityPerDay, 'Mobilisation');
      negative = true;
    }
    const wars = regularEnemies(state, n).length;
    if (wars > 0) addStability(state, n, -c.warWearinessPerDay * wars, 'Lassitude de guerre');
    const start = c.stabilityStart;
    const now = stabilityOf(state, n);
    if (!negative && now < start) {
      const rec = c.recoveryPerDay * modifier(state, n, 'stability.recovery');
      addStability(state, n, Math.min(rec, start - now), 'Retour au calme');
    }
    det.lost = 0;
    det.provLost = 0;
    for (const k of sortedKeys(det.f)) {
      const v = round1(det.f[k]! * 0.8);
      if (Math.abs(v) < 0.1) delete det.f[k];
      else det.f[k] = v;
    }
  }
  // Coups d'État quand la stabilité s'effondre.
  for (const n of state.nationIds) {
    const ns = state.nations[n]!;
    if (!ns.alive) continue;
    const s = stabilityOf(state, n);
    if (s >= c.coupThreshold) continue;
    const chance = c.coupChancePerDay * ((c.coupThreshold - s) / Math.max(1, c.coupThreshold));
    if (nextFloat(ds(state).rng) < clamp(chance, 0, 1)) coup(state, n);
  }
}

/** Préparation du prochain tick (tendance). */
export function stabilityMark(state: EngineState): void {
  for (const n of state.nationIds) stabDetail(state, n).prev = stabilityOf(state, n);
}

export function coupRisk(state: EngineState, n: NationId): number {
  const c = cfg(state);
  const s = stabilityOf(state, n);
  if (s >= c.coupThreshold) return 0;
  return (
    round1(
      clamp(c.coupChancePerDay * ((c.coupThreshold - s) / Math.max(1, c.coupThreshold)), 0, 1) *
        100,
    ) / 100
  );
}

/**
 * Coup d'État : la junte change de politique (quitte l'alliance, demande un cessez-le-feu à ses
 * ennemis, nouvelle posture de l'IA). Un joueur humain garde la main sauf réglage `coupPlayerToAi`.
 */
export function coup(state: EngineState, n: NationId): void {
  const c = cfg(state);
  const d = ds(state);
  const ns = state.nations[n]!;
  d.coups[n] = state.time;
  const A = allianceOf(state, n);
  if (A) removeMember(state, n, A);
  addReputation(state, n, -10);
  board(state).stability[n] = c.coupResetTo;
  const det = stabDetail(state, n);
  det.f = { "Coup d'État": round1(c.coupResetTo - det.prev) };
  if (ns.isPlayer && c.coupPlayerToAi) {
    ns.isPlayer = false;
    ns.isAi = true;
  }
  if (ns.isAi) {
    const levels = ['easy', 'normal', 'hard'] as const;
    ns.aiLevel = levels[nextInt(ds(state).rng, levels.length)]!;
  }
  for (const e of regularEnemies(state, n)) orderProposePeace(state, n, e, 'ceasefire');
  news(state, 'coup', { A: n }, capitalPoint(state, n), [n]);
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at: capitalPoint(state, n),
      category: 'coup',
      title: "Coup d'État",
      text: `${nationName(state, n)} : l'armée a pris le pouvoir.`,
      severity: 'critical',
    },
    null,
  );
  signal(state, 'coup', { nation: n });
}

export function stabilityView(state: EngineState, n: NationId): StabilityView {
  const det = stabDetail(state, n);
  const value = stabilityOf(state, n);
  const factors = sortedKeys(det.f)
    .map((label) => ({ label, delta: det.f[label]! }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.label < b.label ? -1 : 1))
    .slice(0, 8);
  return { value, trend: round1(value - det.prev), factors, coupRisk: coupRisk(state, n) };
}
