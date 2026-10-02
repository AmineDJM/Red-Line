import {
  distanceKm,
  type BattleAar,
  type BattleAarSide,
  type BattleCasualties,
  type BattleDomain,
  type BattleFactor,
  type BattleForceLine,
  type BattlePhase,
  type BattlePhaseKind,
  type BattleReport,
  type BattleReportSummary,
  type BattleSide,
  type Estimate,
  type IntelGrade,
  type NationId,
  type WeaponSystem,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { board } from '../kit.js';
import {
  milBal,
  type BattleSideSt,
  type BattleSideX,
  type BattleSt,
  type BattleX,
} from './state.js';
import { elementValue, provDef } from './util.js';

/**
 * Rapport après action (AAR) d'une bataille, pour une nation qui y a pris part. Son camp est rapporté
 * exactement ; le camp adverse est estimé d'après ce que son camp a vu pendant la bataille (niveau
 * d'identification de chaque unité adverse, pertes confirmées par ses propres tirs, dégâts infligés,
 * coups et missiles reçus) : aucune unité adverse jamais détectée n'apparaît, aucun matériel non
 * identifié n'est nommé, les chiffres adverses sont des fourchettes. Lecture seule (aucune écriture
 * dans l'état) et déterministe.
 */

type Side = 'a' | 'd';
const other = (s: Side): Side => (s === 'a' ? 'd' : 'a');
const sideName = (s: Side) => (s === 'a' ? 'attacker' : 'defender');

function sideOfB(b: BattleSt, n: NationId): Side | null {
  if (b.a.nations.includes(n)) return 'a';
  if (b.d.nations.includes(n)) return 'd';
  return null;
}

const exact = (v: number): Estimate => {
  const x = Math.max(0, Math.round(v));
  return { best: x, min: x, max: x };
};
const zero = (): Estimate => ({ best: 0, min: 0, max: 0 });

function addTo(e: Estimate, best: number, min: number, max: number): void {
  e.best += best;
  e.min += min;
  e.max += max;
}

function roundE(e: Estimate): Estimate {
  const min = Math.max(0, Math.round(e.min));
  const best = Math.max(min, Math.round(e.best));
  return { best, min, max: Math.max(best, Math.round(e.max)) };
}

function scaleE(e: Estimate, k: number): Estimate {
  return { best: e.best * k, min: e.min * k, max: e.max * k };
}

function sumE(list: Estimate[]): Estimate {
  const out = zero();
  for (const e of list) addTo(out, e.best, e.min, e.max);
  return out;
}

type Medium = 'land' | 'sea' | 'air';
const mediumOf = (s: WeaponSystem): Medium =>
  s.movement === 'air' ? 'air' : s.movement === 'sea' ? 'sea' : 'land';

/** Personnels par élément (équipage, servants, bataillon), d'après military.casualties. */
function crewOf(state: EngineState, s: WeaponSystem): number {
  return milBal(state).casualties[s.category] ?? 1;
}

/** Contact détecté non identifié : personnels par élément [min, meilleur, max] selon le milieu. */
const UNKNOWN_CREW: Record<Medium, [number, number, number]> = {
  land: [3, 20, 600],
  air: [1, 2, 4],
  sea: [40, 150, 400],
};

interface Line {
  sys: WeaponSystem | null;
  medium: Medium;
  engaged: Estimate;
  destroyed: Estimate;
  damaged: Estimate;
  captured: Estimate;
  personnel: Estimate;
  munitions: Estimate;
}

function newLine(sys: WeaponSystem | null, medium: Medium): Line {
  return {
    sys,
    medium,
    engaged: zero(),
    destroyed: zero(),
    damaged: zero(),
    captured: zero(),
    personnel: zero(),
    munitions: zero(),
  };
}

/** Éléments endommagés (dégâts reçus au-delà des éléments détruits). */
function damagedOf(
  state: EngineState,
  s: WeaponSystem,
  hp: number,
  lost: number,
  alive: number,
): number {
  const R = milBal(state).report;
  const excess = Math.max(0, hp - lost * s.hp);
  const per = Math.max(1e-9, s.hp * R.damagedHpShare);
  return Math.max(0, Math.min(alive, Math.floor(excess / per)));
}

/** Lignes exactes du camp du lecteur. */
function ownLines(state: EngineState, S: BattleSideSt, X: BattleSideX | null): Line[] {
  const R = milBal(state).report;
  const keys = new Set([...Object.keys(S.engaged), ...Object.keys(S.losses)]);
  if (X) for (const k of Object.keys(X.cp)) keys.add(k);
  const out: Line[] = [];
  for (const k of [...keys].sort()) {
    const s = state.world.catalog.get(k);
    if (!s) continue;
    const L = newLine(s, mediumOf(s));
    const eng = S.engaged[k] ?? 0;
    const lost = S.losses[k] ?? 0;
    L.engaged = exact(eng);
    L.destroyed = exact(lost);
    L.damaged = exact(X ? damagedOf(state, s, X.hp[k] ?? 0, lost, Math.max(0, eng - lost)) : 0);
    L.captured = exact(X?.cp[k] ?? 0);
    L.personnel = exact(eng * crewOf(state, s));
    L.munitions = exact((X?.sh[k] ?? 0) * (R.munitionsPerRound[s.category] ?? 0));
    out.push(L);
  }
  return out;
}

/**
 * Lignes estimées du camp adverse, vues par le camp `V` : seules les unités que `V` a détectées ;
 * matériel nommé seulement s'il a été identifié ; effectifs en fourchette selon le niveau
 * (précis : exact), pertes = destructions confirmées par ses propres tirs.
 */
function enemyLines(state: EngineState, b: BattleSt, X: BattleX, V: Side): Line[] {
  const R = milBal(state).report;
  const E = other(V);
  const mine = X[V];
  const lines = new Map<string, Line>();
  for (const id of Object.keys(b.units).sort()) {
    const u = b.units[id]!;
    if (!b[E].nations.includes(u[0])) continue;
    const lvl = mine.ob[id] ?? 0;
    if (lvl <= 0) continue;
    const s = state.world.catalog.get(u[1]);
    if (!s) continue;
    const cnt = u.length > 2 ? (u[2] as number) : s.unitSize;
    if (cnt <= 0) continue; // salve de missiles
    const medium = mediumOf(s);
    const key = lvl >= 2 ? s.id : `?${medium}`;
    let L = lines.get(key);
    if (!L) {
      L = newLine(lvl >= 2 ? s : null, medium);
      lines.set(key, L);
    }
    const spread = lvl >= 3 ? 0 : lvl === 2 ? R.spreadIdentified : R.spreadDetected;
    addTo(L.engaged, cnt, cnt * (1 - spread), cnt * (1 + spread));
    const kc = Math.min(cnt, mine.kc[id] ?? 0);
    addTo(L.destroyed, kc, kc, Math.min(cnt * (1 + spread), kc * (1 + R.killSpread)));
    const dmg = damagedOf(state, s, mine.dd[id] ?? 0, kc, Math.max(0, cnt - kc));
    addTo(L.damaged, dmg, dmg * (1 - R.killSpread), dmg * (1 + R.killSpread));
    if (lvl >= 2) {
      const c = crewOf(state, s);
      addTo(L.personnel, cnt * c, cnt * (1 - spread) * c, cnt * (1 + spread) * c);
    } else {
      const [lo, mid, hi] = UNKNOWN_CREW[medium];
      addTo(L.personnel, cnt * mid, cnt * (1 - spread) * lo, cnt * (1 + spread) * hi);
    }
  }
  // Matériel adverse saisi par son camp : connu exactement (il est entre ses mains).
  for (const k of Object.keys(X[E].cp).sort()) {
    const s = state.world.catalog.get(k);
    if (!s) continue;
    let L = lines.get(k);
    if (!L) {
      L = newLine(s, mediumOf(s));
      lines.set(k, L);
    }
    addTo(L.captured, X[E].cp[k]!, X[E].cp[k]!, X[E].cp[k]!);
  }
  return [...lines.keys()].sort().map((k) => {
    const L = lines.get(k)!;
    return {
      ...L,
      engaged: roundE(L.engaged),
      destroyed: roundE(L.destroyed),
      damaged: roundE(L.damaged),
      captured: roundE(L.captured),
      personnel: roundE(L.personnel),
      munitions: zero(),
    };
  });
}

/** Le camp `s` a perdu une province prise pendant la bataille. */
function lostProvince(b: BattleSt, X: BattleX, s: Side): boolean {
  return X.cap.some(([, by]) => sideOfB(b, by) === other(s));
}

function casualtiesOf(state: EngineState, lines: Line[], prisoners: boolean): BattleCasualties {
  const R = milBal(state).report;
  const killed = zero();
  const wounded = zero();
  const missing = zero();
  for (const L of lines) {
    let crew: [number, number, number];
    if (L.sys) {
      const c = crewOf(state, L.sys);
      crew = [c, c, c];
    } else crew = UNKNOWN_CREW[L.medium];
    const k = R.killedShare[L.medium];
    const w = R.woundedShare[L.medium];
    const m = Math.max(0, 1 - k - w);
    const d = L.destroyed;
    const g = L.damaged;
    addTo(killed, d.best * crew[1] * k, d.min * crew[0] * k, d.max * crew[2] * k);
    addTo(
      wounded,
      d.best * crew[1] * w + g.best * crew[1] * R.damagedWoundedShare,
      d.min * crew[0] * w + g.min * crew[0] * R.damagedWoundedShare,
      d.max * crew[2] * w + g.max * crew[2] * R.damagedWoundedShare,
    );
    addTo(missing, d.best * crew[1] * m, d.min * crew[0] * m, d.max * crew[2] * m);
  }
  const p = prisoners ? R.prisonerShare : 0;
  return {
    killed: roundE(killed),
    wounded: roundE(wounded),
    missing: roundE(scaleE(missing, 1 - p)),
    prisoners: roundE(scaleE(missing, p)),
  };
}

function grade(b: BattleSt, X: BattleX, V: Side): IntelGrade {
  const E = other(V);
  const levels: number[] = [];
  for (const id of Object.keys(b.units).sort()) {
    const u = b.units[id]!;
    if (!b[E].nations.includes(u[0]) || (u.length > 2 && u[2] === 0)) continue;
    const l = X[V].ob[id] ?? 0;
    if (l > 0) levels.push(l);
  }
  if (levels.length === 0) {
    return X[V].nh > 0 ? { source: 'E', credibility: 5 } : { source: 'F', credibility: 6 };
  }
  const share = (lv: number) => levels.filter((x) => x >= lv).length / levels.length;
  const p3 = share(3);
  const p2 = share(2);
  const source: IntelGrade['source'] = p3 >= 0.5 ? 'A' : p2 >= 0.5 ? 'B' : p2 > 0 ? 'C' : 'D';
  const credibility: IntelGrade['credibility'] =
    p3 >= 0.8 ? 1 : p2 >= 0.8 ? 2 : p2 >= 0.5 ? 3 : p2 > 0 ? 4 : 5;
  return { source, credibility };
}

function toForceLine(L: Line): BattleForceLine {
  return {
    systemId: L.sys?.id ?? null,
    medium: L.medium,
    engaged: L.engaged,
    destroyed: L.destroyed,
    damaged: L.damaged,
    captured: L.captured,
    personnel: L.personnel,
    munitions: L.munitions,
  };
}

function buildSide(
  state: EngineState,
  b: BattleSt,
  X: BattleX,
  s: Side,
  V: Side,
): { side: BattleAarSide; lines: Line[] } {
  const R = milBal(state).report;
  const own = s === V;
  const lines = own ? ownLines(state, b[s], X[s]) : enemyLines(state, b, X, V);
  const isVehicle = (L: Line) => L.medium === 'land' && L.sys?.category !== 'infantry';
  const sum = (f: (L: Line) => boolean, g: (L: Line) => Estimate) =>
    roundE(sumE(lines.filter(f).map(g)));
  const materiel = (L: Line) => L.sys?.category !== 'infantry';
  const usd = zero();
  for (const L of lines) {
    if (!L.sys) continue;
    const v = elementValue(L.sys);
    addTo(usd, L.destroyed.best * v, L.destroyed.min * v, L.destroyed.max * v);
  }
  const mineX = X[s];
  // Missiles et munitions : exacts pour son camp ; pour l'adversaire, ce que son camp a encaissé ou abattu.
  const seenMissiles = X[V].mi + X[V].mr;
  const side: BattleAarSide = {
    side: sideName(s),
    nations: [...b[s].nations],
    own,
    forces: lines.map(toForceLine),
    totals: {
      personnel: sum(
        () => true,
        (L) => L.personnel,
      ),
      vehicles: sum(isVehicle, (L) => L.engaged),
      aircraft: sum(
        (L) => L.medium === 'air',
        (L) => L.engaged,
      ),
      ships: sum(
        (L) => L.medium === 'sea',
        (L) => L.engaged,
      ),
    },
    casualties: casualtiesOf(state, lines, lostProvince(b, X, s)),
    materiel: {
      destroyed: sum(materiel, (L) => L.destroyed),
      damaged: sum(materiel, (L) => L.damaged),
      captured: sum(materiel, (L) => L.captured),
    },
    lossesUsd: roundE(own ? exact(b[s].lossValue) : usd),
    missiles: own
      ? { launched: exact(mineX.ml), shotDown: exact(mineX.md) }
      : {
          launched: roundE({ best: seenMissiles, min: seenMissiles, max: seenMissiles * 1.5 }),
          shotDown: exact(X[V].mi),
        },
    interceptions: own ? exact(mineX.mi) : exact(X[V].md),
    sorties: sum(
      (L) => L.medium === 'air',
      (L) => L.engaged,
    ),
    munitions: own
      ? roundE(sumE(lines.map((L) => L.munitions)))
      : roundE({
          best: X[V].nh * 3,
          min: X[V].nh,
          max: X[V].nh * Math.max(3, ...Object.values(R.munitionsPerRound)),
        }),
  };
  if (own) {
    if (mineX.gn.length > 0) side.generals = [...mineX.gn];
    if (mineX.vt[1] > 0) side.veterancy = Math.round((mineX.vt[0] / mineX.vt[1]) * 100) / 100;
  } else side.grade = grade(b, X, V);
  return { side, lines };
}

function domainOf(b: BattleSt, X: BattleX): BattleDomain {
  const [land, sea, air] = X.dom;
  const tot = land + sea + air;
  if (tot > 0 && air / tot > 0.5) return 'air';
  if (!b.pid) return tot > 0 && air > sea ? 'air' : 'sea';
  if (tot > 0 && sea / tot >= 0.2) return 'coast';
  return 'land';
}

/** Facteurs décisifs, d'après ce que le lecteur sait (son camp : tout ; l'adversaire : l'observable). */
function factorsOf(
  state: EngineState,
  b: BattleSt,
  X: BattleX,
  V: Side,
  sides: Record<Side, { side: BattleAarSide; lines: Line[] }>,
): BattleFactor[] {
  const out: BattleFactor[] = [];
  const push = (
    kind: BattleFactor['kind'],
    s: Side,
    positive: boolean,
    weight: number,
    params: BattleFactor['params'] = {},
  ) =>
    out.push({
      kind,
      side: sideName(s),
      positive,
      weight: Math.min(1, Math.max(0, weight)),
      params,
    });
  // Rapport de forces (valeur des matériels engagés : exacte pour soi, estimée pour l'adversaire).
  const value = (s: Side) => {
    let v = 0;
    for (const L of sides[s].lines) if (L.sys) v += L.engaged.best * elementValue(L.sys);
    return v;
  };
  const va = value('a');
  const vd = value('d');
  if (va > 0 && vd > 0) {
    const r = va / vd;
    if (r >= 1.8)
      push('numbers', 'a', true, Math.min(1, (r - 1) / 4), { ratio: Math.round(r * 10) / 10 });
    else if (r <= 1 / 1.8)
      push('numbers', 'd', true, Math.min(1, (1 / r - 1) / 4), {
        ratio: Math.round((1 / r) * 10) / 10,
      });
  }
  for (const s of ['a', 'd'] as const) {
    const E = other(s);
    const S = X[s];
    // Supériorité aérienne : aéronefs abattus et frappes air-sol (observables des deux côtés).
    const air = (x: BattleSideX) => x.aa * 3 + (x.mo[1] ?? 0);
    if (air(S) >= 3 && air(S) >= 2 * air(X[E]))
      push('air_superiority', s, true, air(S) / (air(S) + air(X[E]) + 5), {
        kills: S.aa,
        strikes: S.mo[1] ?? 0,
      });
    if (S.ew >= 3) push('electronic_warfare', s, true, S.ew / Math.max(1, S.nh), { hits: S.ew });
    if (S.st >= 2) push('stealth', s, true, S.st / Math.max(1, S.nf), { hits: S.st });
    if (S.nh >= 3 && S.fo / S.nh >= 0.4)
      push('entrenched', s, true, S.fo / S.nh, { share: Math.round((S.fo / S.nh) * 100) });
    if (S.mi >= 2 && S.mi / (S.mi + S.mr) >= 0.5)
      push('air_defense', s, true, S.mi / (S.mi + S.mr), { intercepted: S.mi });
    if (s === V) {
      if (S.nf >= 3 && S.oos / S.nf >= 0.3)
        push('supply', s, false, S.oos / S.nf, { share: Math.round((S.oos / S.nf) * 100) });
      if (S.vt[1] > 0 && S.vt[0] / S.vt[1] >= 1)
        push('veterancy', s, true, Math.min(1, S.vt[0] / S.vt[1] / 3), {
          level: Math.round((S.vt[0] / S.vt[1]) * 10) / 10,
        });
      if (S.gn.length > 0) push('generals', s, true, 0.4, { names: S.gn.join(', ') });
    }
    // Moral : stabilité publique basse d'une nation du camp.
    const stab = board(state).stability ?? {};
    for (const n of b[s].nations) {
      const v = stab[n];
      if (v !== undefined && v < 40) {
        push('morale', s, false, (40 - v) / 40, { nation: n, stability: Math.round(v) });
        break;
      }
    }
  }
  out.sort((x, y) => y.weight - x.weight || (x.kind < y.kind ? -1 : 1));
  return out.slice(0, 6);
}

function aarOf(state: EngineState, b: BattleSt, X: BattleX, V: Side): BattleAar {
  const sides = { a: buildSide(state, b, X, 'a', V), d: buildSide(state, b, X, 'd', V) };
  const def = b.pid ? provDef(state, b.pid) : undefined;
  // Pertes : exactes pour son camp, confirmées par ses tirs pour l'adversaire.
  const lossA = (la: number, ca: number) => (V === 'a' ? la : ca);
  const lossD = (ld: number, cd: number) => (V === 'd' ? ld : cd);
  const phases: BattlePhase[] = X.ph.map((p) => ({
    kind: p[0] as BattlePhaseKind,
    t0: p[1],
    t1: p[2],
    side: p[3] === 'a' ? 'attacker' : p[3] === 'd' ? 'defender' : null,
    attackerLosses: lossA(p[4], p[6]),
    defenderLosses: lossD(p[5], p[7]),
  }));
  // Ordre chronologique (une prise de ville s'inscrit pendant la tranche en cours).
  phases.sort((x, y) => x.t0 - y.t0 || x.t1 - y.t1);
  const losses = [
    { t: b.start, attacker: 0, defender: 0 },
    ...X.ser.map((p) => ({ t: p[0], attacker: lossA(p[1], p[3]), defender: lossD(p[2], p[4]) })),
  ];
  const capA = X.cap.some(([, by]) => sideOfB(b, by) === 'a');
  const la = b.a.lossValue;
  const ld = b.d.lossValue;
  let verdict: BattleAar['result']['verdict'];
  if (b.end === null) verdict = 'ongoing';
  else if (capA || (b.outcome === 'attacker' && ld >= 3 * Math.max(1, la)))
    verdict = 'decisive_attacker';
  else if (b.outcome === 'attacker') verdict = 'attacker';
  else if (b.outcome === 'defender' && la >= 3 * Math.max(1, ld)) verdict = 'decisive_defender';
  else if (b.outcome === 'defender') verdict = 'defender';
  else verdict = 'stalemate';
  const captured = X.cap.map(([pid, by, at]) => ({
    provinceId: pid,
    name: provDef(state, pid)?.cityName ?? provDef(state, pid)?.name ?? pid,
    by,
    at,
  }));
  const held =
    b.pid &&
    b.end !== null &&
    !X.cap.some(([p]) => p === b.pid) &&
    state.provinces[b.pid]?.owner === X.own
      ? b.pid
      : null;
  return {
    place: {
      provinceId: b.pid,
      province: def?.name ?? null,
      city: def?.cityName ?? null,
      owner: X.own,
      domain: domainOf(b, X),
      urban: !!def && distanceKm(b.at, def.cityPoint) <= 40,
    },
    mySide: sideName(V),
    sides: [sides.a.side, sides.d.side],
    phases,
    losses,
    factors: factorsOf(state, b, X, V, sides),
    result: { verdict, captured, held },
  };
}

// ——— Résumé et rapport par lecteur ———

function list(r: Record<string, number>) {
  return Object.keys(r)
    .sort()
    .filter((k) => r[k]! > 0)
    .map((systemId) => ({ systemId, count: r[systemId]! }));
}

function exactSide(s: BattleSideSt): BattleSide {
  return { nations: [...s.nations], engaged: list(s.engaged), losses: list(s.losses) };
}

/** Camp adverse tel que le lecteur le connaît : matériels identifiés, pertes confirmées. */
function seenSide(state: EngineState, b: BattleSt, X: BattleX, V: Side): BattleSide {
  const E = other(V);
  const eng: Record<string, number> = {};
  const lost: Record<string, number> = {};
  for (const id of Object.keys(b.units).sort()) {
    const u = b.units[id]!;
    if (!b[E].nations.includes(u[0]) || (X[V].ob[id] ?? 0) < 2) continue;
    const cnt = u.length > 2 ? (u[2] as number) : (state.world.catalog.get(u[1])?.unitSize ?? 1);
    if (cnt <= 0) continue;
    eng[u[1]] = (eng[u[1]] ?? 0) + cnt;
    const kc = Math.min(cnt, X[V].kc[id] ?? 0);
    if (kc > 0) lost[u[1]] = (lost[u[1]] ?? 0) + kc;
  }
  return { nations: [...b[E].nations], engaged: list(eng), losses: list(lost) };
}

export function summaryFor(state: EngineState, b: BattleSt, viewer: NationId): BattleReportSummary {
  const V = sideOfB(b, viewer);
  const X = b.x;
  const base: BattleReportSummary = {
    id: b.id,
    at: b.at,
    provinceId: b.pid,
    startedAt: b.start,
    endedAt: b.end,
    title: b.title,
    attacker: exactSide(b.a),
    defender: exactSide(b.d),
    outcome: b.outcome,
  };
  if (!X || !V) return base;
  if (V === 'a') base.defender = seenSide(state, b, X, 'a');
  else base.attacker = seenSide(state, b, X, 'd');
  base.domain = domainOf(b, X);
  base.mySide = sideName(V);
  const tot = (s: BattleSide, k: 'engaged' | 'losses') => s[k].reduce((n, x) => n + x.count, 0);
  const engaged = tot(base.attacker, 'engaged') + tot(base.defender, 'engaged');
  const lost = tot(base.attacker, 'losses') + tot(base.defender, 'losses');
  base.intensity = engaged > 0 ? Math.round(Math.min(1, lost / engaged) * 100) / 100 : 0;
  return base;
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

export function reportFor(state: EngineState, b: BattleSt, viewer: NationId): BattleReport {
  const V = sideOfB(b, viewer);
  const X = b.x;
  const hidden = (id: string): number => {
    // Niveau auquel le lecteur connaît une unité : 3 pour son camp, sinon ce que son camp a vu.
    if (!X || !V) return 3;
    const u = b.units[id];
    if (!u || b[V].nations.includes(u[0])) return 3;
    return X[V].ob[id] ?? 0;
  };
  const report: BattleReport = {
    ...summaryFor(state, b, viewer),
    countermeasures: Object.keys(b.cm)
      .sort()
      .map((kind) => ({ kind, text: CM_TEXT[kind] ?? kind, count: b.cm[kind]! })),
    timeline: b.timeline
      .filter((x) => !x.u || x.u.every((id) => hidden(id) >= 2))
      .map((x) => ({ t: x.t, text: x.text })),
    replay: {
      t0: b.start,
      t1: b.end ?? b.last,
      frames: b.frames.map((f) => ({
        t: f.t,
        units: f.units
          .filter((u) => hidden(u.id) > 0)
          // Clés dans un ordre fixe : rapport identique après une reprise d'instantané.
          .map((u) => ({
            id: u.id,
            owner: u.owner,
            systemId: hidden(u.id) >= 2 ? u.systemId : '',
            at: [u.at[0], u.at[1]] as [number, number],
            hp: u.hp,
          })),
      })),
      shots: b.shots.map((s) => {
        const vis = !s.u || hidden(s.u) > 0;
        return {
          t: s.t,
          from: vis ? s.from : s.to,
          to: s.to,
          cls: s.cls,
          hit: s.hit,
        };
      }),
    },
  };
  if (X && V) report.aar = aarOf(state, b, X, V);
  return report;
}
