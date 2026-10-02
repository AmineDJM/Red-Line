import {
  MINUTE,
  distanceKm,
  type BattleReport,
  type BattleReportSummary,
  type LngLat,
  type NationId,
  type ProvinceId,
  type TargetClass,
} from '@redline/shared';
import { notify, sightLevel, sortedKeys, sysOf, veterancyLevel } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { inOwnCity } from '../../combat/combat.js';
import { signal, unitModifier } from '../registry.js';
import { raiseAlert } from './alert.js';
import {
  mil,
  milBal,
  nextId,
  type BattleSideSt,
  type BattleSideX,
  type BattleSt,
  type BattleX,
} from './state.js';
import { cityOf, elementValue, nameOfProvince, posOf, provinceAt, schedule } from './util.js';
import { reportFor, summaryFor } from './aar.js';

/**
 * Rapports de bataille. Chaque tir, interception ou impact est rattaché à une bataille ouverte proche
 * (military.battle.radiusKm) ; les camps se déduisent de qui tire sur qui. Une bataille se clôt quand
 * aucun combat n'a eu lieu pendant military.battle.gapMinutes : issue d'après la valeur des pertes,
 * signal `battle_end`, notification `battle_report` aux nations engagées. Le rapport garde les pertes,
 * les unités engagées, les contre-mesures, une chronologie bornée et un replay court (positions
 * échantillonnées + tirs).
 *
 * Rapport après action (`BattleSt.x`, voir aar.ts) : chaque coup enregistre ce que chaque camp a vu
 * (niveau d'identification des unités adverses, pertes adverses confirmées par ses propres tirs), les
 * dégâts reçus, les munitions tirées, les missiles tirés et abattus, les effets (brouillage, furtivité,
 * position retranchée, ravitaillement), et alimente une courbe des pertes et un découpage en phases
 * (tranches de military.report.bucketMinutes). Tout vient de la simulation : aucun tirage aléatoire.
 */

function newSide(n: NationId): BattleSideSt {
  return { nations: [n], engaged: {}, losses: {}, lossValue: 0 };
}

function newSideX(): BattleSideX {
  return {
    hp: {},
    sh: {},
    ob: {},
    kc: {},
    dd: {},
    ml: 0,
    md: 0,
    mi: 0,
    mr: 0,
    ew: 0,
    st: 0,
    nh: 0,
    fo: 0,
    oos: 0,
    nf: 0,
    aa: 0,
    mo: [0, 0, 0, 0, 0],
    vt: [0, 0],
    gn: [],
    cp: {},
  };
}

export function sideOf(b: BattleSt, n: NationId): 'a' | 'd' | null {
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
    x: {
      a: newSideX(),
      d: newSideX(),
      ser: [],
      bk: null,
      ph: [],
      cap: [],
      dom: [0, 0, 0],
      own: pid ? (state.provinces[pid]?.owner ?? null) : null,
    },
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

function xFor(b: BattleSt, n: NationId): BattleSideX | null {
  const s = sideOf(b, n);
  return s && b.x ? b.x[s] : null;
}

/** Niveau d'identification d'une unité étrangère par une nation (vue courante ou dernier contact). */
export function seenLevel(state: EngineState, n: NationId, uid: string): number {
  return Math.max(sightLevel(state, n, uid), state.know[n]?.[uid]?.lvl ?? 0);
}

/** Enregistre une unité comme engagée (effectif compté une fois). */
export function engage(state: EngineState, b: BattleSt, u: Unit): void {
  if (b.units[u.id]) return;
  // Salve de missiles : effectif 0 (ni engagée ni comptée, mais visible dans le replay).
  b.units[u.id] = [u.owner, u.sys, u.role === 'missile' ? 0 : u.count];
  if (u.role === 'missile') return;
  const side = sideFor(b, u.owner);
  if (side) side.engaged[u.sys] = (side.engaged[u.sys] ?? 0) + u.count;
  const X = xFor(b, u.owner);
  if (!X) return;
  X.vt[0] += veterancyLevel(state, u.xp) * u.count;
  X.vt[1] += u.count;
  const gid = mil(state).unitGen[u.id];
  const name = gid ? mil(state).gens[gid]?.name : undefined;
  if (name && !X.gn.includes(name) && X.gn.length < 4) X.gn.push(name);
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

export function timeline(state: EngineState, b: BattleSt, text: string, units?: Unit[]): void {
  if (b.timeline.length >= milBal(state).battle.maxTimeline) return;
  const e: BattleSt['timeline'][number] = { t: state.time, text };
  if (units && units.length > 0) e.u = units.map((u) => u.id);
  b.timeline.push(e);
}

export function shot(
  state: EngineState,
  b: BattleSt,
  from: LngLat,
  to: LngLat,
  cls: TargetClass,
  hit: boolean,
  by?: Unit | string,
): void {
  if (b.shots.length >= milBal(state).battle.maxShots) return;
  const s: BattleSt['shots'][number] = {
    t: state.time,
    from: [from[0], from[1]],
    to: [to[0], to[1]],
    cls,
    hit,
  };
  if (by) s.u = typeof by === 'string' ? by : by.id;
  b.shots.push(s);
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

// ——— Rapport après action : tranches, phases, courbe des pertes ———

/** Modes de tir : indirect (artillerie, missiles), air → sol, sol direct, naval, contre aéronefs. */
const M_INDIRECT = 0;
const M_AIRGROUND = 1;
const M_GROUND = 2;
const M_NAVAL = 3;
const M_AIR = 4;
/** Index des pertes réelles et des pertes confirmées par l'adversaire dans une tranche. */
const B_LOST = 5;
const B_SEEN = 6;

function bucketMs(state: EngineState): number {
  return Math.max(1, milBal(state).report.bucketMinutes) * MINUTE;
}

/** Tranche courante (ouverte au besoin), après clôture de la précédente si elle est échue. */
function bucket(state: EngineState, X: BattleX): [number, number[], number[]] {
  const ms = bucketMs(state);
  if (X.bk && state.time >= X.bk[0] + ms) closeBucket(state, X);
  if (!X.bk)
    X.bk = [Math.floor(state.time / ms) * ms, [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]];
  return X.bk;
}

const sum5 = (a: number[]) => a[0]! + a[1]! + a[2]! + a[3]! + a[4]!;

/** Genre de phase d'une tranche (null : rien de notable). */
function phaseKind(
  a: number[],
  d: number[],
  prev: BattleX['ph'][number] | undefined,
): [string, 'a' | 'd' | ''] | null {
  const ha = sum5(a);
  const hd = sum5(d);
  const all = ha + hd;
  if (all === 0) {
    if (a[B_LOST]! > 0 || d[B_LOST]! > 0) return null;
    return null;
  }
  if (a[M_AIR]! + d[M_AIR]! > all / 2) return ['air', ha >= hd ? 'a' : 'd'];
  if (a[M_NAVAL]! + d[M_NAVAL]! > all / 2) return ['naval', ha >= hd ? 'a' : 'd'];
  const ground = a[M_GROUND]! + d[M_GROUND]!;
  const groundPrev = !!prev && ['assault', 'defense', 'counter', 'retreat'].includes(prev[0]);
  // Un camp subit des pertes sans riposter après un combat au sol : repli.
  if (groundPrev && ha === 0 && a[B_LOST]! > 0) return ['retreat', 'a'];
  if (groundPrev && hd === 0 && d[B_LOST]! > 0) return ['retreat', 'd'];
  if (ground === 0) {
    const standoffA = a[M_INDIRECT]! + a[M_AIRGROUND]!;
    if (
      !groundPrev &&
      standoffA >= hd &&
      (!prev || prev[0] === 'preparation' || prev[0] === 'strikes')
    )
      return [a[M_INDIRECT]! > 0 ? 'preparation' : 'strikes', 'a'];
    return ['strikes', ha >= hd ? 'a' : 'd'];
  }
  const scoreA = ha + 3 * d[B_LOST]!;
  const scoreD = hd + 3 * a[B_LOST]!;
  if (scoreD > scoreA * 1.5 && prev && (prev[0] === 'assault' || prev[0] === 'counter'))
    return ['counter', 'd'];
  if (scoreA >= scoreD) return ['assault', 'a'];
  return ['defense', 'd'];
}

function closeBucket(state: EngineState, X: BattleX): void {
  const bk = X.bk;
  if (!bk) return;
  X.bk = null;
  const [t0, a, d] = bk;
  const ms = bucketMs(state);
  const t1 = t0 + ms;
  // Courbe des pertes cumulées (les points anciens sont fusionnés au-delà du plafond).
  const lastPt = X.ser[X.ser.length - 1];
  const base = lastPt ?? [t0, 0, 0, 0, 0];
  X.ser.push([
    t1,
    base[1] + a[B_LOST]!,
    base[2] + d[B_LOST]!,
    base[3] + a[B_SEEN]!,
    base[4] + d[B_SEEN]!,
  ]);
  const maxPts = Math.max(4, milBal(state).report.maxPoints);
  if (X.ser.length > maxPts) X.ser = X.ser.filter((_, i) => i % 2 === 1 || i === X.ser.length - 1);
  const prev = X.ph[X.ph.length - 1];
  const k = phaseKind(a, d, prev);
  if (!k) return;
  const [kind, side] = k;
  const add = (ph: BattleX['ph'][number]) => {
    ph[2] = t1;
    ph[4] += a[B_LOST]!;
    ph[5] += d[B_LOST]!;
    ph[6] += a[B_SEEN]!;
    ph[7] += d[B_SEEN]!;
  };
  const contiguous = !!prev && t0 <= prev[2] + 2 * ms;
  // Feux à distance successifs du même camp (frappes, préparation, combat aérien) : une seule phase.
  const STANDOFF = ['preparation', 'strikes', 'air'];
  if (
    prev &&
    contiguous &&
    prev[3] === side &&
    STANDOFF.includes(prev[0]) &&
    STANDOFF.includes(kind)
  ) {
    if (kind === 'preparation') prev[0] = 'preparation';
    add(prev);
    return;
  }
  if (prev && prev[0] === kind && prev[3] === side && contiguous) {
    add(prev);
    return;
  }
  // Plafond : la dernière phase de combat absorbe la suite (jamais la prise de la ville, ponctuelle).
  const cap = Math.max(2, milBal(state).report.maxPhases);
  if (prev && X.ph.length >= cap) {
    if (prev[0] !== 'capture') {
      add(prev);
      return;
    }
    if (X.ph.length >= cap + 4) return;
  }
  X.ph.push([kind, t0, t1, side, a[B_LOST]!, d[B_LOST]!, a[B_SEEN]!, d[B_SEEN]!]);
}

function modeOf(state: EngineState, att: Unit, tgt: Unit): number {
  const ts = sysOf(state, tgt);
  if (ts.movement === 'air') return M_AIR;
  if (att.role === 'missile') return M_INDIRECT;
  const as = sysOf(state, att);
  if (as.movement === 'sea' || ts.movement === 'sea') return M_NAVAL;
  if (as.movement === 'air') return M_AIRGROUND;
  if (as.category === 'artillery' || as.category === 'strike_missile') return M_INDIRECT;
  return M_GROUND;
}

/** Tir direct (ou impact) ayant infligé des dégâts (crochet onDamage). */
export function recordHit(
  state: EngineState,
  att: Unit,
  tgt: Unit,
  lost: number,
  cls: TargetClass,
  dmg = 0,
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
      [att, tgt],
    );
  }
  addLoss(state, b, tgt, lost);
  recordAar(state, b, att, tgt, lost, dmg);
  shot(state, b, posOf(state, att), at, cls, true, att.role ? undefined : att);
  touch(state, b);
  return b;
}

function recordAar(
  state: EngineState,
  b: BattleSt,
  att: Unit,
  tgt: Unit,
  lost: number,
  dmg: number,
): void {
  const X = b.x;
  if (!X) return;
  const sa = sideOf(b, att.owner);
  const sd = sideOf(b, tgt.owner);
  if (!sa || !sd || sa === sd) return;
  const A = X[sa];
  const T = X[sd];
  const ts = sysOf(state, tgt);
  if (dmg > 0) {
    T.hp[tgt.sys] = (T.hp[tgt.sys] ?? 0) + dmg;
    A.dd[tgt.id] = (A.dd[tgt.id] ?? 0) + dmg;
  }
  T.nh++;
  if (att.role === 'missile') T.mr++;
  else {
    A.sh[att.sys] = (A.sh[att.sys] ?? 0) + att.count;
    A.nf++;
    if (unitModifier(state, att, 'combat.damage') < 0.999) A.oos++;
  }
  // Ce que la cible voit du tireur (ou du missile qui la frappe).
  const lt = seenLevel(state, tgt.owner, att.id);
  if (lt > (T.ob[att.id] ?? 0)) T.ob[att.id] = lt;
  if (
    ts.movement === 'land' &&
    (unitModifier(state, tgt, 'combat.armor') > 1.001 || inOwnCity(state, tgt))
  )
    T.fo++;
  // Ce que le tireur voit de sa cible ; ses coups au but sur une cible vue sont des pertes confirmées.
  const la = Math.max(seenLevel(state, att.owner, tgt.id), A.ob[tgt.id] ?? 0, att.role ? 0 : 1);
  if (la > 0) A.ob[tgt.id] = la;
  const mode = modeOf(state, att, tgt);
  A.mo[mode] = (A.mo[mode] ?? 0) + 1;
  X.dom[ts.movement === 'air' ? 2 : ts.movement === 'sea' ? 1 : 0]++;
  const bk = bucket(state, X);
  (sa === 'a' ? bk[1] : bk[2])[mode]!++;
  if (lost > 0) {
    (sd === 'a' ? bk[1] : bk[2])[B_LOST]! += lost;
    if (la > 0) {
      A.kc[tgt.id] = (A.kc[tgt.id] ?? 0) + lost;
      (sd === 'a' ? bk[1] : bk[2])[B_SEEN]! += lost;
      if (ts.movement === 'air') A.aa += lost;
    }
  }
}

/** Effets d'un coup au but : brouillage du camp de la cible, tireur non vu (furtivité). */
export function recordEffects(b: BattleSt, att: Unit, tgt: Unit, jammed: boolean, unseen: boolean) {
  const X = b.x;
  if (!X) return;
  if (jammed) {
    const T = xFor(b, tgt.owner);
    if (T) T.ew++;
  }
  if (unseen) {
    const A = xFor(b, att.owner);
    if (A) A.st++;
  }
}

/** Missiles tirés par une nation dans une bataille. */
export function recordLaunch(b: BattleSt, by: NationId, count: number): void {
  const X = xFor(b, by);
  if (X) X.ml += count;
}

/** Missiles de `shooter` abattus par l'interception de `by`. */
export function recordInterception(
  b: BattleSt,
  by: NationId,
  shooter: NationId,
  killed: number,
): void {
  if (killed <= 0) return;
  const I = xFor(b, by);
  const M = xFor(b, shooter);
  if (I) I.mi += killed;
  if (M) M.md += killed;
}

/**
 * Province prise près d'une bataille ouverte (ou close depuis peu) : conséquence inscrite au rapport,
 * phase « prise de la ville » ; `captured` : matériel adverse saisi sur place (système → éléments).
 */
export function recordCapture(
  state: EngineState,
  pid: ProvinceId,
  from: NationId,
  to: NationId,
  captured: Record<string, number>,
): void {
  const m = mil(state);
  const radius = milBal(state).battle.radiusKm;
  const window = 2 * milBal(state).battle.gapMinutes * MINUTE;
  const city = posOfProvince(state, pid);
  for (const id of sortedKeys(m.battles)) {
    const b = m.battles[id]!;
    const X = b.x;
    if (!X || (b.end !== null && state.time - b.end > window)) continue;
    if (b.pid !== pid && (!city || distanceKm(b.at, city) > radius)) continue;
    const sTo = sideOf(b, to);
    const sFrom = sideOf(b, from);
    if (!sTo || !sFrom || sTo === sFrom) continue;
    if (X.cap.length < 8) X.cap.push([pid, to, state.time]);
    const L = X[sFrom];
    for (const k of Object.keys(captured).sort()) L.cp[k] = (L.cp[k] ?? 0) + captured[k]!;
    if (b.end === null) {
      const ph = X.ph;
      const last = ph[ph.length - 1];
      // Prises rapprochées par le même camp : une seule phase « prise de la ville ».
      if (
        last &&
        last[0] === 'capture' &&
        last[3] === sTo &&
        state.time - last[2] <= bucketMs(state)
      )
        last[2] = state.time;
      else if (ph.length < Math.max(2, milBal(state).report.maxPhases) + 2)
        ph.push(['capture', state.time, state.time, sTo, 0, 0, 0, 0]);
    }
    timeline(state, b, `Prise de ${nameOfProvince(state, pid)} par ${to.toUpperCase()}`);
    if (sTo === 'a' && b.end !== null && b.outcome !== 'attacker') b.outcome = 'attacker';
  }
}

function posOfProvince(state: EngineState, pid: ProvinceId): LngLat | null {
  return cityOf(state, pid);
}

export function noteDestroyed(state: EngineState, u: Unit): void {
  if (u.role) return;
  const m = mil(state);
  const at = posOf(state, u);
  for (const id of m.open) {
    const b = m.battles[id];
    if (!b || !b.units[u.id]) continue;
    if (distanceKm(b.at, at) > milBal(state).battle.radiusKm * 1.5) continue;
    timeline(state, b, `Détruit : ${sysOf(state, u).name} (${u.owner.toUpperCase()}, ${u.count})`, [
      u,
    ]);
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
  if (b.x) finalizeAar(state, b, b.x);
  const la = b.a.lossValue;
  const ld = b.d.lossValue;
  b.outcome = ld > la * 1.2 && ld > 0 ? 'attacker' : la > ld * 1.2 && la > 0 ? 'defender' : 'draw';
  // La ville prise par l'attaquant pendant les combats : victoire de l'attaquant.
  if (b.x?.cap.some(([, by]) => sideOf(b, by) === 'a')) b.outcome = 'attacker';
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

/** Clôture du rapport : dernière tranche, bilan d'identification des unités encore connues. */
function finalizeAar(state: EngineState, b: BattleSt, X: BattleX): void {
  closeBucket(state, X);
  for (const s of ['a', 'd'] as const) {
    const S = X[s];
    const mine = b[s].nations;
    for (const id of Object.keys(b.units).sort()) {
      const owner = b.units[id]![0];
      if (mine.includes(owner) || sideOf(b, owner) === null) continue;
      let lvl = S.ob[id] ?? 0;
      for (const n of mine) lvl = Math.max(lvl, seenLevel(state, n, id));
      if (lvl > 0) S.ob[id] = lvl;
    }
  }
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
  return reportFor(state, b, nation);
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
  return out.slice(0, milBal(state).battle.viewCount).map((b) => summaryFor(state, b, nation));
}
