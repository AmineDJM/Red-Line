import {
  RESOURCES,
  StacksBalanceSchema,
  stackClassOf,
  TARGET_CLASSES,
  type DamageTable,
  type Resource,
  type StacksBalance,
  type SystemId,
  type WeaponSystem,
} from '@redline/shared';
import type { World } from '../api.js';
import type { EngineState, StackPart, Unit } from './types.js';

/**
 * Piles mixtes : une unité peut réunir plusieurs matériels du même domaine (`Unit.mix`).
 *
 * Modèle (équivalent à la somme des éléments) :
 *  - chaque élément `{ sys, c, m }` : `c` éléments vivants, `m` part des PV maximaux ; la santé de la
 *    pile (hp / maxHp) s'applique uniformément à chaque élément, donc les dégâts reçus sont répartis au
 *    prorata des points de vie et chaque matériel perd ses éléments à mesure (jamais remontés par les
 *    soins, comme une pile simple) ;
 *  - les dégâts infligés sont la somme des dégâts de chaque matériel à portée, contre chaque matériel de
 *    la cible (combat/combat.ts, voir `mixedBaseDamage`) ;
 *  - `sysOf` rend une fiche synthétique : moyennes par élément vivant pour les grandeurs additives
 *    (dégâts, entretien, coût : moyenne × effectif = somme), meilleur capteur, furtivité et vitesse du
 *    plus exposé / du plus lent, rayon d'action et autonomie les plus courts, blindage moyen pondéré
 *    par les PV, portée d'arme de la plus courte à la plus longue.
 * La fiche synthétique ne dépend que du catalogue et de `mix` (sérialisé) : déterministe.
 */

const balCache = new WeakMap<World, StacksBalance>();

/** Réglages des piles (data/balance `stacks`, défauts du schéma). */
export function stackBal(world: World): StacksBalance {
  let b = balCache.get(world);
  if (!b) {
    b = StacksBalanceSchema.parse(world.balance.stacks ?? {});
    balCache.set(world, b);
  }
  return b;
}

const classCache = new WeakMap<World, Map<SystemId, string | null>>();

/** Classe de fusion d'un matériel (règle commune : `stackClassOf` de @redline/shared), en cache. */
export function mixClassOf(world: World, sys: WeaponSystem): string | null {
  let m = classCache.get(world);
  if (!m) classCache.set(world, (m = new Map()));
  let cls = m.get(sys.id);
  if (cls === undefined) {
    cls = stackClassOf(sys, stackBal(world).classes);
    m.set(sys.id, cls);
  }
  return cls;
}

/** Élément d'une pile, fiche résolue. */
export interface Part {
  sys: WeaponSystem;
  c: number;
  m: number;
}

function cat(state: EngineState, id: SystemId): WeaponSystem {
  const s = state.world.catalog.get(id);
  if (!s) throw new Error(`système inconnu : ${id}`);
  return s;
}

/** Éléments d'une unité (une pile simple donne un seul élément). */
export function partsOf(state: EngineState, u: Unit): Part[] {
  if (!u.mix) return [{ sys: cat(state, u.sys), c: u.count, m: u.maxHp }];
  return u.mix.map((p) => ({ sys: cat(state, p.sys), c: p.c, m: p.m }));
}

/** Composition brute d'une unité ({ sys, c, m } par matériel, triée). */
export function rawParts(u: Unit): StackPart[] {
  return u.mix ? u.mix.map((p) => ({ ...p })) : [{ sys: u.sys, c: u.count, m: u.maxHp }];
}

/** Matériel principal : plus grande part des PV maximaux, puis identifiant. */
function leadOf(parts: StackPart[]): SystemId {
  let best = parts[0]!;
  for (const p of parts) if (p.m > best.m) best = p;
  return best.sys;
}

/**
 * Pose la composition d'une unité (éléments vides retirés, doublons fusionnés, tri), et ses
 * invariants (`count`, `maxHp`, `sys`). Un seul matériel : l'unité redevient une pile simple. Ne touche
 * pas aux PV (`hp`) : à l'appelant de les fixer.
 */
export function setParts(u: Unit, parts: StackPart[]): void {
  const by = new Map<SystemId, StackPart>();
  for (const p of parts) {
    if (!(p.c > 0)) continue;
    const q = by.get(p.sys);
    if (q) {
      q.c += p.c;
      q.m += p.m;
    } else by.set(p.sys, { sys: p.sys, c: p.c, m: p.m });
  }
  const list = [...by.values()].sort((a, b) => (a.sys < b.sys ? -1 : a.sys > b.sys ? 1 : 0));
  if (list.length === 0) throw new Error(`pile vide : ${u.id}`);
  if (list.length === 1) {
    const p = list[0]!;
    delete u.mix;
    u.sys = p.sys;
    u.count = p.c;
    u.maxHp = p.m;
    return;
  }
  u.mix = list;
  u.sys = leadOf(list);
  let c = 0;
  let m = 0;
  for (const p of list) {
    c += p.c;
    m += p.m;
  }
  u.count = c;
  u.maxHp = m;
}

/** Éléments vivants de chaque matériel si la pile tombait à `hp` points de vie (jamais en hausse). */
export function aliveAt(state: EngineState, u: Unit, hp: number): number[] {
  const mix = u.mix!;
  if (hp <= 1e-6) return mix.map(() => 0);
  const r = u.maxHp > 0 ? hp / u.maxHp : 0;
  return mix.map((p) =>
    Math.min(p.c, Math.max(1, Math.ceil((r * p.m) / cat(state, p.sys).hp - 1e-9))),
  );
}

/** Effectif total d'une pile mixte à `hp` points de vie. */
export function mixedCountAt(state: EngineState, u: Unit, hp: number): number {
  let n = 0;
  for (const c of aliveAt(state, u, hp)) n += c;
  return n;
}

/** Après des dégâts : effectif de chaque matériel d'une pile mixte (et `count`) remis à jour. */
export function syncStackCount(state: EngineState, u: Unit): void {
  const mix = u.mix;
  if (!mix) return;
  const alive = aliveAt(state, u, u.hp);
  let changed = false;
  for (let i = 0; i < mix.length; i++) if (alive[i] !== mix[i]!.c) changed = true;
  if (!changed) return;
  u.mix = mix.map((p, i) => ({ sys: p.sys, c: alive[i]!, m: p.m }));
  u.count = Math.max(
    1,
    alive.reduce((a, b) => a + b, 0),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Fiche synthétique                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const synth = new WeakMap<Unit, { mix: StackPart[]; lead: SystemId; sys: WeaponSystem }>();

/** Fiche synthétique d'une pile mixte (mise en cache tant que sa composition ne change pas). */
export function stackSystem(state: EngineState, u: Unit): WeaponSystem {
  const mix = u.mix!;
  const hit = synth.get(u);
  if (hit && hit.mix === mix && hit.lead === u.sys) return hit.sys;
  const sys = composeSystem(
    cat(state, u.sys),
    mix.map((p) => ({ sys: cat(state, p.sys), c: p.c, m: p.m })),
  );
  synth.set(u, { mix, lead: u.sys, sys });
  return sys;
}

/** Fiche équivalente à un ensemble d'éléments (voir l'en-tête). Exportée pour l'IA et les tests. */
export function composeSystem(lead: WeaponSystem, parts: Part[]): WeaponSystem {
  let C = 0;
  let M = 0;
  for (const p of parts) {
    C += p.c;
    M += p.m;
  }
  const c = Math.max(1, C);
  const mw = M > 0 ? M : 1;
  const damage = {} as DamageTable;
  for (const k of TARGET_CLASSES) damage[k] = 0;
  let money = 0;
  let build = 0;
  let upkeep = 0;
  let price = 0;
  let priced = true;
  let hp = 0;
  let armor = 0;
  let jamRes = 0;
  let slots = 0;
  let transport = 0;
  let speed = Infinity;
  let stealth = Infinity;
  let detect = 0;
  let jamming = 0;
  let wMin = Infinity;
  let wMax = 0;
  let radius = Infinity;
  let fuel = Infinity;
  let allAir = true;
  let refuel = true;
  let carrier = true;
  let capture = false;
  let sensor: WeaponSystem['sensor'];
  let stealthDetect = 0;
  const resources: Partial<Record<Resource, number>> = {};
  const roles = new Set<string>();
  for (const p of parts) {
    const s = p.sys;
    for (const k of TARGET_CLASSES) damage[k] += p.c * s.damage[k];
    money += p.c * s.cost.money;
    for (const r of RESOURCES) {
      const v = s.cost.resources[r];
      if (v !== undefined) resources[r] = (resources[r] ?? 0) + p.c * v;
    }
    build += p.c * s.buildTimeH;
    upkeep += p.c * s.upkeepPerDay;
    if (s.unitPriceUsd === undefined) priced = false;
    else price += p.c * s.unitPriceUsd;
    hp += p.c * s.hp;
    armor += p.m * s.armor;
    jamRes += p.m * s.ew.jamResistance;
    slots += p.c * s.payload.slots;
    transport += p.c * (s.payload.transport ?? 0);
    speed = Math.min(speed, s.speedKmh);
    stealth = Math.min(stealth, s.stealth);
    detect = Math.max(detect, s.detectionRangeKm);
    jamming = Math.max(jamming, s.ew.jamming);
    if (s.weaponRangeKm.max > 0) {
      wMin = Math.min(wMin, s.weaponRangeKm.min);
      wMax = Math.max(wMax, s.weaponRangeKm.max);
    }
    if (s.operationalRadiusKm !== null) radius = Math.min(radius, s.operationalRadiusKm);
    if (s.air) {
      fuel = Math.min(fuel, s.air.fuelH);
      refuel &&= s.air.refuelable;
      carrier &&= s.air.carrierCapable;
    } else allAir = false;
    capture ||= s.canCapture;
    if (s.sensor) {
      stealthDetect = Math.max(stealthDetect, s.sensor.stealthDetect);
      if (!sensor || s.sensor.rangeKm > sensor.rangeKm) sensor = s.sensor;
    }
    for (const r of s.roles) roles.add(r);
  }
  for (const k of TARGET_CLASSES) damage[k] /= c;
  for (const r of RESOURCES) if (resources[r] !== undefined) resources[r] = resources[r]! / c;
  return {
    ...lead,
    roles: [...roles].sort(),
    canCapture: capture,
    cost: { money: money / c, resources },
    buildTimeH: build / c,
    upkeepPerDay: upkeep / c,
    unitPriceUsd: priced ? price / c : undefined,
    speedKmh: speed,
    operationalRadiusKm: Number.isFinite(radius) ? radius : null,
    weaponRangeKm: wMax > 0 ? { min: wMin, max: wMax } : { min: 0, max: 0 },
    damage,
    hp: hp / c,
    armor: armor / mw,
    stealth,
    detectionRangeKm: detect,
    ew: { jamming, jamResistance: jamRes / mw },
    payload: { slots: slots / c, transport: transport / c },
    sensor: sensor ? { ...sensor, stealthDetect } : undefined,
    air: allAir ? { fuelH: fuel, refuelable: refuel, carrierCapable: carrier } : undefined,
  };
}

/** Portée à laquelle tous les matériels armés d'une pile mixte peuvent tirer (km). */
export function fullRangeKm(state: EngineState, u: Unit): number {
  let r = Infinity;
  for (const p of partsOf(state, u)) {
    const w = p.sys.weaponRangeKm.max;
    if (w > 0 && p.c > 0) r = Math.min(r, w);
  }
  return Number.isFinite(r) ? r : 0;
}
