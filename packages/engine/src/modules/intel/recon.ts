import {
  distanceKm,
  type IntelOpKind,
  type IntelOpTarget,
  type IntelSource,
  type LngLat,
  type NationId,
  type ProvinceId,
  type ReconOpKind,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { scheduleMod } from '../kit.js';
import { cfg, clamp, type OpCost } from './config.js';
import { quality, roll } from './levels.js';
import {
  BUILDING_LABEL,
  nationCoverage,
  nationReconTargets,
  raise,
  type Axis,
} from './provinces.js';
import { publish } from './reports.js';
import type { StoredOp } from './state.js';
import { natDe, provinceName } from './text.js';

/**
 * Reconnaissance d'un pays entier (recon_military / recon_economic ciblant une nation, sans province).
 * La mission se déroule en phases réparties sur sa durée (balance.intel.reconNation) : chaque phase
 * réussie (tirage sur le PRNG de l'état contre l'estimation) couvre quelques provinces, capitale et
 * grandes villes d'abord, puis le reste du pays ; leurs installations apparaissent aussitôt sur la carte.
 * Une phase manquée peut faire repérer la mission (interrompue, attribuée). Rapport final en fin de
 * mission. Les missions lancées avant les phases (sans `rn`) gardent l'ancien déroulement.
 */

export function isNationRecon(kind: IntelOpKind, target: IntelOpTarget): boolean {
  return (kind === 'recon_military' || kind === 'recon_economic') && !target.provinceId;
}

/** Coût d'une opération : réglage du pays entier pour une reconnaissance sans province. */
export function opCost(state: EngineState, kind: IntelOpKind, target: IntelOpTarget): OpCost {
  const c = cfg(state);
  return isNationRecon(kind, target) ? c.reconNation.ops[kind as ReconOpKind] : c.ops[kind];
}

export function reconAxis(kind: IntelOpKind): Axis {
  return kind === 'recon_economic' ? 'e' : 'm';
}

/** Lancement : phases à intervalles réguliers ; la dernière coïncide avec la fin (événement `op`). */
export function scheduleWaves(state: EngineState, n: NationId, op: StoredOp): void {
  const waves = cfg(state).reconNation.waves;
  op.rn = { n: waves, w: 0, ok: 0, pids: [], found: [] };
  const span = op.completesAt - op.startedAt;
  for (let i = 1; i < waves; i++) {
    const t = op.startedAt + Math.floor((span * i) / waves);
    scheduleMod(state, { t, m: 'intel', e: 'wave', d: { n, id: op.id } });
  }
}

/**
 * Une phase. Réussite : provinces couvertes (+`levels` niveaux sur l'axe de la mission), d'autant plus
 * nombreuses que le service est de qualité. Échec : risque d'être repéré (`dq` : qualité du service
 * adverse), réparti sur les phases.
 */
export function runWave(
  state: EngineState,
  n: NationId,
  op: StoredOp,
  dq: number,
): 'ok' | 'miss' | 'exposed' {
  const rn = op.rn!;
  rn.w++;
  const v = op.victim;
  if (!v || !state.nations[v]?.alive || !state.nations[n]?.alive) return 'miss';
  const rc = cfg(state).reconNation;
  if (roll(state) < op.estimate) {
    rn.ok++;
    const axis = reconAxis(op.kind);
    const q = quality(state, n, op.dept);
    const count = Math.max(1, Math.round(rc.provincesPerWave * (1 + rc.qualityBonus * (q - 0.5))));
    for (const pid of nationReconTargets(state, n, v, axis, rc.levels, count)) {
      const found = raise(
        state,
        n,
        pid,
        axis === 'e' ? rc.levels : 0,
        axis === 'm' ? rc.levels : 0,
      );
      if (!rn.pids.includes(pid)) rn.pids.push(pid);
      if (!found.length) continue;
      const entry = rn.found.find((f) => f[0] === pid);
      if (entry) {
        for (const b of found) if (!entry[1].includes(b)) entry[1].push(b);
      } else rn.found.push([pid, [...new Set(found)]]);
    }
    return 'ok';
  }
  const cost = rc.ops[op.kind as ReconOpKind];
  return roll(state) < (cost.exposure * (0.5 + dq)) / Math.max(1, rn.n) ? 'exposed' : 'miss';
}

function plural(k: number, sg: string, pl: string): string {
  return k > 1 ? pl : sg;
}

/** Rapport de fin de mission (ou d'interruption) : phases, provinces couvertes, découvertes, couverture. */
export function nationReconReport(
  state: EngineState,
  n: NationId,
  op: StoredOp,
  outcome: 'success' | 'failed' | 'compromised',
  meta: { title: string; source: IntelSource },
): void {
  const rn = op.rn!;
  const v = op.victim!;
  const axis = reconAxis(op.kind);
  const adj = axis === 'm' ? 'militaire' : 'économique';
  const adjPl = axis === 'm' ? 'militaires' : 'économiques';
  const de = natDe(state, v);
  const lines: string[] = [];
  if (outcome === 'compromised')
    lines.push(
      `Mission repérée par les services ${de} à la phase ${rn.w} sur ${rn.n}, et interrompue. Conséquences diplomatiques à prévoir.`,
    );
  else if (rn.ok === 0)
    lines.push(
      rn.n > 1
        ? `Aucune des ${rn.n} phases de la mission n'a abouti. Pas d'indice de compromission.`
        : "La mission n'a pas abouti. Pas d'indice de compromission.",
    );
  else
    lines.push(
      `Mission menée sur le territoire ${de} : ${rn.ok} ${plural(rn.ok, 'phase', 'phases')} sur ${rn.n} ${plural(rn.ok, 'aboutie', 'abouties')}.`,
    );
  if (rn.pids.length) {
    const shown = rn.pids.slice(0, 8).map((p) => provinceName(state, p));
    lines.push(
      `${plural(rn.pids.length, 'Province couverte', 'Provinces couvertes')} (${rn.pids.length}) : ${shown.join(', ')}${rn.pids.length > 8 ? '…' : '.'}`,
    );
  }
  for (const [pid, found] of rn.found.slice(0, 5)) {
    const names = found.map((b) => BUILDING_LABEL[b] ?? b);
    lines.push(`${provinceName(state, pid)} : ${names.join(', ')}.`);
  }
  const more = rn.found.length - 5;
  if (more > 0)
    lines.push(
      `Et ${more} ${plural(more, 'autre province', 'autres provinces')} avec des installations ${adjPl} nouvelles.`,
    );
  if (rn.ok > 0 && rn.found.length === 0)
    lines.push(`Aucune installation ${adj} nouvelle identifiée.`);
  const cov = nationCoverage(state, n, v, axis);
  lines.push(
    `Connaissance ${adj} ${de} : ${cov.known} ${plural(cov.known, 'province révélée', 'provinces révélées')} sur ${cov.total}.`,
  );
  const rest = cov.total - cov.known;
  if (rest <= 0) lines.push(`Territoire ${de} entièrement reconnu (installations ${adjPl}).`);
  else if (outcome !== 'compromised')
    lines.push(
      rest === 1
        ? 'Une nouvelle mission couvrira la dernière province non révélée.'
        : `Une nouvelle mission étendra la reconnaissance aux ${rest} autres provinces.`,
    );

  // Carte : centrée sur la capitale (ou la première province couverte), rayon englobant la couverture.
  const w = wi(state.world);
  const cap = w.nationById.get(v)?.capitalProvinceId;
  const centerPid = cap && rn.pids.includes(cap) ? cap : (rn.pids[0] ?? cap);
  const at: LngLat | null = centerPid ? (w.provById.get(centerPid)?.cityPoint ?? null) : null;
  let r = 60;
  if (at)
    for (const p of rn.pids) {
      const c = w.provById.get(p)?.cityPoint;
      if (c) r = Math.max(r, distanceKm(at, c) + 40);
    }
  const firstHit: ProvinceId | undefined = rn.found[0]?.[0] ?? rn.pids[0];
  publish(state, n, {
    dept: op.dept,
    source: meta.source,
    kind: 'result',
    title: meta.title,
    lines,
    at,
    radiusKm: at ? clamp(r, 60, 900) : 0,
    subject: { nationId: v },
    actions: firstHit ? [{ kind: 'open_province', provinceId: firstHit }] : [],
    q: outcome === 'compromised' ? 0.9 : 0.6 + (0.25 * rn.ok) / Math.max(1, rn.n),
  });
}
