import {
  destination,
  type LngLat,
  type NationId,
  type ProvinceId,
  type WeaponSystem,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { mixClassOf, stackBal } from '../../state/stack.js';
import { spawnStack } from '../../state/units.js';
import { roadSpawn, wi } from '../../state/world.js';
import { cfg } from './config.js';
import { eco, orbatOf } from './state.js';

type Group = 'air' | 'sea' | 'land' | 'ad' | 'missile' | 'space';

const AIR_CATEGORIES = new Set(['fighter', 'bomber', 'air_support', 'helicopter', 'drone']);

function groupOf(sys: WeaponSystem): Group {
  if (sys.movement === 'sea' || sys.category === 'surface_ship' || sys.category === 'submarine')
    return 'sea';
  if (sys.category === 'space') return 'space';
  if (AIR_CATEGORIES.has(sys.category) || sys.movement === 'air') return 'air';
  if (sys.category === 'air_defense' || sys.category === 'radar') return 'ad';
  if (sys.category === 'strike_missile' || sys.category === 'nuclear') return 'missile';
  return 'land';
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Taille de pile d'une catégorie, agrandie si le monde dépasserait la cible de piles. */
function stackSize(state: EngineState, sys: WeaponSystem): number {
  const base = cfg(state.world).startingForces.stackMax[sys.category] ?? 24;
  return Math.max(1, Math.round(base * eco(state).stackScale));
}

/**
 * Facteur d'agrandissement des piles pour rester sous `maxStacksWorld` piles au départ (toutes les
 * nations de la partie dotées d'un ORBAT). Calculé une fois à la création de la partie.
 */
export function worldStackScale(state: EngineState): number {
  const c = cfg(state.world).startingForces;
  const entries: [number, number][] = [];
  for (const n of state.nationIds) {
    const o = orbatOf(state, n);
    if (!o) continue;
    for (const it of o.inventory) {
      const sys = state.world.catalog.get(it.systemId);
      if (!sys || it.count <= 0) continue;
      entries.push([it.count, c.stackMax[sys.category] ?? 24]);
    }
  }
  const totalAt = (k: number) =>
    entries.reduce(
      (a, [count, base]) => a + Math.ceil(count / Math.max(1, Math.round(base * k))),
      0,
    );
  let scale = 1;
  for (let i = 0; i < 30; i++) {
    const total = totalAt(scale);
    // Au mieux une pile par système : inutile d'agrandir au-delà.
    if (total <= c.maxStacksWorld || total <= entries.length * 1.05) break;
    scale *= Math.max(1.05, total / c.maxStacksWorld);
  }
  return scale;
}

type Spec = { g: Group; parts: { sys: string; count: number }[] };

/**
 * Regroupement de départ (data/balance `stacks.start.groups`) : les systèmes mélangeables d'un groupe
 * (ex. infanterie, VCI et chars) forment ceil(modules / maxModules) piles mixtes, un module étant une
 * pile d'origine (`startingForces.stackMax`). Chaque pile reçoit une part de chaque matériel (restes
 * répartis en tourniquet). Renvoie les piles et les entrées absorbées.
 */
function startGroups(
  state: EngineState,
  entries: [string, number][],
  piles: number[],
): { stacks: Spec[]; taken: Set<number> } {
  const sb = stackBal(state.world);
  const stacks: Spec[] = [];
  const taken = new Set<number>();
  if (!sb.start.enabled) return { stacks, taken };
  for (const grp of sb.start.groups) {
    const idx: number[] = [];
    entries.forEach(([id], i) => {
      if (taken.has(i)) return;
      const sys = state.world.catalog.get(id)!;
      if (grp.categories.includes(sys.category) && mixClassOf(state.world, sys)) idx.push(i);
    });
    if (idx.length === 0) continue;
    let modules = 0;
    for (const i of idx) modules += piles[i]!;
    const B = Math.max(1, Math.ceil(modules / grp.maxModules));
    const parts: Spec['parts'][] = Array.from({ length: B }, () => []);
    let off = 0;
    for (const i of idx) {
      taken.add(i);
      const [id, count] = entries[i]!;
      const base = Math.floor(count / B);
      const rem = count % B;
      for (let j = 0; j < B; j++) {
        const size = base + ((j - off + B) % B < rem ? 1 : 0);
        if (size > 0) parts[j]!.push({ sys: id, count: size });
      }
      off = (off + rem) % B;
    }
    const g = groupOf(state.world.catalog.get(entries[idx[0]!]![0])!);
    for (const p of parts) if (p.length > 0) stacks.push({ g, parts: p });
  }
  return { stacks, taken };
}

/**
 * Forces de départ réelles : l'inventaire de l'ORBAT est regroupé en piles (taille maximale par
 * catégorie, `startingForces.stackMax`), réparties par tourniquet sur les sites adaptés :
 *  - aéronefs : provinces avec base aérienne (sinon la capitale) ;
 *  - navires et sous-marins : en mer devant les ports (point de mise à l'eau) ;
 *  - forces terrestres : capitale, frontières menacées (voisin au plus gros budget de défense),
 *    bases militaires, grandes villes ;
 *  - défense aérienne et radars : capitale, grandes villes (revenu), bases aériennes et militaires ;
 *  - missiles et nucléaire : lanceurs sur les bases militaires (sinon la capitale) ;
 *  - satellites : à la capitale (le module militaire gère l'orbite).
 * Les groupes de départ (`stacks.start.groups`) réunissent leurs systèmes en piles mixtes (brigades
 * interarmes, escadres), posées en premier : la capitale reçoit la première brigade.
 * Les tailles de pile sont agrandies uniformément si le monde dépasse `maxStacksWorld` piles, puis
 * pour la nation si elle dépasse `maxStacksPerNation`.
 * `count` de chaque pile = nombre réel d'éléments ; la somme est exactement l'inventaire.
 * Les systèmes absents du catalogue sont ignorés (voir world.loadWarnings).
 */
export function placeOrbatForces(state: EngineState, n: NationId): boolean {
  if (!eco(state).live) return false;
  const o = orbatOf(state, n);
  if (!o) return false;
  const w = wi(state.world);
  const owned = (w.provsByNation.get(n) ?? []).filter((p) => state.provinces[p]);
  if (owned.length === 0) return true;
  const def = (p: ProvinceId) => w.provById.get(p)!;
  const has = (p: ProvinceId, b: string) => def(p).buildings.includes(b as never);
  const capId = w.nationById.get(n)?.capitalProvinceId;
  const capital: ProvinceId = capId && owned.includes(capId) ? capId : owned[0]!;
  const uniq = (xs: ProvinceId[]) => [...new Set(xs)];

  const air = owned.filter((p) => has(p, 'air_base'));
  const coastal = owned.filter((p) => !!w.seaSpawn.get(p));
  const ports = coastal.filter((p) => has(p, 'port') || has(p, 'naval_base'));
  const bases = owned.filter((p) => has(p, 'military_base'));
  // Frontières menacées : chaque voisin étranger, du plus gros budget de défense publié (ORBAT) au
  // plus petit, reçoit tour à tour une de ses provinces frontalières (toutes les frontières sont
  // couvertes avant qu'une même frontière reçoive une seconde pile).
  const budget = (o: NationId): number => orbatOf(state, o)?.defenseBudgetUsd ?? 0;
  const facing = new Map<NationId, ProvinceId[]>();
  for (const p of owned) {
    let top: NationId | null = null;
    for (const q of def(p).neighbors) {
      const o = state.provinces[q]?.owner;
      if (!o || o === n) continue;
      if (top === null || budget(o) > budget(top) || (budget(o) === budget(top) && o < top))
        top = o;
    }
    if (top !== null) facing.set(top, [...(facing.get(top) ?? []), p]);
  }
  const rivals = [...facing.keys()].sort((a, b) => budget(b) - budget(a) || cmp(a, b));
  const border: ProvinceId[] = [];
  for (let k = 0; ; k++) {
    let any = false;
    for (const r of rivals) {
      const list = facing.get(r)!;
      if (k < list.length) {
        border.push(list[k]!);
        any = true;
      }
    }
    if (!any) break;
  }
  const bigCities = [...owned]
    .sort((a, b) => def(b).income.money - def(a).income.money || cmp(a, b))
    .slice(0, 6);
  const sites: Record<Group, ProvinceId[]> = {
    air: air.length > 0 ? air : [capital],
    sea: ports.length > 0 ? ports : coastal,
    land: uniq([capital, ...border, ...bases, ...bigCities]),
    ad: uniq([capital, ...bigCities, ...air, ...bases]),
    missile: bases.length > 0 ? bases : [capital],
    space: [capital],
  };

  // Inventaire fusionné par système, trié.
  const counts = new Map<string, number>();
  for (const it of o.inventory) {
    const sys = state.world.catalog.get(it.systemId);
    if (!sys || it.count <= 0) continue;
    counts.set(it.systemId, (counts.get(it.systemId) ?? 0) + it.count);
  }
  const entries = [...counts.entries()].sort((a, b) => cmp(a[0], b[0]));
  const c = cfg(state.world).startingForces;
  const stackOf = (sys: WeaponSystem) => stackSize(state, sys);
  let scale = 1;
  let piles: number[] = [];
  for (let iter = 0; iter < 32; iter++) {
    piles = entries.map(([id, count]) =>
      Math.ceil(count / (stackOf(state.world.catalog.get(id)!) * scale)),
    );
    const total = piles.reduce((a, b) => a + b, 0);
    if (total <= c.maxStacksPerNation || total <= entries.length) break;
    scale = Math.max(scale + 1, Math.ceil((scale * total) / c.maxStacksPerNation));
  }

  // Piles à poser, dans l'ordre : piles mixtes des groupes de départ (brigades, escadres…), puis
  // piles d'un seul système.
  const grouped = startGroups(state, entries, piles);
  const specs = [...grouped.stacks];
  entries.forEach(([id, count], i) => {
    if (grouped.taken.has(i)) return;
    const g = groupOf(state.world.catalog.get(id)!);
    const k = piles[i]!;
    const base = Math.floor(count / k);
    const rem = count % k;
    for (let j = 0; j < k; j++) {
      const size = base + (j < rem ? 1 : 0);
      if (size > 0) specs.push({ g, parts: [{ sys: id, count: size }] });
    }
  });

  const turn: Record<Group, number> = { air: 0, sea: 0, land: 0, ad: 0, missile: 0, space: 0 };
  const perSite = new Map<ProvinceId, number>();
  const gc = state.world.balance.combat.groundContactKm;
  for (const { g, parts } of specs) {
    const list = sites[g];
    if (list.length === 0) continue; // navires d'une nation enclavée : ignorés
    const site = list[turn[g]++ % list.length]!;
    let pos: LngLat;
    if (g === 'sea') pos = w.seaSpawn.get(site)!;
    else {
      const city = def(site).cityPoint;
      const m = perSite.get(site) ?? 0;
      perSite.set(site, m + 1);
      pos = city;
      if (m > 0) {
        const cand = destination(city, (m * 137.508) % 360, gc * 0.3 * (1 + (m % 5) / 5));
        if (w.nav.cellProv.get(w.nav.cellAt(cand)) === site) pos = roadSpawn(w, cand, gc, site);
      }
    }
    spawnStack(state, n, parts, pos);
  }
  return true;
}
