import {
  MINUTE,
  distanceKm,
  type BattleReport,
  type BattleReportSummary,
  type BattleSide,
  type LngLat,
  type NationId,
  type TargetClass,
} from '@redline/shared';
import { notify, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { signal } from '../registry.js';
import { raiseAlert } from './alert.js';
import { mil, milBal, nextId, type BattleSideSt, type BattleSt } from './state.js';
import { elementValue, nameOfProvince, posOf, provinceAt, schedule } from './util.js';

/**
 * Rapports de bataille. Chaque tir, interception ou impact est rattaché à une bataille ouverte proche
 * (military.battle.radiusKm) ; les camps se déduisent de qui tire sur qui. Une bataille se clôt quand
 * aucun combat n'a eu lieu pendant military.battle.gapMinutes : issue d'après la valeur des pertes,
 * signal `battle_end`, notification `battle_report` aux nations engagées. Le rapport garde les pertes,
 * les unités engagées, les contre-mesures, une chronologie bornée et un replay court (positions
 * échantillonnées + tirs).
 */

function newSide(n: NationId): BattleSideSt {
  return { nations: [n], engaged: {}, losses: {}, lossValue: 0 };
}

function sideOf(b: BattleSt, n: NationId): 'a' | 'd' | null {
  if (b.a.nations.includes(n)) return 'a';
  if (b.d.nations.includes(n)) return 'd';
  return null;
}

function join(side: BattleSideSt, n: NationId): void {
  if (!side.nations.includes(n)) {
    side.nations.push(n);
    side.nations.sort();
  }
}

/** Bataille ouverte à laquelle rattacher un fait d'armes entre deux nations en un lieu. */
export function battleFor(
  state: EngineState,
  attacker: NationId,
  victim: NationId,
  at: LngLat,
): BattleSt {
  const m = mil(state);
  const bal = milBal(state).battle;
  let best: BattleSt | null = null;
  let bestD = Infinity;
  for (const id of m.open) {
    const b = m.battles[id];
    if (!b) continue;
    const d = distanceKm(b.at, at);
    if (d > bal.radiusKm || d >= bestD) continue;
    const sa = sideOf(b, attacker);
    const sv = sideOf(b, victim);
    if (sa && sv && sa === sv) continue; // incohérent : autre bataille
    best = b;
    bestD = d;
  }
  if (best) {
    const sa = sideOf(best, attacker);
    const sv = sideOf(best, victim);
    if (!sa && sv) join(sv === 'a' ? best.d : best.a, attacker);
    else if (sa && !sv) join(sa === 'a' ? best.d : best.a, victim);
    else if (!sa && !sv) {
      join(best.a, attacker);
      join(best.d, victim);
    }
    return best;
  }
  const id = nextId(state, 'bt');
  const pid = provinceAt(state, at);
  const where = nameOfProvince(state, pid);
  const b: BattleSt = {
    id,
    at: [at[0], at[1]],
    pid,
    start: state.time,
    last: state.time,
    end: null,
    a: newSide(attacker),
    d: newSide(victim),
    units: {},
    cm: {},
    timeline: [],
    frames: [],
    shots: [],
    outcome: 'ongoing',
    title: pid
      ? `Bataille ${/^[aeiouéèêâîô]/i.test(where) ? "d'" : 'de '}${where}`
      : 'Bataille en mer',
  };
  m.battles[id] = b;
  m.open.push(id);
  m.open.sort();
  schedule(state, state.time + bal.gapMinutes * MINUTE, 'bclose', { b: id });
  return b;
}

function sideFor(b: BattleSt, n: NationId): BattleSideSt | null {
  const s = sideOf(b, n);
  return s === 'a' ? b.a : s === 'd' ? b.d : null;
}

/** Enregistre une unité comme engagée (effectif compté une fois). */
export function engage(_state: EngineState, b: BattleSt, u: Unit): void {
  if (b.units[u.id]) return;
  b.units[u.id] = [u.owner, u.sys];
  if (u.role === 'missile') return;
  const side = sideFor(b, u.owner);
  if (side) side.engaged[u.sys] = (side.engaged[u.sys] ?? 0) + u.count;
}

export function addLoss(state: EngineState, b: BattleSt, u: Unit, lost: number): void {
  if (lost <= 0 || u.role) return;
  const side = sideFor(b, u.owner);
  if (!side) return;
  side.losses[u.sys] = (side.losses[u.sys] ?? 0) + lost;
  side.lossValue += lost * elementValue(sysOf(state, u));
}

export function countermeasure(b: BattleSt, kind: string, n = 1): void {
  if (n > 0) b.cm[kind] = (b.cm[kind] ?? 0) + n;
}

export function timeline(state: EngineState, b: BattleSt, text: string): void {
  if (b.timeline.length >= milBal(state).battle.maxTimeline) return;
  b.timeline.push({ t: state.time, text });
}

export function shot(
  state: EngineState,
  b: BattleSt,
  from: LngLat,
  to: LngLat,
  cls: TargetClass,
  hit: boolean,
): void {
  const bal = milBal(state).battle;
  const live = Math.round(bal.liveShots);
  if (live > 0) {
    const rs = (b.rs ??= []);
    rs.push({ t: state.time, from: [from[0], from[1]], to: [to[0], to[1]], cls, hit });
    if (rs.length > live) rs.splice(0, rs.length - live);
  }
  if (b.shots.length >= bal.maxShots) return;
  b.shots.push({ t: state.time, from: [from[0], from[1]], to: [to[0], to[1]], cls, hit });
}

/** Marque l'activité (report de la clôture) et échantillonne une image du replay si besoin. */
export function touch(state: EngineState, b: BattleSt): void {
  b.last = state.time;
  const bal = milBal(state).battle;
  const lastFrame = b.frames[b.frames.length - 1];
  if (b.frames.length >= bal.maxFrames) return;
  if (lastFrame && state.time - lastFrame.t < bal.frameMinutes * MINUTE) return;
  const units: BattleSt['frames'][number]['units'] = [];
  for (const id of Object.keys(b.units).sort()) {
    if (units.length >= bal.maxUnitsPerFrame) break;
    const u = state.units[id];
    if (!u || u.off) continue;
    units.push({ id, owner: u.owner, systemId: u.sys, at: posOf(state, u), hp: u.hp / u.maxHp });
  }
  b.frames.push({ t: state.time, units });
}

/** Tir direct ayant infligé des dégâts (crochet onDamage). */
export function recordHit(
  state: EngineState,
  att: Unit,
  tgt: Unit,
  lost: number,
  cls: TargetClass,
): BattleSt {
  const at = posOf(state, tgt);
  const b = battleFor(state, att.owner, tgt.owner, at);
  const first = Object.keys(b.units).length === 0;
  engage(state, b, att);
  engage(state, b, tgt);
  if (first) {
    timeline(
      state,
      b,
      `Premiers tirs : ${sysOf(state, att).name} (${att.owner.toUpperCase()}) contre ${sysOf(state, tgt).name} (${tgt.owner.toUpperCase()})`,
    );
  }
  addLoss(state, b, tgt, lost);
  shot(state, b, posOf(state, att), at, cls, true);
  touch(state, b);
  return b;
}

export function noteDestroyed(state: EngineState, u: Unit): void {
  if (u.role) return;
  const m = mil(state);
  const at = posOf(state, u);
  for (const id of m.open) {
    const b = m.battles[id];
    if (!b || !b.units[u.id]) continue;
    if (distanceKm(b.at, at) > milBal(state).battle.radiusKm * 1.5) continue;
    timeline(state, b, `Détruit : ${sysOf(state, u).name} (${u.owner.toUpperCase()}, ${u.count})`);
    return;
  }
}

/** Événement de clôture (reporté tant que la bataille est active). */
export function handleClose(state: EngineState, d: { b: string }): void {
  const m = mil(state);
  const b = m.battles[d.b];
  if (!b || b.end !== null) return;
  const gap = milBal(state).battle.gapMinutes * MINUTE;
  if (state.time < b.last + gap) {
    schedule(state, b.last + gap, 'bclose', { b: b.id });
    return;
  }
  b.end = b.last;
  // L'activité en direct ne sert plus (le replay garde les tirs).
  delete b.rs;
  const la = b.a.lossValue;
  const ld = b.d.lossValue;
  b.outcome = ld > la * 1.2 && ld > 0 ? 'attacker' : la > ld * 1.2 && la > 0 ? 'defender' : 'draw';
  const verdict =
    b.outcome === 'attacker'
      ? 'Avantage à l’attaquant'
      : b.outcome === 'defender'
        ? 'Avantage au défenseur'
        : 'Issue indécise';
  b.timeline.push({ t: b.end, text: `Fin des combats : ${verdict.toLowerCase()}` });
  m.open = m.open.filter((x) => x !== b.id);
  const nations = [...new Set([...b.a.nations, ...b.d.nations])].sort();
  const winner =
    b.outcome === 'attacker'
      ? (b.a.nations[0] ?? null)
      : b.outcome === 'defender'
        ? (b.d.nations[0] ?? null)
        : null;
  signal(state, 'battle_end', { reportId: b.id, at: b.at, winner, nations });
  notify(state, { kind: 'battle_report', time: state.time, reportId: b.id, at: b.at }, nations);
  raiseAlert(state, milBal(state).tension.battle, 'battle');
  trimReports(state);
}

function trimReports(state: EngineState): void {
  const m = mil(state);
  const max = milBal(state).battle.maxReports;
  const ids = Object.keys(m.battles).sort((x, y) => Number(x.slice(2)) - Number(y.slice(2)));
  let excess = ids.length - max;
  for (const id of ids) {
    if (excess <= 0) break;
    if (m.battles[id]!.end === null) continue;
    delete m.battles[id];
    excess--;
  }
}

function side(s: BattleSideSt): BattleSide {
  const list = (r: Record<string, number>) =>
    Object.keys(r)
      .sort()
      .filter((k) => r[k]! > 0)
      .map((systemId) => ({ systemId, count: r[systemId]! }));
  return { nations: [...s.nations], engaged: list(s.engaged), losses: list(s.losses) };
}

export function summaryOf(b: BattleSt): BattleReportSummary {
  return {
    id: b.id,
    at: b.at,
    provinceId: b.pid,
    startedAt: b.start,
    endedAt: b.end,
    title: b.title,
    attacker: side(b.a),
    defender: side(b.d),
    outcome: b.outcome,
  };
}

const CM_TEXT: Record<string, string> = {
  interception: 'Missiles interceptés par la défense aérienne',
  evasion: 'Tirs d’interception manqués (manœuvre, saturation)',
  saturation: 'Missiles passés faute de canaux de tir ou de munitions',
  jamming: 'Tirs dégradés par le brouillage',
  stealth: 'Coups portés par une unité non détectée (furtivité)',
  decoy: 'Tirs perdus sur des leurres',
  sonar: 'Sous-marin repéré au sonar',
};

export function reportOf(b: BattleSt): BattleReport {
  return {
    ...summaryOf(b),
    countermeasures: Object.keys(b.cm)
      .sort()
      .map((kind) => ({ kind, text: CM_TEXT[kind] ?? kind, count: b.cm[kind]! })),
    timeline: b.timeline.map((x) => ({ ...x })),
    replay: {
      t0: b.start,
      t1: b.end ?? b.last,
      frames: b.frames.map((f) => ({ t: f.t, units: f.units.map((u) => ({ ...u })) })),
      shots: b.shots.map((s) => ({ ...s })),
    },
  };
}

export function participates(b: BattleSt, n: NationId): boolean {
  return b.a.nations.includes(n) || b.d.nations.includes(n);
}

/** Détail d'un rapport de bataille pour une nation qui y a pris part (sinon null). */
export function battleReportForImpl(
  state: EngineState,
  nation: NationId,
  id: string,
): BattleReport | null {
  const b = mil(state).battles[id];
  if (!b || !participates(b, nation)) return null;
  return reportOf(b);
}

/**
 * Activité récente d'une bataille en cours (vue des participants) : derniers tirs, bornés en nombre
 * et en ancienneté. Absente pour une bataille close.
 */
function liveOf(state: EngineState, b: BattleSt): BattleReportSummary['live'] {
  if (b.end !== null) return undefined;
  const since = state.time - milBal(state).battle.liveMinutes * MINUTE;
  return {
    lastAt: b.last,
    shots: (b.rs ?? [])
      .filter((x) => x.t >= since)
      .map((x) => ({
        t: x.t,
        from: [x.from[0], x.from[1]],
        to: [x.to[0], x.to[1]],
        cls: x.cls,
        hit: x.hit,
      })),
  };
}

/** Résumés récents pour la vue d'une nation. */
export function summariesFor(state: EngineState, nation: NationId): BattleReportSummary[] {
  const m = mil(state);
  const out: BattleSt[] = [];
  for (const id of Object.keys(m.battles)) {
    const b = m.battles[id]!;
    if (participates(b, nation)) out.push(b);
  }
  out.sort((x, y) => y.start - x.start || (x.id < y.id ? 1 : -1));
  return out.slice(0, milBal(state).battle.viewCount).map((b) => {
    const s = summaryOf(b);
    const live = liveOf(state, b);
    if (live) s.live = live;
    return s;
  });
}
