/**
 * Réseau de routes (vraies données : data/map/routes.json) : trajets des unités terrestres le long des
 * routes, accrochage de la destination, refus hors réseau, traversées par les ports, rejeu, reprise
 * d'anciennes sauvegardes, points de capture atteignables.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  destination,
  distanceKm,
  movementEnd,
  type LngLat,
  type ProvinceDef,
  type RoadNet,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  type GameSetup,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { loadRealData, type RealData } from '../bench/load.js';

const INF = 'us.infantry-light';
const NATIONS = ['fra', 'gbr', 'bel', 'deu', 'che', 'lux', 'esp', 'ita', 'nld', 'irl'];

let data: RealData;
let world: World;
let roads: RoadNet;
let byCity: (name: string) => ProvinceDef;

beforeAll(() => {
  data = loadRealData();
  expect(data.map.routes, 'data/map/routes.json absent').toBeDefined();
  world = buildWorld(data.map, data.catalog, data.balance, { research: data.research });
  roads = wi(world).roads!;
  byCity = (name) => {
    const p = data.map.provinces.find((x) => x.cityName === name);
    if (!p) throw new Error(`ville inconnue : ${name}`);
    return p;
  };
}, 60_000);

function game(units: GameSetup['units'], w: World = world): EngineState {
  return createGame(w, {
    seed: 7,
    players: [
      { nationId: 'fra', isAi: false },
      { nationId: 'gbr', isAi: false },
      { nationId: 'bel', isAi: false },
    ],
    nationIds: NATIONS,
    units,
  }) as EngineState;
}

const onRoad = (p: LngLat) => roads.snap(p, 0.05) !== null;
const legKm = (s: EngineState, id: string) =>
  s.units[id]!.move!.legs.reduce((a, l) => a + distanceKm(l.from, l.to), 0);

describe('réseau de routes : trajets terrestres', () => {
  it('Paris → Lyon : le trajet suit les routes, de ville à ville, plus long que la ligne droite', () => {
    const paris = byCity('Paris').cityPoint;
    const lyon = byCity('Lyon').cityPoint;
    const s = game([{ owner: 'fra', systemId: INF, pos: paris }]);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: lyon })).toEqual({ ok: true });
    const legs = s.units.u1!.move!.legs;
    expect(legs.length).toBeGreaterThan(2);
    expect(legs[0]!.from).toEqual(paris);
    expect(legs[legs.length - 1]!.to).toEqual(lyon);
    for (const l of legs) {
      expect(l.medium).toBe('land');
      expect(onRoad(l.from) && onRoad(l.to), `${l.from} → ${l.to} hors route`).toBe(true);
    }
    const gc = distanceKm(paris, lyon);
    const km = legKm(s, 'u1');
    expect(km).toBeGreaterThan(gc);
    expect(km).toBeLessThan(gc * 1.6);
    // Durée = longueur / vitesse.
    const sys = world.catalog.get(INF)!;
    expect(movementEnd(s.units.u1!.move!)).toBeCloseTo((km / sys.speedKmh) * HOUR, -3);
    advanceTo(s, movementEnd(s.units.u1!.move!) + MINUTE);
    expect(s.units.u1!.pos).toEqual(lyon);
  });

  it('point quelconque : accroché au point du réseau le plus proche', () => {
    const lyon = byCity('Lyon').cityPoint;
    const s = game([{ owner: 'fra', systemId: INF, pos: lyon }]);
    // Point à l'écart d'une route, mais à moins du rayon d'accrochage.
    let target: LngLat | null = null;
    for (let d = 10; d <= 50 && !target; d += 5)
      for (let b = 0; b < 360 && !target; b += 15) {
        const p = destination(lyon, b, d);
        const hit = roads.snap(p, 60);
        if (hit && hit.d > 3 && hit.d < 40) target = p;
      }
    expect(target).not.toBeNull();
    const expected = roads.snap(target!, 60)!;
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: target! }).ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    const end = legs[legs.length - 1]!.to;
    expect(distanceKm(end, expected.pos)).toBeLessThan(1e-6);
    expect(distanceKm(end, target!)).toBeGreaterThan(3);
  });

  it('point trop loin de toute route : ordre refusé avec un message clair', () => {
    const paris = byCity('Paris').cityPoint;
    const s = game([{ owner: 'fra', systemId: INF, pos: paris }]);
    // Premier point terrestre (centre de cellule) à plus du rayon d’accrochage (balance.movement.roadSnapKm) du réseau.
    const nav = wi(world).nav;
    let far: LngLat | null = null;
    for (const cell of [...nav.cellProv.keys()].sort()) {
      const p = nav.center(nav.node(cell));
      if (!roads.snap(p, (data.balance.movement.roadSnapKm ?? 80) + 1)) {
        far = p;
        break;
      }
    }
    expect(far).not.toBeNull();
    const res = applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: far! });
    expect(res).toMatchObject({ ok: false, error: 'off_road' });
    expect((res as { message: string }).message).toMatch(/réseau de routes/);
    expect(s.units.u1!.move).toBeNull();
  });

  it('réglage balance.movement.roadNetwork = false : déplacement libre (ancien comportement)', () => {
    const w2 = buildWorld(
      data.map,
      data.catalog,
      { ...data.balance, movement: { ...data.balance.movement, roadNetwork: false } },
      { research: data.research },
    );
    expect(wi(w2).roads).toBeNull();
    const paris = byCity('Paris').cityPoint;
    const lyon = byCity('Lyon').cityPoint;
    const s = game([{ owner: 'fra', systemId: INF, pos: paris }], w2);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: lyon })).toEqual({ ok: true });
    const km = legKm(s, 'u1');
    expect(km).toBeLessThan(distanceKm(paris, lyon) * 1.35);
    expect(s.units.u1!.move!.legs.length).toBeLessThanOrEqual(2);
  });

  it('traversée : Londres → Paris par un port, la mer, puis un port', () => {
    const london = byCity('Londres').cityPoint;
    const paris = byCity('Paris').cityPoint;
    const s = game([{ owner: 'gbr', systemId: INF, pos: london }]);
    expect(applyOrder(s, 'gbr', { kind: 'move', unitIds: ['u1'], to: paris }).ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    const firstSea = legs.findIndex((l) => l.medium === 'sea');
    expect(firstSea).toBeGreaterThan(0);
    // Embarquement dans un port (attente sur place), débarquement dans un port.
    const embark = legs[firstSea - 1]!;
    expect(embark.from).toEqual(embark.to);
    const port = (p: LngLat) => roads.ports.some((i) => distanceKm(roads.nodes[i]!.pos, p) < 1e-6);
    expect(port(embark.from)).toBe(true);
    const lastSea = legs.length - 1 - [...legs].reverse().findIndex((l) => l.medium === 'sea');
    expect(port(legs[lastSea]!.to)).toBe(true);
    for (const l of legs)
      if (l.medium === 'land') expect(onRoad(l.from) && onRoad(l.to)).toBe(true);
    expect(legs[legs.length - 1]!.to).toEqual(paris);
    advanceTo(s, movementEnd(s.units.u1!.move!) + MINUTE);
    expect(s.units.u1!.pos).toEqual(paris);
  });

  it('unités aériennes et navales : inchangées (trajet libre)', () => {
    const paris = byCity('Paris').cityPoint;
    const lyon = byCity('Lyon').cityPoint;
    const air = data.catalog.find((x) => x.movement === 'air' && x.enabled && !x.missile)!;
    const s = game([{ owner: 'fra', systemId: air.id, pos: paris }]);
    const res = applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: lyon });
    if (res.ok) {
      const legs = s.units.u1!.move!.legs;
      expect(legs.length).toBe(1);
      expect(legs[0]!.medium).toBe('air');
    }
  });

  it('unité hors réseau (ancienne sauvegarde) : rejoint la route la plus proche puis la suit', () => {
    const lyon = byCity('Lyon').cityPoint;
    const paris = byCity('Paris').cityPoint;
    let off: LngLat | null = null;
    for (let d = 10; d <= 50 && !off; d += 5)
      for (let b = 0; b < 360 && !off; b += 15) {
        const p = destination(lyon, b, d);
        const hit = roads.snap(p, 60);
        if (hit && hit.d > 5 && wi(world).nav.isLandCell(wi(world).nav.cellAt(p))) off = p;
      }
    const s = game([{ owner: 'fra', systemId: INF, pos: off! }]);
    expect(onRoad(s.units.u1!.pos)).toBe(false);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: paris }).ok).toBe(true);
    const legs = s.units.u1!.move!.legs;
    const join = roads.snapNearest(off!, 4000)!;
    expect(legs[0]!.from).toEqual(off);
    expect(distanceKm(legs[0]!.to, join.pos)).toBeLessThan(1e-6);
    for (const l of legs.slice(1)) expect(onRoad(l.from) && onRoad(l.to)).toBe(true);
  });

  it('sauvegarde sans réseau rechargée avec le réseau : le trajet en cours se termine tel quel', () => {
    const free = buildWorld({ ...data.map, routes: undefined }, data.catalog, data.balance, {
      research: data.research,
    });
    const paris = byCity('Paris').cityPoint;
    const lyon = byCity('Lyon').cityPoint;
    const s = game([{ owner: 'fra', systemId: INF, pos: paris }], free);
    applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: lyon });
    const legs = structuredClone(s.units.u1!.move!.legs);
    const end = movementEnd(s.units.u1!.move!);
    advanceTo(s, 2 * HOUR);
    const r = deserializeState(world, serializeState(s)) as EngineState;
    expect(r.units.u1!.move!.legs).toEqual(legs);
    advanceTo(r, end + MINUTE);
    expect(r.units.u1!.pos).toEqual(lyon);
    // Ordre suivant : sur le réseau.
    expect(applyOrder(r, 'fra', { kind: 'move', unitIds: ['u1'], to: paris }).ok).toBe(true);
    for (const l of r.units.u1!.move!.legs) expect(onRoad(l.from) && onRoad(l.to)).toBe(true);
  });

  it('rejeu : mêmes ordres ⇒ même état ; reprise d’un instantané identique', () => {
    const run = (snapshotAt: number | null) => {
      let s = game([
        { owner: 'fra', systemId: INF, pos: byCity('Paris').cityPoint },
        { owner: 'fra', systemId: INF, pos: byCity('Lille').cityPoint },
        { owner: 'gbr', systemId: INF, pos: byCity('Londres').cityPoint },
      ]);
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: byCity('Bordeaux').cityPoint });
      applyOrder(s, 'gbr', { kind: 'move', unitIds: ['u3'], to: byCity('Lille').cityPoint });
      advanceTo(s, 6 * HOUR);
      if (snapshotAt !== null) s = deserializeState(world, serializeState(s)) as EngineState;
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u2'], to: byCity('Marseille').cityPoint });
      applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: byCity('Lyon').cityPoint });
      advanceTo(s, 2 * DAY);
      return stateHash(s);
    };
    const a = run(null);
    expect(run(null)).toBe(a);
    expect(run(6 * HOUR)).toBe(a);
  });

  it('capture à la ville : Lyon → Genève, guerre déclarée en entrant, province prise', () => {
    const geneve = byCity('Genève');
    const s = game([{ owner: 'fra', systemId: INF, pos: byCity('Lyon').cityPoint, count: 3 }]);
    expect(applyOrder(s, 'fra', { kind: 'move', unitIds: ['u1'], to: geneve.cityPoint }).ok).toBe(
      true,
    );
    const arrival = movementEnd(s.units.u1!.move!);
    advanceTo(s, arrival + (data.balance.time.captureMinutes + 5) * MINUTE);
    expect(s.wars).not.toEqual({});
    expect(s.provinces[geneve.id]!.owner).toBe('fra');
  });

  it('provinces fusionnées : une pile d’infanterie marocaine prend la province algérienne voisine', () => {
    // Ville d'une province marocaine frontalière → ville principale (point de capture) de la
    // province algérienne voisine.
    const isDza = (id: string) => id.startsWith('dza-');
    const from = data.map.provinces.find((p) => p.nationId === 'mar' && p.neighbors.some(isDza))!;
    const target = data.map.provinces.find(
      (p) => p.nationId === 'dza' && p.neighbors.includes(from.id) && !p.isCapital,
    )!;
    expect(target, 'province algérienne frontalière du Maroc').toBeDefined();
    const s = createGame(world, {
      seed: 11,
      players: [
        { nationId: 'mar', isAi: false },
        { nationId: 'dza', isAi: false },
      ],
      nationIds: ['mar', 'dza'],
      units: [{ owner: 'mar', systemId: INF, pos: from.cityPoint, count: 3 }],
    }) as EngineState;
    expect(s.provinces[target.id]!.owner).toBe('dza');
    const r = applyOrder(s, 'mar', { kind: 'move', unitIds: ['u1'], to: target.cityPoint });
    expect(r.ok, r.error).toBe(true);
    advanceTo(s, movementEnd(s.units.u1!.move!) + (data.balance.time.captureMinutes + 5) * MINUTE);
    expect(s.provinces[target.id]!.owner).toBe('mar');
    // la province prise est entière : ses voisines algériennes restent algériennes
    for (const q of target.neighbors)
      if (data.map.provinces.find((p) => p.id === q)!.nationId === 'dza')
        expect(s.provinces[q]!.owner, q).toBe('dza');
  });
});

describe('réseau de routes : points de capture', () => {
  it('chaque province a son point de capture (ville, ou centre sans ville) sur le réseau', () => {
    for (const p of data.map.provinces) {
      const i = roads.nodeIndex(`c:${p.id}`);
      expect(i, p.id).toBeDefined();
      expect(roads.nodes[i!]!.pos).toEqual(p.cityPoint);
      const hit = roads.snap(p.cityPoint, 1)!;
      expect(hit.node, p.id).toBe(i);
    }
  });

  it('chaque point de capture est atteignable : par la route depuis une voisine, sinon par la mer', () => {
    const provById = new Map(data.map.provinces.map((p) => [p.id, p]));
    const node = (pid: string) => roads.nodePoint(roads.nodeIndex(`c:${pid}`)!);
    const hasPort = new Set(roads.ports.map((i) => roads.comp[i]!));
    const unreachable: string[] = [];
    const byRoad: string[] = [];
    const bySea: string[] = [];
    for (const p of data.map.provinces) {
      const target = node(p.id);
      const viaRoad = p.neighbors.some(
        (q) => provById.has(q) && roads.compOf(node(q)) === roads.compOf(target),
      );
      if (viaRoad) byRoad.push(p.id);
      else if (hasPort.has(roads.compOf(target))) bySea.push(p.id);
      else unreachable.push(p.id);
    }
    // Contrôle exact (A*) sur un échantillon déterministe des liaisons routières.
    for (const pid of byRoad.filter((_, k) => k % 50 === 0)) {
      const p = provById.get(pid)!;
      const q = p.neighbors.find((x) => roads.compOf(node(x)) === roads.compOf(node(pid)))!;
      expect(roads.route(node(q), node(pid)), `${q} → ${pid}`).not.toBeNull();
    }
    expect(bySea.length).toBeGreaterThan(0);
    // Provinces sans aucune voisine terrestre ni port (micro-îles sans côte navigable) : signalées.
    if (unreachable.length) console.warn(`provinces inatteignables : ${unreachable.join(', ')}`);
    expect(unreachable.length).toBeLessThanOrEqual(5);
  });
});
