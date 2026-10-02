import {
  MINUTE,
  distanceKm,
  type GeneralTrait,
  type GeneralView,
  type LngLat,
  type NationId,
  type Order,
} from '@redline/shared';
import type { GameSetup, OrderResult } from '../../api.js';
import { hostile, targetClassOf } from '../../encounters/profile.js';
import { applyOrderImpl } from '../../orders/orders.js';
import { atWar, sortedKeys, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { mil, milBal, nextId, type GenSt } from './state.js';
import { OK, fail, generic, posOf, roll, schedule, noteLoc } from './util.js';

/**
 * Généraux. Chaque nation active en reçoit 2 à 4 à la création de la partie (noms fictifs, 1 ou 2
 * traits). `appointGeneral` leur confie un groupe d'unités ; leurs traits s'appliquent par le crochet
 * unitModifier :
 *  - offensive : +bonus dégâts quand l'unité attaque (trajet ou cible) ;
 *  - defender : +bonus protection quand l'unité tient sa position ;
 *  - logistician : +bonus autonomie des aéronefs et portée de ravitaillement, +½ bonus rayon d'action ;
 *  - aviator : +bonus dégâts et +½ bonus autonomie des aéronefs ;
 *  - admiral : +bonus dégâts des navires et portée sonar.
 * Délégation (`delegate`) : l'IA pilote le groupe autour d'une zone (defend / advance / harass) à
 * chaque réflexion (military.generals.thinkMinutes). Tout ordre direct du joueur sur une unité du
 * groupe reprend la main (consigne effacée).
 */

const TRAITS: GeneralTrait[] = ['offensive', 'defender', 'logistician', 'aviator', 'admiral'];
const FIRST = [
  'A.',
  'B.',
  'C.',
  'D.',
  'E.',
  'F.',
  'G.',
  'H.',
  'I.',
  'J.',
  'K.',
  'L.',
  'M.',
  'N.',
  'O.',
  'P.',
  'R.',
  'S.',
  'T.',
  'V.',
];
const LAST = [
  'Valmont',
  'Serrat',
  'Korvin',
  'Almeda',
  'Brandt',
  'Castel',
  'Dorval',
  'Estrin',
  'Falke',
  'Garnier',
  'Halden',
  'Iversen',
  'Jarosz',
  'Kessler',
  'Lemaire',
  'Marek',
  'Novak',
  'Orlov',
  'Petrescu',
  'Quint',
  'Rostam',
  'Sayed',
  'Tamura',
  'Uribe',
  'Varga',
  'Wendt',
  'Yilmaz',
  'Zaric',
  'Moreau',
  'Lindqvist',
  'Okafor',
  'Haddad',
  'Kovac',
  'Farouk',
  'Delacroix',
  'Ivanek',
  'Barros',
  'Nakamura',
  'Sorensen',
  'Adeyemi',
];

/** Création des généraux des nations actives (graine du module : déterministe). */
export function initGenerals(state: EngineState, setup: GameSetup): void {
  const bal = milBal(state).generals;
  const m = mil(state);
  const active = [...new Set(setup.players.map((p) => p.nationId))]
    .filter((n) => state.nations[n])
    .sort();
  for (const n of active) {
    const span = Math.max(0, Math.round(bal.perNationMax - bal.perNationMin));
    const count = Math.round(bal.perNationMin) + Math.floor(roll(state) * (span + 1));
    for (let i = 0; i < count; i++) {
      const id = nextId(state, 'g');
      const name = `Gén. ${FIRST[Math.floor(roll(state) * FIRST.length)]} ${LAST[Math.floor(roll(state) * LAST.length)]}`;
      const t1 = TRAITS[Math.floor(roll(state) * TRAITS.length)]!;
      const traits: GeneralTrait[] = [t1];
      if (roll(state) < 0.4) {
        const t2 = TRAITS[Math.floor(roll(state) * TRAITS.length)]!;
        if (t2 !== t1) traits.push(t2);
      }
      traits.sort();
      m.gens[id] = { id, owner: n, name, traits, units: [], directive: null, area: null, v: 0 };
    }
  }
}

export function orderAppoint(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'appointGeneral' }>,
): OrderResult {
  const m = mil(state);
  const g = m.gens[o.generalId];
  if (!g) return fail('invalid_target', 'Général inconnu.');
  if (g.owner !== n) return fail('not_owner', 'Ce général ne vous appartient pas.');
  const ids = [...new Set(o.unitIds)].sort();
  if (ids.length > milBal(state).generals.maxUnits)
    return fail('capacity', 'Trop d’unités pour un seul général.');
  for (const id of ids) {
    const u = state.units[id];
    if (!u) return fail('unknown_unit', `Unité inconnue : ${id}`);
    if (u.owner !== n) return fail('not_owner', `Cette unité ne vous appartient pas : ${id}`);
    if (u.role) return fail('not_allowed', `Unité indisponible : ${id}`);
  }
  for (const id of g.units) if (m.unitGen[id] === g.id) delete m.unitGen[id];
  for (const id of ids) {
    const prev = m.unitGen[id];
    if (prev && prev !== g.id) {
      const pg = m.gens[prev];
      if (pg) pg.units = pg.units.filter((x) => x !== id);
    }
    m.unitGen[id] = g.id;
  }
  g.units = ids;
  return OK;
}

export function orderDelegate(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'delegate' }>,
): OrderResult {
  const g = mil(state).gens[o.generalId];
  if (!g) return fail('invalid_target', 'Général inconnu.');
  if (g.owner !== n) return fail('not_owner', 'Ce général ne vous appartient pas.');
  g.v++;
  g.directive = o.directive;
  g.area = o.area ? [o.area[0], o.area[1]] : o.directive ? centroid(state, g) : null;
  if (g.directive) schedule(state, state.time, 'gen', { g: g.id, v: g.v });
  return OK;
}

function centroid(state: EngineState, g: GenSt): LngLat | null {
  const pts = g.units
    .map((id) => state.units[id])
    .filter((u): u is Unit => !!u && !u.off)
    .map((u) => posOf(state, u));
  if (pts.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** Ordre émis par l'IA d'un général délégué (ne reprend pas la main). */
let driving = false;

function command(state: EngineState, n: NationId, o: Order): boolean {
  driving = true;
  try {
    return applyOrderImpl(state, n, o).ok;
  } finally {
    driving = false;
  }
}

/** Crochet onOrder (ordre accepté) : un ordre direct sur une unité d'un groupe délégué reprend la main. */
export function releaseOnOrder(state: EngineState, n: NationId, o: Order): void {
  if (driving) return;
  const ids: string[] = [];
  if ('unitIds' in o && Array.isArray(o.unitIds)) ids.push(...(o.unitIds as string[]));
  if ('unitId' in o && typeof o.unitId === 'string') ids.push(o.unitId);
  if (ids.length === 0) return;
  const m = mil(state);
  const touched = new Set<string>();
  for (const id of ids) {
    const gid = m.unitGen[id];
    if (gid && m.gens[gid]?.owner === n && m.gens[gid]!.directive) touched.add(gid);
  }
  for (const gid of [...touched].sort()) {
    const g = m.gens[gid]!;
    g.directive = null;
    g.v++;
    generic(
      state,
      [n],
      'general',
      'Reprise en main',
      `${g.name} rend le commandement direct de son groupe.`,
      'info',
      null,
      noteLoc('generalReleased', { general: g.name }),
    );
  }
}

export function handleGeneral(state: EngineState, d: { g: string; v: number }): void {
  const g = mil(state).gens[d.g];
  if (!g || g.v !== d.v || !g.directive) return;
  g.units = g.units.filter((id) => state.units[id]?.owner === g.owner);
  if (g.units.length > 0 && state.nations[g.owner]?.alive) think(state, g);
  if (g.directive && g.v === d.v) {
    schedule(state, state.time + milBal(state).generals.thinkMinutes * MINUTE, 'gen', {
      g: g.id,
      v: g.v,
    });
  }
}

interface Threat {
  u: Unit;
  pos: LngLat;
}

function threatsNear(state: EngineState, n: NationId, at: LngLat, r: number): Threat[] {
  const known = state.know[n];
  if (!known) return [];
  const out: Threat[] = [];
  for (const id of sortedKeys(known)) {
    const c = known[id]!;
    const o = state.units[id];
    if (!c.seen || !o || o.off || o.role === 'missile' || !atWar(state, n, o.owner)) continue;
    const pos = posOf(state, o);
    if (distanceKm(pos, at) <= r) out.push({ u: o, pos });
  }
  return out;
}

function think(state: EngineState, g: GenSt): void {
  const area = g.area ?? centroid(state, g);
  if (!area) return;
  const R = milBal(state).generals.areaKm;
  const n = g.owner;
  const units = g.units.map((id) => state.units[id]!).filter((u) => !u.off && !u.role);
  const radius = g.directive === 'harass' ? R * 1.5 : R;
  const threats = threatsNear(state, n, area, radius);
  if (g.directive === 'harass')
    threats.sort((a, b) => a.u.hp - b.u.hp || (a.u.id < b.u.id ? -1 : 1));
  else
    threats.sort(
      (a, b) => distanceKm(a.pos, area) - distanceKm(b.pos, area) || (a.u.id < b.u.id ? -1 : 1),
    );
  const busy = new Set<string>();
  const assigned = new Map<string, number>();
  for (const u of units) if (u.target && state.units[u.target]) busy.add(u.id);
  // Engagement des menaces : jusqu'à trois unités par menace.
  for (const th of threats) {
    for (const u of units) {
      if (busy.has(u.id)) continue;
      if ((assigned.get(th.u.id) ?? 0) >= 3) break;
      const s = sysOf(state, u);
      if (s.damage[targetClassOf(state, th.u)] <= 0 || !hostile(state, u, th.u)) continue;
      if (s.movement === 'static' || s.speedKmh <= 0) continue;
      if (command(state, n, { kind: 'attack', unitIds: [u.id], targetId: th.u.id })) {
        busy.add(u.id);
        assigned.set(th.u.id, (assigned.get(th.u.id) ?? 0) + 1);
      }
    }
  }
  if (g.directive === 'advance') {
    // Unités de capture vers la ville ennemie la plus proche de la zone.
    const target = enemyCityNear(state, n, area, R * 2);
    if (target) {
      for (const u of units) {
        if (busy.has(u.id) || u.move) continue;
        const s = sysOf(state, u);
        if (!s.canCapture || s.movement !== 'land') continue;
        if (command(state, n, { kind: 'move', unitIds: [u.id], to: target })) busy.add(u.id);
      }
    }
  }
  // Retour dans la zone des unités libres qui s'en sont éloignées.
  for (const u of units) {
    if (busy.has(u.id) || u.move || u.target) continue;
    const s = sysOf(state, u);
    if (s.movement === 'static' || s.speedKmh <= 0) continue;
    if (distanceKm(posOf(state, u), area) <= R * 0.5) continue;
    if (s.movement === 'air' && mil(state).ms[u.id]?.fa) {
      command(state, n, { kind: 'patrol', unitIds: [u.id], at: area, radiusKm: Math.min(1000, R) });
    } else command(state, n, { kind: 'move', unitIds: [u.id], to: area });
  }
}

function enemyCityNear(state: EngineState, n: NationId, at: LngLat, r: number): LngLat | null {
  const w = wi(state.world);
  let best: LngLat | null = null;
  let bestD = Infinity;
  for (const pid of Object.keys(state.provinces).sort()) {
    const P = state.provinces[pid]!;
    if (P.owner === n || !atWar(state, n, P.owner)) continue;
    const c = w.provById.get(pid)!.cityPoint;
    const d = distanceKm(c, at);
    if (d <= r && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Crochet unitModifier : traits du général qui commande l'unité. */
export function generalModifier(state: EngineState, u: Unit, key: string): number {
  const m = state.mods.mil as
    { unitGen?: Record<string, string>; gens?: Record<string, GenSt> } | undefined;
  const gid = m?.unitGen?.[u.id];
  if (!gid) return 1;
  const g = m!.gens![gid];
  if (!g) return 1;
  const bonus = milBal(state).generals.bonus;
  const sys = sysOf(state, u);
  let f = 1;
  for (const t of g.traits) {
    switch (t) {
      case 'offensive':
        if (key === 'combat.damage' && (u.move || u.target)) f *= 1 + bonus;
        break;
      case 'defender':
        if (key === 'combat.armor' && !u.move) f *= 1 + bonus;
        break;
      case 'logistician':
        if (key === 'air.fuel' || key === 'supply.range') f *= 1 + bonus;
        else if (key === 'air.range') f *= 1 + bonus / 2;
        break;
      case 'aviator':
        if (sys.movement === 'air') {
          if (key === 'combat.damage') f *= 1 + bonus;
          else if (key === 'air.fuel') f *= 1 + bonus / 2;
        }
        break;
      case 'admiral':
        if (sys.movement === 'sea' && (key === 'combat.damage' || key === 'naval.sonar'))
          f *= 1 + bonus;
        break;
    }
  }
  return f;
}

export function generalsFor(state: EngineState, n: NationId): GeneralView[] {
  const m = mil(state);
  return Object.keys(m.gens)
    .sort()
    .map((k) => m.gens[k]!)
    .filter((g) => g.owner === n)
    .map((g) => ({
      id: g.id,
      name: g.name,
      traits: [...g.traits],
      unitIds: g.units.filter((id) => !!state.units[id]),
      directive: g.directive,
      area: g.area,
    }));
}

/** Une unité disparue quitte son général. */
export function dropFromGeneral(state: EngineState, uid: string): void {
  const m = mil(state);
  const gid = m.unitGen[uid];
  if (!gid) return;
  delete m.unitGen[uid];
  const g = m.gens[gid];
  if (g) g.units = g.units.filter((x) => x !== uid);
}
