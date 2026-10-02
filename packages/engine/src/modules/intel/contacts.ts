import {
  HOUR,
  MINUTE,
  destination,
  distanceKm,
  movementDestination,
  movementEnd,
  type LngLat,
  type NationId,
  type UnitView,
} from '@redline/shared';
import type { EngineState, Unit } from '../../state/types.js';
import { sightLevel, sortedKeys, sysOf, unitPosAt } from '../../state/access.js';
import { scheduleMod } from '../kit.js';
import { cfg } from './config.js';
import { allied, hash01, quality, roll } from './levels.js';
import { publish } from './reports.js';
import { ist, nextId, type Decoy } from './state.js';
import { CATEGORY_LABEL, approx, cardinal, fmtTime, nationName, natDe, sectorOf } from './text.js';
import { loc } from '@redline/shared';
import { sectorLoc } from './text.js';

/**
 * Contacts issus du renseignement : ils enrichissent `state.know` (connaissance de la nation) comme des
 * contacts perdus datés, avec une incertitude initiale (`unc`). Ils ne donnent jamais le droit de tirer
 * (réservé à l'observation par un capteur, `state.sight`) et sont effacés par une vraie observation.
 */
export function revealContact(
  state: EngineState,
  n: NationId,
  u: Unit,
  lvl: 1 | 2,
  uncKm: number,
): boolean {
  if (u.owner === n) return false;
  if (sightLevel(state, n, u.id) > 0) return false;
  let known = state.know[n];
  if (!known) known = state.know[n] = {};
  const prev = known[u.id];
  if (prev?.seen) return false;
  const t = state.time;
  const truePos = unitPosAt(state, u, t);
  // Position décalée de façon déterministe dans le cercle d'incertitude.
  const off = uncKm * 0.5 * hash01('c', n, u.id, t);
  const pos = off > 0.1 ? destination(truePos, 360 * hash01('b', n, u.id, t), off) : truePos;
  const keepLvl = prev && prev.lastSeen === t ? Math.max(prev.lvl, lvl) : lvl;
  known[u.id] = {
    owner: u.owner,
    lvl: keepLvl,
    seen: false,
    since: t,
    lastSeen: t,
    pos,
    sys: keepLvl >= 2 ? u.sys : (prev?.sys ?? null),
    count: null,
    hpr: null,
    status: null,
    unc: Math.round(uncKm),
  };
  return true;
}

/** Point brouillé contre l'observateur `n` (brouillage d'une nation non alliée). */
export function jammedFor(state: EngineState, n: NationId, at: LngLat): boolean {
  const st = ist(state);
  for (const id of sortedKeys(st.jams)) {
    const j = st.jams[id]!;
    if (j.until < state.time || allied(state, j.owner, n)) continue;
    if (distanceKm(j.at, at) <= j.r) return true;
  }
  return false;
}

// ——— Écoute d'une zone ———

export function startListen(
  state: EngineState,
  n: NationId,
  at: LngLat,
  r: number,
  lvl: 1 | 2,
): string {
  const c = cfg(state);
  const id = nextId(state, 'l');
  ist(state).listens[id] = {
    id,
    owner: n,
    at,
    r,
    until: state.time + c.listenHours * HOUR,
    lvl,
    reported: false,
  };
  listenTick(state, id);
  return id;
}

export function listenTick(state: EngineState, id: string): void {
  const st = ist(state);
  const L = st.listens[id];
  if (!L) return;
  if (state.time > L.until || !state.nations[L.owner]?.alive) {
    delete st.listens[id];
    return;
  }
  const byOwner = new Map<
    NationId,
    { units: number; elements: number; cats: Map<string, number> }
  >();
  const revealed: string[] = [];
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    if (allied(state, u.owner, L.owner)) continue;
    const pos = unitPosAt(state, u, state.time);
    if (distanceKm(pos, L.at) > L.r) continue;
    if (jammedFor(state, L.owner, pos)) continue;
    const unc = 3 + 12 * hash01('lu', id, uid);
    revealContact(state, L.owner, u, L.lvl as 1 | 2, unc);
    revealed.push(uid);
    let g = byOwner.get(u.owner);
    if (!g) byOwner.set(u.owner, (g = { units: 0, elements: 0, cats: new Map() }));
    g.units++;
    g.elements += u.count;
    const cat = sysOf(state, u).category;
    g.cats.set(cat, (g.cats.get(cat) ?? 0) + u.count);
  }
  if (!L.reported) {
    L.reported = true;
    const q = quality(state, L.owner, 'military');
    const lines: string[] = [];
    if (byOwner.size === 0) {
      lines.push(`Écoute active jusqu'à ${fmtTime(L.until)}, rayon ${Math.round(L.r)} km.`);
      lines.push('Aucun émetteur militaire étranger actif dans la zone.');
    } else {
      lines.push(`Écoute active jusqu'à ${fmtTime(L.until)}, rayon ${Math.round(L.r)} km.`);
      for (const owner of [...byOwner.keys()].sort()) {
        const g = byOwner.get(owner)!;
        const cats = [...g.cats.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, L.lvl >= 2 ? 3 : 0)
          .map(
            ([k, v]) =>
              `${approx(state, v, q)} ${CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL]}`,
          );
        lines.push(
          `• ${nationName(state, owner)} : ${g.units} émetteur(s)` +
            (cats.length ? `, dont ${cats.join(', ')}.` : ', types non identifiés.'),
        );
      }
      lines.push('Contacts reportés sur la carte, positions à rafraîchir.');
    }
    publish(state, L.owner, {
      dept: 'military',
      source: 'sigint',
      kind: 'result',
      title: `Écoute — ${sectorOf(state, L.at)}`,
      titleLoc: loc('engine.intel.listening', { sector: sectorLoc(state, L.at) }),
      lines,
      at: L.at,
      radiusKm: L.r,
      subject: revealed.length ? { unitIds: revealed.slice(0, 50) } : {},
      actions: [{ kind: 'plan_strike', at: L.at }],
      q: Math.max(q, 0.6),
    });
  }
  const next = state.time + cfg(state).listenEveryMin * MINUTE;
  if (next <= L.until) scheduleMod(state, { t: next, m: 'intel', e: 'listen', d: { id } });
  else scheduleMod(state, { t: L.until + 1, m: 'intel', e: 'listen', d: { id } });
}

// ——— Interception des communications d'une armée ———

export function startIntercept(state: EngineState, n: NationId, unitId: string): string {
  const id = nextId(state, 'i');
  ist(state).intercepts[id] = {
    id,
    owner: n,
    unitId,
    until: state.time + cfg(state).interceptHours * HOUR,
    dest: null,
  };
  interceptTick(state, id);
  return id;
}

export function interceptTick(state: EngineState, id: string): void {
  const st = ist(state);
  const I = st.intercepts[id];
  if (!I) return;
  const u = state.units[I.unitId];
  if (!u || state.time > I.until) {
    delete st.intercepts[id];
    return;
  }
  const pos = unitPosAt(state, u, state.time);
  if (!jammedFor(state, I.owner, pos)) {
    revealContact(state, I.owner, u, 2, 2);
    const dest = u.move ? (movementDestination(u.move) ?? null) : null;
    const changed =
      (dest === null) !== (I.dest === null) || (dest && I.dest && distanceKm(dest, I.dest) > 5);
    if (changed || !I.dest) {
      I.dest = dest;
      const sys = sysOf(state, u);
      const lines: string[] = [];
      const who = `${CATEGORY_LABEL[sys.category]} (${sys.name}) ${natDe(state, u.owner)}`;
      if (dest && u.move) {
        lines.push(`Ordre intercepté : ${who} fait mouvement vers ${sectorOf(state, dest)}.`);
        lines.push(
          `Direction ${cardinal(pos, dest)}, arrivée estimée ${fmtTime(movementEnd(u.move))}.`,
        );
      } else {
        lines.push(`Communications de ${who} interceptées : ordre de tenir la position.`);
      }
      if (u.target) {
        const tgt = state.units[u.target];
        if (tgt && tgt.owner === I.owner) lines.push('Une de nos unités est désignée comme cible.');
      }
      lines.push(`Interception maintenue jusqu'à ${fmtTime(I.until)}.`);
      const at = dest ?? pos;
      publish(state, I.owner, {
        dept: 'military',
        source: 'sigint',
        kind: 'result',
        title: `Interception — ${nationName(state, u.owner)}`,
        titleLoc: loc('engine.intel.interception', { nation: { nation: u.owner } }),
        lines,
        at,
        radiusKm: 10,
        subject: { nationId: u.owner, unitIds: [u.id], systemIds: [u.sys] },
        actions: [
          { kind: 'plan_strike', at, unitId: u.id },
          { kind: 'open_unit', unitId: u.id },
        ],
        q: 0.8,
      });
    }
  }
  const next = state.time + HOUR;
  scheduleMod(state, { t: Math.min(next, I.until + 1), m: 'intel', e: 'intercept', d: { id } });
}

export function onUnitGone(state: EngineState, uid: string): void {
  const st = ist(state);
  for (const id of sortedKeys(st.intercepts))
    if (st.intercepts[id]!.unitId === uid) delete st.intercepts[id];
}

// ——— Leurres ———

/** Système le plus représenté dans les forces terrestres d'une nation (crédibilité du leurre). */
function decoySystem(state: EngineState, owner: NationId): string | null {
  const counts = new Map<string, number>();
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    if (u.owner !== owner) continue;
    const s = sysOf(state, u);
    if (s.movement !== 'land') continue;
    counts.set(u.sys, (counts.get(u.sys) ?? 0) + 1);
  }
  let best: string | null = null;
  let bc = 0;
  for (const [k, v] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (v > bc) {
      best = k;
      bc = v;
    }
  }
  if (best) return best;
  for (const [id, s] of [...state.world.catalog.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (s.movement === 'land' && s.enabled) return id;
  return null;
}

export function deployDecoys(
  state: EngineState,
  owner: NationId,
  at: LngLat,
  deceived: NationId[],
  n: number,
): Decoy[] {
  const sys = decoySystem(state, owner);
  if (!sys) return [];
  const spec = state.world.catalog.get(sys)!;
  const out: Decoy[] = [];
  const until = state.time + cfg(state).decoyHours * HOUR;
  for (let i = 0; i < n; i++) {
    // Identifiant pris dans la même série que les vraies unités : indiscernable pour l'adversaire.
    const id = `u${++state.nextUnit}`;
    const pos = i === 0 ? at : destination(at, roll(state) * 360, 4 + roll(state) * 16);
    const d: Decoy = {
      id,
      owner,
      sys,
      pos,
      count: spec.unitSize,
      until,
      deceived: [...deceived].sort(),
      exposed: [],
    };
    ist(state).decoys[id] = d;
    out.push(d);
    scheduleMod(state, { t: until, m: 'intel', e: 'expire', d: { kind: 'decoy', id } });
  }
  return out;
}

/** Vue d'un leurre : unité « identifiée » chez l'adversaire trompé, `decoy: true` chez son propriétaire. */
export function decoyView(state: EngineState, d: Decoy, viewer: NationId): UnitView | null {
  if (d.until < state.time) return null;
  if (viewer === d.owner) {
    return {
      id: d.id,
      owner: d.owner,
      level: 'own',
      pos: d.pos,
      lastSeen: state.time,
      uncertaintyKm: 0,
      systemId: d.sys,
      count: d.count,
      hpRatio: 1,
      status: 'idle',
      decoy: true,
    };
  }
  if (!d.deceived.includes(viewer) || d.exposed.includes(viewer)) return null;
  return {
    id: d.id,
    owner: d.owner,
    level: 'identified',
    pos: d.pos,
    lastSeen: state.time,
    uncertaintyKm: 0,
    systemId: d.sys,
  };
}

/** Démasque les leurres qui trompent `n` (probabilité p chacun) ; renvoie les leurres identifiés. */
export function exposeDecoys(state: EngineState, n: NationId, p: number): Decoy[] {
  const st = ist(state);
  const out: Decoy[] = [];
  for (const id of sortedKeys(st.decoys)) {
    const d = st.decoys[id]!;
    if (!d.deceived.includes(n) || d.exposed.includes(n)) continue;
    if (roll(state) < p) {
      d.exposed.push(n);
      d.exposed.sort();
      out.push(d);
    }
  }
  return out;
}

export function reportExposedDecoys(state: EngineState, n: NationId, found: Decoy[]): void {
  if (found.length === 0) return;
  const q = quality(state, n, 'military');
  const at = found[0]!.pos;
  publish(state, n, {
    dept: 'military',
    source: 'sigint',
    kind: 'counterintel',
    title: 'Leurres identifiés',
    titleLoc: loc('engine.intel.decoysIdentified'),
    lines: [
      `${found.length} contact(s) ${natDe(state, found[0]!.owner)} ${sectorOf(state, at)} identifié(s) comme des leurres.`,
      'Signatures thermiques et radio incohérentes ; contacts retirés de la situation tactique.',
    ],
    at,
    radiusKm: 30,
    subject: { nationId: found[0]!.owner },
    q: Math.max(q, 0.6),
  });
}

export function approxCount(state: EngineState, n: number, q: number): string {
  return approx(state, n, q);
}
