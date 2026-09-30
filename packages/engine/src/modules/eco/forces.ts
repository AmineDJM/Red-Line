import {
  destination,
  type LngLat,
  type NationId,
  type ProvinceId,
  type WeaponSystem,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { spawnUnit } from '../../state/units.js';
import { wi } from '../../state/world.js';
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

/**
 * Forces de départ réelles : l'inventaire de l'ORBAT est regroupé en piles (taille maximale par
 * catégorie, `startingForces.stackMax`), réparties par tourniquet sur les sites adaptés :
 *  - aéronefs : provinces avec base aérienne (sinon la capitale) ;
 *  - navires et sous-marins : en mer devant les ports (point de mise à l'eau) ;
 *  - forces terrestres : capitale, bases militaires, provinces frontalières ;
 *  - défense aérienne et radars : capitale, grandes villes (revenu), bases aériennes et militaires ;
 *  - missiles et nucléaire : lanceurs sur les bases militaires (sinon la capitale) ;
 *  - satellites : à la capitale (le module militaire gère l'orbite).
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
  const border = owned.filter((p) =>
    def(p).neighbors.some((q) => state.provinces[q] && state.provinces[q]!.owner !== n),
  );
  const bigCities = [...owned]
    .sort((a, b) => def(b).income.money - def(a).income.money || cmp(a, b))
    .slice(0, 6);
  const sites: Record<Group, ProvinceId[]> = {
    air: air.length > 0 ? air : [capital],
    sea: ports.length > 0 ? ports : coastal,
    land: uniq([capital, ...bases, ...border]),
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

  const turn: Record<Group, number> = { air: 0, sea: 0, land: 0, ad: 0, missile: 0, space: 0 };
  const perSite = new Map<ProvinceId, number>();
  const gc = state.world.balance.combat.groundContactKm;
  entries.forEach(([id, count], i) => {
    const sys = state.world.catalog.get(id)!;
    const g = groupOf(sys);
    const list = sites[g];
    if (list.length === 0) return; // navires d'une nation enclavée : ignorés
    const k = piles[i]!;
    const base = Math.floor(count / k);
    const rem = count % k;
    for (let j = 0; j < k; j++) {
      const size = base + (j < rem ? 1 : 0);
      if (size <= 0) continue;
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
          if (w.nav.cellProv.get(w.nav.cellAt(cand)) === site) pos = cand;
        }
      }
      spawnUnit(state, n, id, pos, size);
    }
  });
  return true;
}
