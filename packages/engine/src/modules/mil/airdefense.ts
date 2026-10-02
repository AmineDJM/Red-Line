import {
  MINUTE,
  distanceKm,
  type AirThreat,
  type LngLat,
  type NationId,
  type ProvinceId,
  type UnitView,
} from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { destroyUnit, inflict, jammingFor } from '../../combat/combat.js';
import { otherOf, unitPairKey } from '../../encounters/pairs.js';
import { ceasefire, hostile, inRange } from '../../encounters/profile.js';
import { aiOrder } from '../../ai/trace.js';
import { operations } from '../../ai/strategy.js';
import { atWar, sightLevel, sortedKeys, sortedSet, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { board } from '../kit.js';
import { modifier, unitModifier } from '../registry.js';
import { adProfile, adSysProfile, envOf, threatOf, type AdEnv, type AdProf } from './ad-profile.js';
import {
  battleFor,
  countermeasure,
  engage,
  recordInterception,
  shot,
  sideOf,
  timeline,
  touch,
} from './battles.js';
import { mil, milBal, type BattleSt, type MilState } from './state.js';
import { statOf } from './stats.js';
import { OK, airfieldsOf, cityOf, fail, failR, posOf, roll, schedule } from './util.js';

/**
 * Défense antiaérienne : interception de tout ce qui vole (docs/defense-aerienne.md).
 *
 * Une batterie (fiche `interceptor`) surveille les menaces hostiles visibles qui entrent dans son
 * enveloppe propre à leur catégorie (avions, hélicoptères, drones, missiles de croisière, balistiques,
 * hypersoniques ; ad-profile.ts). Chaque menace entrée est programmée après le délai de réaction
 * (« intercepteur>menace » dans `icq`) ; à l'heure dite, la batterie traite d'un bloc toutes ses
 * menaces dues, par priorité : ordre du joueur, puis catégorie la plus dangereuse (équilibrage), menace
 * qui vise sa bulle (ce qu'elle protège), impact le plus proche. Par menace : intercepteurs par cible
 * selon la doctrine (tir en salve, ou tir-observation-tir pour les fiches anciennes), dans la limite du
 * magasin (rechargement progressif) et des canaux de tir de la fenêtre d'engagement ; au-delà, les
 * menaces passent (saturation). pk = pk de l'enveloppe × portée (pleine au cœur, dégradée en limite) ×
 * (1 − évasion du missile, ou furtivité de l'aéronef) × recherche × (1 − brouillage).
 *
 * Missiles et munitions rôdeuses (salves) : chaque intercepteur au but retire un missile ; réengagement
 * à la fenêtre suivante tant que la salve reste dans l'enveloppe avant l'impact. Aéronefs : chaque
 * élément abattu est retiré (dégâts = points de vie d'un élément) ; réengagement après
 * `aircraftReengageMinutes`. Les systèmes sans enveloppes détaillées n'interceptent que les salves
 * (aéronefs engagés en rounds de combat, comportement d'origine).
 */

const key = (i: string, t: string): string => `${i}>${t}`;

function drop(m: MilState, k: string): void {
  delete m.icq[k];
  if (m.adf) delete m.adf[k];
}

/** Intercepteurs disponibles à l'instant t (rechargement progressif depuis le dernier tir). */
export function ammoAt(
  state: EngineState,
  I: Unit,
  prof: AdProf,
  t: number,
): { left: number; full: number } {
  const full = Math.max(1, Math.round(prof.magazine * I.count));
  const e = mil(state).mag[I.id];
  if (!e) return { left: full, full };
  const [left0, t0] = e;
  if (t0 < 0) return { left: full, full };
  const refill = prof.reloadMs > 0 ? ((t - t0) / prof.reloadMs) * full : full;
  return { left: Math.min(full, Math.max(0, left0 + refill)), full };
}

/** Une salve de missiles peut-elle être interceptée par I (guerre, ou allié visé) ? */
function interceptHostile(state: EngineState, I: Unit, M: Unit): boolean {
  if (I.owner === M.owner) return false;
  if (atWar(state, I.owner, M.owner)) return !ceasefire(state, I.owner, M.owner);
  // Défense d'un allié visé (même alliance) : on intercepte ce qui le vise.
  const st = mil(state).msl[M.id];
  const b = board(state);
  const ally =
    st?.victim && b.allianceOf[I.owner] && b.allianceOf[I.owner] === b.allianceOf[st.victim];
  return !!ally;
}

function canEngage(state: EngineState, I: Unit, T: Unit, forced: boolean): boolean {
  if (T.owner === I.owner) return false;
  if (T.role === 'missile') return !!mil(state).msl[T.id] && interceptHostile(state, I, T);
  // Posture « tenir » : feu seulement sur ordre.
  if (I.stance === 'hold' && !forced) return false;
  return hostile(state, I, T);
}

/** Menace candidate (validée) d'une batterie. */
function candidate(
  state: EngineState,
  I: Unit,
  prof: AdProf,
  T: Unit,
  forced: boolean,
): { c: AirThreat; e: AdEnv; d: number } | null {
  const c = threatOf(state, T);
  if (!c) return null;
  const e = envOf(state, I, prof, c);
  if (!e) return null;
  const pair = state.pairs[unitPairKey(I.id, T.id)];
  if (!pair || !inRange(e, pair.d)) return null;
  if (sightLevel(state, I.owner, T.id) === 0) return null;
  if (!canEngage(state, I, T, forced)) return null;
  return { c, e, d: pair.d };
}

/** Crochet onCombatRefresh : programme les engagements des menaces entrées dans l'enveloppe. */
export function scheduleInterceptions(state: EngineState, I: Unit): void {
  const prof = adProfile(state, I);
  if (!prof) return;
  const m = mil(state);
  let anyMsl = false;
  for (const _ in m.msl) {
    anyMsl = true;
    break;
  }
  if (!anyMsl && !prof.explicit) return;
  const pk = state.rt.pairsOf.get(I.id);
  let ids: string[];
  if (!prof.explicit) {
    // Salves seulement : on parcourt le plus petit des deux ensembles, puis on trie.
    if (pk && pk.size < Object.keys(m.msl).length) {
      ids = [];
      for (const k of pk) {
        if (k.includes('#')) continue;
        const o = otherOf(k, I.id);
        if (m.msl[o]) ids.push(o);
      }
      ids.sort();
    } else ids = Object.keys(m.msl).sort();
  } else {
    if (!pk) return;
    ids = [];
    for (const k of pk) {
      if (k.includes('#')) continue;
      const o = otherOf(k, I.id);
      const T = state.units[o];
      if (T && T.owner !== I.owner && (m.msl[o] || (T.role !== 'missile' && threatOf(state, T))))
        ids.push(o);
    }
    ids.sort();
  }
  for (const id of ids) {
    const T = state.units[id];
    if (!T || T.owner === I.owner) continue;
    const k = key(I.id, id);
    if (m.icq[k] !== undefined) continue;
    if (!candidate(state, I, prof, T, !!m.adf?.[k])) continue;
    const t = state.time + prof.reactionMs;
    m.icq[k] = t;
    schedule(state, t, 'icpt', { i: I.id, m: id });
  }
}

/** Événement d'engagement (programmé par menace ; la batterie traite toutes ses menaces dues). */
export function handleIntercept(state: EngineState, d: { i: string; m: string }): void {
  const m = mil(state);
  const v = m.icq[key(d.i, d.m)];
  if (v === undefined || v < 0 || v > state.time) return;
  cycle(state, d.i, d.m);
}

interface Cand {
  T: Unit;
  k: string;
  c: AirThreat;
  e: AdEnv;
  w: number;
  tie: number;
}

function cycle(state: EngineState, iid: string, trigger: string): void {
  const m = mil(state);
  const I = state.units[iid];
  const prof = I ? adProfile(state, I) : null;
  if (!I || !prof) {
    drop(m, key(iid, trigger));
    return;
  }
  const now = state.time;
  const bal = milBal(state);
  // Menaces dues : la menace déclenchante et, pour une défense à enveloppes, toutes celles de la
  // batterie dont l'heure est venue (traitées ensemble, par priorité).
  const due: string[] = [trigger];
  if (prof.explicit) {
    for (const pk of state.rt.pairsOf.get(iid) ?? []) {
      if (pk.includes('#')) continue;
      const o = otherOf(pk, iid);
      if (o === trigger) continue;
      const v = m.icq[key(iid, o)];
      if (v !== undefined && v >= 0 && v <= now) due.push(o);
    }
    due.sort();
  }
  const ipos = posOf(state, I);
  const pri = bal.airDefense.priority;
  const cands: Cand[] = [];
  for (const id of due) {
    const k = key(iid, id);
    const T = state.units[id];
    const forced = !!m.adf?.[k];
    const ok = T ? candidate(state, I, prof, T, forced) : null;
    if (!T || !ok) {
      drop(m, k);
      continue;
    }
    let w = pri[ok.c] * (forced ? 1000 : 1);
    let tie = ok.d;
    const st = m.msl[id];
    if (st) {
      tie = st.impactAt;
      if (distanceKm(st.aim, ipos) <= prof.maxKm) w *= bal.airDefense.protectFactor;
    }
    cands.push({ T, k, c: ok.c, e: ok.e, w, tie });
  }
  if (cands.length === 0) return;
  if (cands.length > 1)
    cands.sort((a, b) => b.w - a.w || a.tie - b.tie || (a.T.id < b.T.id ? -1 : 1));
  const { left: avail } = ammoAt(state, I, prof, now);
  let left = avail;
  const winMs = bal.intercept.reengageMinutes * MINUTE;
  let [ws, used] = m.icw[iid] ?? [now, 0];
  // `now >= ws + winMs` (et non `now - ws >= winMs`) : l'événement de la fenêtre suivante est
  // programmé à `ws + winMs` ; la soustraction flottante peut donner winMs − ε à cet instant précis.
  if (now >= ws + winMs) {
    ws = now;
    used = 0;
  }
  const cap = Math.max(
    1,
    Math.round(I.count * (prof.channels ?? bal.intercept.channelsPerElement)),
  );
  let fired = 0;
  let exhausted = false;
  for (const cd of cands) {
    if (!state.units[cd.T.id]) {
      drop(m, cd.k);
      continue;
    }
    const shots = Math.floor(left + 1e-9);
    if (shots <= 0) {
      // Magasin vide : la menace passe cette défense (comptée une fois, reprise au rechargement).
      const st = m.msl[cd.T.id];
      const b = st?.battle ? m.battles[st.battle] : undefined;
      if (b) countermeasure(b, 'saturation', cd.T.count);
      m.icq[cd.k] = -1;
      exhausted = true;
      continue;
    }
    const free = cap - used;
    if (free <= 0) {
      // Tous les canaux sont pris (saturation) : fenêtre suivante, sauf si la salve frappe avant.
      const st = m.msl[cd.T.id];
      if (st && ws + winMs >= st.impactAt) {
        const b = st.battle ? m.battles[st.battle] : undefined;
        if (b) countermeasure(b, 'saturation', cd.T.count);
        drop(m, cd.k);
        continue;
      }
      m.icq[cd.k] = ws + winMs;
      schedule(state, ws + winMs, 'icpt', { i: iid, m: cd.T.id });
      continue;
    }
    const n = engageThreat(state, I, prof, cd, Math.min(shots, free), winMs);
    left -= n;
    used += n;
    fired += n;
  }
  m.icw[iid] = [ws, used];
  if (fired > 0) m.mag[iid] = [left, now];
  // Magasin vide : réveil au premier intercepteur rechargé (menaces passées reprises).
  if (left < 1 && (fired > 0 || exhausted)) wake(state, I, prof, left);
}

function wake(state: EngineState, I: Unit, prof: AdProf, left: number): void {
  const full = Math.max(1, Math.round(prof.magazine * I.count));
  const t1 = state.time + Math.max(MINUTE, ((1 - left) / full) * prof.reloadMs);
  schedule(state, t1, 'adrl', { i: I.id });
}

/** pk d'un intercepteur contre une menace (et brouillage subi). */
function pkOf(
  state: EngineState,
  I: Unit,
  prof: AdProf,
  cd: Cand,
  dist: number,
): { pk: number; jam: number } {
  const bal = milBal(state).airDefense;
  const isys = sysOf(state, I);
  const tsys = sysOf(state, cd.T);
  let pk = cd.e.pk;
  if (prof.explicit) {
    const near = cd.e.max * bal.fullPkShare;
    if (dist > near && cd.e.max > near)
      pk *= 1 - (1 - bal.farPkFactor) * Math.min(1, (dist - near) / (cd.e.max - near));
  }
  if (cd.T.role === 'missile') pk *= 1 - (tsys.missile?.evasion ?? 0);
  else {
    const sd = isys.sensor?.stealthDetect ?? 0;
    pk *= 1 - Math.min(1, tsys.stealth * (1 - sd) * bal.stealthPkFactor);
  }
  const jam = jammingFor(state, cd.T) * (1 - isys.ew.jamResistance);
  // Même ordre des produits que le calcul d'origine (résultats identiques pour les fiches anciennes).
  pk =
    pk *
    modifier(state, I.owner, 'missiles.interception') *
    unitModifier(state, I, 'missiles.interception') *
    (1 - jam);
  return { pk: Math.max(0, Math.min(0.98, pk)), jam };
}

/** Rapport après action : menaces abattues par catégorie et intercepteurs tirés par ce camp. */
function recordAd(b: BattleSt, by: NationId, c: AirThreat, killed: number, fired: number): void {
  const s = sideOf(b, by);
  const X = b.x;
  if (!s || !X) return;
  const S = X[s];
  if (killed > 0) {
    S.ic ??= {};
    S.ic[c] = (S.ic[c] ?? 0) + killed;
  }
  if (fired > 0) S.ifd = (S.ifd ?? 0) + fired;
}

/** Engage une menace avec au plus `avail` intercepteurs ; renvoie le nombre tirés. */
function engageThreat(
  state: EngineState,
  I: Unit,
  prof: AdProf,
  cd: Cand,
  avail: number,
  winMs: number,
): number {
  const m = mil(state);
  const T = cd.T;
  const now = state.time;
  const ipos = posOf(state, I);
  const tpos = posOf(state, T);
  const { pk, jam } = pkOf(state, I, prof, cd, distanceKm(ipos, tpos));
  const elems = T.count;
  let fired = 0;
  let killed = 0;
  /** Éléments de la menace pris à partie (les autres : faute de canaux ou de munitions). */
  let engaged = Math.min(elems, avail);
  if (prof.explicit) {
    // Doctrine : salve de `shots` intercepteurs par cible (un coup au but suffit).
    engaged = 0;
    for (let j = 0; j < elems && fired < avail; j++) {
      engaged++;
      const n = Math.min(cd.e.shots, avail - fired);
      let hit = false;
      for (let s = 0; s < n; s++) {
        fired++;
        if (roll(state) < pk) hit = true;
      }
      if (hit) killed++;
    }
  } else {
    // Fiches anciennes : tir-observation-tir, un intercepteur par missile et par passe.
    let remaining = elems;
    for (let pass = 0; pass < cd.e.shots && fired < avail; pass++) {
      const targets = remaining;
      for (let j = 0; j < targets && fired < avail; j++) {
        fired++;
        if (roll(state) < pk) {
          remaining--;
          killed++;
        }
      }
    }
  }
  const isys = sysOf(state, I);
  const tsys = sysOf(state, T);
  if (T.role === 'missile') {
    const st = m.msl[T.id]!;
    const b = st.battle ? m.battles[st.battle] : battleFor(state, I.owner, T.owner, tpos);
    if (b) {
      engage(state, b, I);
      countermeasure(b, 'interception', killed);
      recordInterception(b, I.owner, T.owner, killed);
      recordAd(b, I.owner, cd.c, killed, fired);
      countermeasure(b, 'evasion', fired - killed);
      if (jam > 0) countermeasure(b, 'jamming', 1);
      shot(state, b, ipos, tpos, 'missile', killed > 0, I);
      timeline(
        state,
        b,
        `${isys.name} (${I.owner.toUpperCase()}) : ${killed}/${T.count} ${tsys.name} interceptés (${fired} tirs)`,
        [I],
      );
      touch(state, b);
    }
    statOf(state, I.owner).intercepted += killed;
    I.xp += killed * tsys.hp;
    if (killed >= T.count) {
      drop(m, cd.k);
      destroyUnit(state, T, I);
      return fired;
    }
    if (killed > 0) {
      T.count -= killed;
      T.hp = Math.min(T.hp, T.count * tsys.hp);
      T.maxHp = T.count * tsys.hp;
      state.rt.dirtyCombat.add(T.id);
    }
    const next = now + winMs;
    if (next < st.impactAt) {
      m.icq[cd.k] = next;
      schedule(state, next, 'icpt', { i: I.id, m: T.id });
    } else {
      // Dernière occasion avant l'impact : les missiles non pris à partie passent (saturation).
      if (b && engaged < elems) countermeasure(b, 'saturation', elems - engaged);
      drop(m, cd.k);
    }
    return fired;
  }
  // Aéronef, hélicoptère ou drone : éléments abattus.
  const b = battleFor(state, I.owner, T.owner, tpos);
  engage(state, b, I);
  recordAd(b, I.owner, cd.c, killed, fired);
  if (jam > 0) countermeasure(b, 'jamming', 1);
  if (killed < elems) countermeasure(b, 'evasion', Math.max(0, fired - killed));
  if (killed > 0) {
    timeline(
      state,
      b,
      `${isys.name} (${I.owner.toUpperCase()}) : ${killed}/${elems} ${tsys.name} abattus (${fired} tirs)`,
      [I, T],
    );
    const per = T.mix ? T.maxHp / Math.max(1, T.count) : tsys.hp;
    // Coup au but : enregistré (tir, pertes, rapport) par le crochet onDamage.
    inflict(state, I, T, Math.min(T.hp, killed * per));
  } else {
    shot(state, b, ipos, tpos, threatClass(cd.c), false, I);
    touch(state, b);
  }
  if (state.units[T.id]) {
    const next = now + milBal(state).airDefense.aircraftReengageMinutes * MINUTE;
    m.icq[cd.k] = next;
    schedule(state, next, 'icpt', { i: I.id, m: T.id });
  } else drop(m, cd.k);
  return fired;
}

function threatClass(c: AirThreat): 'aircraft' | 'helicopter' | 'drone' | 'missile' {
  return c === 'aircraft' || c === 'helicopter' || c === 'drone' ? c : 'missile';
}

/** Réveil d'une batterie dont le magasin était vide : les menaces passées sont reprises. */
export function handleAdReload(state: EngineState, d: { i: string }): void {
  const I = state.units[d.i];
  const prof = I ? adProfile(state, I) : null;
  if (!I || !prof) return;
  const m = mil(state);
  const { left } = ammoAt(state, I, prof, state.time);
  if (left < 1) {
    // Effectif réduit entre-temps (rechargement plus lent) : nouveau réveil.
    wake(state, I, prof, left);
    return;
  }
  const prefix = `${d.i}>`;
  // Suppressions seulement : l'ordre de parcours est sans effet.
  for (const k in m.icq) if (m.icq[k] === -1 && k.startsWith(prefix)) delete m.icq[k];
  state.rt.dirtyCombat.add(d.i);
}

/** Nettoyage à la disparition d'une unité (salve, aéronef ou batterie). */
export function forgetMissile(state: EngineState, id: string): void {
  const m = mil(state);
  delete m.msl[id];
  let any = false;
  for (const _ in m.icq) {
    any = true;
    break;
  }
  if (!any && !m.adf) return;
  const suffix = `>${id}`;
  const prefix = `${id}>`;
  for (const k of Object.keys(m.icq))
    if (k.endsWith(suffix) || k.startsWith(prefix)) delete m.icq[k];
  if (m.adf) {
    for (const k of Object.keys(m.adf))
      if (k.endsWith(suffix) || k.startsWith(prefix)) delete m.adf[k];
    if (Object.keys(m.adf).length === 0) delete m.adf;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Ordres                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

const THREAT_FR: Record<AirThreat, string> = {
  aircraft: 'les avions',
  helicopter: 'les hélicoptères',
  drone: 'les drones',
  cruise_missile: 'les missiles de croisière',
  ballistic_missile: 'les missiles balistiques',
  hypersonic: 'les missiles hypersoniques',
};

const km = (x: number): number => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));

type Refusal = OrderResult & { ok: false };

/**
 * Contrôle d'un ordre d'interception par `u` sur la cible volante `t` : catégorie engagée, distance
 * dans l'enveloppe, intercepteurs disponibles. Null si accepté.
 */
export function adOrderCheck(state: EngineState, u: Unit, t: Unit): Refusal | null {
  const s = sysOf(state, u);
  const prof = adProfile(state, u);
  const c = threatOf(state, t);
  if (!prof || !c) {
    return failR(
      'invalid_target',
      'cannot_hit_class',
      `${s.name} ne peut pas toucher ce type de cible.`,
      { name: s.name, cls: t.role === 'missile' ? 'missile' : sysOf(state, t).targetClass },
    ) as Refusal;
  }
  const e = envOf(state, u, prof, c);
  if (!e) {
    return failR(
      'invalid_target',
      'ad_cannot_engage',
      `${s.name} n’intercepte pas ${THREAT_FR[c]}.`,
      { name: s.name, cat: c },
    ) as Refusal;
  }
  const pair = state.pairs[unitPairKey(u.id, t.id)];
  const live = distanceKm(posOf(state, u), posOf(state, t));
  const d = pair ? pair.d : live;
  if (!inRange(e, d)) {
    return failR(
      'out_of_range',
      'ad_out_of_range',
      `${s.name} — hors de portée : ${Math.round(live)} km, portée ${km(e.min)}–${km(e.max)} km contre ${THREAT_FR[c]}.`,
      { name: s.name, dist: Math.round(live), min: km(e.min), max: km(e.max), cat: c },
    ) as Refusal;
  }
  if (ammoAt(state, u, prof, state.time).left < 1) {
    return failR(
      'insufficient_resources',
      'ad_no_ammo',
      `${s.name} : plus d’intercepteurs, rechargement en cours.`,
      { name: s.name },
    ) as Refusal;
  }
  return null;
}

/** Engagement ordonné : priorité absolue, tir immédiat (après la fenêtre de canaux en cours). */
export function forceEngagement(state: EngineState, I: Unit, t: Unit): void {
  const m = mil(state);
  const k = key(I.id, t.id);
  (m.adf ??= {})[k] = 1;
  const v = m.icq[k];
  if (v !== undefined && v >= 0 && v <= state.time) return;
  m.icq[k] = state.time;
  schedule(state, state.time, 'icpt', { i: I.id, m: t.id });
}

/** Ordre d'attaque sur une salve de missiles en vol : interception par les unités capables. */
export function orderInterceptMissile(
  state: EngineState,
  n: NationId,
  units: Unit[],
  M: Unit,
): OrderResult {
  if (M.owner === n) return failR('invalid_target', 'target_friendly', 'Cible amie.');
  if (!mil(state).msl[M.id]) return failR('invalid_target', 'target_invalid', 'Cible invalide.');
  if (sightLevel(state, n, M.id) === 0) {
    return failR(
      'invalid_target',
      'target_not_visible',
      'Cible hors de vue : repérez-la d’abord (radar, reconnaissance, satellite).',
    );
  }
  const ok: Unit[] = [];
  const refused: Refusal[] = [];
  for (const u of units) {
    const err = adOrderCheck(state, u, M);
    if (err) refused.push(err);
    else if (!interceptHostile(state, u, M))
      refused.push(
        failR(
          'invalid_target',
          'target_invalid',
          'Missile d’une nation avec laquelle vous n’êtes pas en guerre.',
        ) as Refusal,
      );
    else ok.push(u);
  }
  if (ok.length === 0) return refused[0] ?? fail('invalid_target', 'Cible invalide.');
  for (const u of ok) forceEngagement(state, u, M);
  if (refused.length) {
    const names = refused.map((r) => r.message).join(' ');
    return {
      ok: true,
      reason: 'partial',
      message: `Ordre transmis ; ${refused.length} pile(s) écartée(s) : ${names}`,
      params: { count: refused.length, detail: names },
    };
  }
  return OK;
}

/* ------------------------------------------------------------------------------------------------ */
/* Vue                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/** Magasin d'une batterie (vue du propriétaire). */
export function airDefenseView(state: EngineState, u: Unit, v: UnitView): void {
  const s = sysOf(state, u);
  if (!s.interceptor || u.role) return;
  const prof = adSysProfile(state, s);
  if (!prof) return;
  const { left, full } = ammoAt(state, u, prof, state.time);
  v.airDefense = {
    ammo: Math.floor(left + 1e-9),
    max: full,
    fullAt:
      left >= full || prof.reloadMs <= 0
        ? null
        : Math.round(state.time + ((full - left) / full) * prof.reloadMs),
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* IA                                                                                               */
/* ------------------------------------------------------------------------------------------------ */

interface AdUnit {
  u: Unit;
  prof: AdProf;
  /** Position, ou destination si la batterie se redéploie. */
  dest: LngLat;
  pos: LngLat;
  /** Rayon couvert (part de sa portée principale). */
  cover: number;
  ammo: number;
}

interface Point {
  pid: ProvinceId;
  at: LngLat;
  want: number;
  w: number;
  front: boolean;
}

/** Portée principale d'une batterie : contre les avions, sinon la plus grande. */
function mainKm(prof: AdProf): number {
  return prof.env.aircraft?.max ?? prof.maxKm;
}

/**
 * IA (nation en guerre) : la défense antiaérienne mobile protège la capitale, les bases aériennes et
 * les villes du front (ennemi vu à moins de `frontKm`). Chaque point veut un nombre de batteries ; une
 * batterie le couvre si elle est (ou se rend) à moins d'une part de sa portée principale. Les batteries
 * libres les plus proches sont envoyées, celles dont le magasin est bas ne partent pas au front et y
 * sont relevées (retour vers la capitale pour recharger). Au plus `movesPerThink` ordres.
 */
export function airDefenseAi(state: EngineState, n: NationId): void {
  if (!state.rt.enemies.get(n)?.size) return;
  const cfg = milBal(state).airDefense.ai;
  if (cfg.movesPerThink <= 0) return;
  // Une réflexion sur `everyThinks` (décalée par nation) : un redéploiement prend des heures.
  const every = Math.max(1, Math.round(cfg.everyThinks));
  const tick = Math.round(state.time / (state.world.balance.time.aiThinkMinutes * MINUTE));
  if ((tick + state.nationIds.indexOf(n)) % every !== 0) return;
  const m = mil(state);
  const ops = operations(state, n);
  const inOps = new Set<string>();
  for (const pid of sortedKeys(ops)) for (const id of ops[pid]!.units) inOps.add(id);
  const ads: AdUnit[] = [];
  for (const id of sortedSet(state.rt.byNation.get(n))) {
    const u = state.units[id]!;
    if (u.role || u.off || m.fixedOf[id] || inOps.has(id) || u.target) continue;
    const s = sysOf(state, u);
    if (!s.interceptor || s.movement !== 'land' || s.speedKmh <= 0) continue;
    const prof = adSysProfile(state, s);
    if (!prof) continue;
    const pos = posOf(state, u);
    const legs = u.move?.legs;
    const dest = legs && legs.length ? legs[legs.length - 1]!.to : pos;
    const { left, full } = ammoAt(state, u, prof, state.time);
    ads.push({
      u,
      prof,
      dest,
      pos,
      cover: Math.max(5, mainKm(prof) * cfg.coverShare),
      ammo: left / full,
    });
  }
  if (ads.length === 0) return;
  const w = wi(state.world);
  const points: Point[] = [];
  const seen = new Set<string>();
  const add = (pid: ProvinceId, want: number, wt: number, front: boolean): void => {
    if (want <= 0 || seen.has(pid) || state.provinces[pid]?.owner !== n) return;
    const at = cityOf(state, pid);
    if (!at) return;
    seen.add(pid);
    points.push({ pid, at, want: Math.round(want), w: wt, front });
  };
  const cap = w.nationById.get(n)?.capitalProvinceId;
  if (cap) add(cap, cfg.capital, 3, false);
  // Villes du front : villes à elle proches d'un ennemi vu (les plus menacées d'abord).
  const known = state.know[n];
  const near = new Map<ProvinceId, number>();
  if (known && cfg.front > 0) {
    // Ennemis vus (au plus 40), puis distance de chacune de ses villes au plus proche.
    const foes: LngLat[] = [];
    for (const id of sortedKeys(known)) {
      const c = known[id]!;
      if (!c.seen || !atWar(state, n, c.owner)) continue;
      const t = state.units[id];
      if (!t || t.role === 'missile') continue;
      foes.push(posOf(state, t));
      if (foes.length >= 40) break;
    }
    if (foes.length > 0) {
      for (const pid of sortedSet(state.rt.provsOf.get(n))) {
        const at = w.provById.get(pid)?.cityPoint;
        if (!at) continue;
        let d = Infinity;
        for (const f of foes) {
          const x = distanceKm(at, f);
          if (x < d) d = x;
        }
        if (d <= cfg.frontKm) near.set(pid, d);
      }
    }
  }
  const front = [...near].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
  for (const [pid] of front) add(pid, cfg.front, 2.5, true);
  for (const pid of airfieldsOf(state, n).slice(0, 8)) add(pid, cfg.airBase, 2, false);
  points.sort((a, b) => b.w - a.w || (a.pid < b.pid ? -1 : 1));

  const covering = (a: AdUnit, p: Point): boolean => distanceKm(a.dest, p.at) <= a.cover;
  const busy = new Set<string>();
  // Batteries déjà en place (ou en route) : elles tiennent leur point.
  const need = new Map<string, number>();
  for (const p of points) {
    let have = 0;
    for (const a of ads) {
      if (!covering(a, p)) continue;
      if (p.front && a.ammo < cfg.minAmmoShare) continue;
      busy.add(a.u.id);
      have++;
    }
    need.set(p.pid, p.want - have);
  }
  let moves = 0;
  const send = (a: AdUnit, to: LngLat): boolean => {
    if (moves >= cfg.movesPerThink) return false;
    moves++;
    if (!aiOrder(state, n, { kind: 'move', unitIds: [a.u.id], to }).ok) return false;
    a.dest = to;
    busy.add(a.u.id);
    return true;
  };
  const capAt = cap ? cityOf(state, cap) : null;
  for (const p of points) {
    let deficit = need.get(p.pid) ?? 0;
    if (deficit <= 0) continue;
    const cands = ads
      .filter(
        (a) =>
          !busy.has(a.u.id) &&
          (!p.front || a.ammo >= cfg.minAmmoShare) &&
          distanceKm(a.pos, p.at) <= cfg.reachKm,
      )
      .map((a) => ({ a, d: distanceKm(a.pos, p.at) }))
      .sort((x, y) => x.d - y.d || (x.a.u.id < y.a.u.id ? -1 : 1));
    for (const { a } of cands) {
      if (deficit <= 0 || moves >= cfg.movesPerThink) break;
      if (send(a, p.at)) deficit--;
    }
    if (moves >= cfg.movesPerThink) break;
    // Relève : une batterie à court d'intercepteurs quitte le front pour recharger à l'arrière.
    if (p.front && capAt && deficit < (need.get(p.pid) ?? 0)) {
      for (const a of ads) {
        if (moves >= cfg.movesPerThink) break;
        if (busy.has(a.u.id) || a.u.move || a.ammo >= cfg.minAmmoShare || !covering(a, p)) continue;
        send(a, capAt);
      }
    }
  }
}
