/**
 * Choix de cible au combat (combat.ts, chooseTarget) : riposte prioritaire contre les menaces au
 * contact, score fondé sur toute la composition des piles mixtes, frappes lointaines quand rien ne
 * menace. Régression de la conquête réelle (Charleroi) : une brigade arrivée sur la garnison tirait
 * sur l'aérodrome à 47 km parce que le tableau de dégâts de son seul matériel de tête l'y poussait.
 */
import { describe, expect, it } from 'vitest';
import { MINUTE, WeaponSystemSchema, distanceKm, type LngLat } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, stateHash } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { unitPosAt } from '../src/state/access.js';
import { BALANCE } from './fixtures.js';
import { MIL_CATALOG, milMap, milSandbox } from './mil-fixtures.js';

/** Loin des villes (pas de bonus de ville), en territoire aaa. */
const P: LngLat = [1.0, 39.0];
const NEAR: LngLat = [1.02, 39.0]; // ≈ 1,7 km : au contact
const FAR: LngLat = [1.25, 39.0]; // ≈ 21,6 km : à portée de l'artillerie seulement

const tank = MIL_CATALOG.find((s) => s.id === 'tst.tank')!;
/** Antichar léger : peu de PV (jamais matériel de tête), dégâts massifs contre les blindés. */
const AT = WeaponSystemSchema.parse({
  ...tank,
  id: 'tst.antitank',
  category: 'infantry',
  targetClass: 'infantry',
  hp: 5,
  armor: 0,
  weaponRangeKm: { min: 0, max: 4 },
  damage: { ...tank.damage, infantry: 0.5, armor: 30, building: 0 },
});
/** Camion : blindé léger sans arme (jamais une menace). */
const TRUCK = WeaponSystemSchema.parse({
  ...tank,
  id: 'tst.truck',
  category: 'logistics',
  armor: 0,
  canCapture: false,
  weaponRangeKm: { min: 0, max: 0 },
  damage: Object.fromEntries(Object.keys(tank.damage).map((k) => [k, 0])),
});
const world = buildWorld(milMap(), [...MIL_CATALOG, AT, TRUCK], BALANCE);

/** Points de vie perdus par une unité. */
const lost = (s: EngineState, id: string) => {
  const u = s.units[id];
  return u ? u.maxHp - u.hp : Infinity;
};

function fight(s: EngineState, minutes = 15): void {
  expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
  advanceTo(s, s.time + minutes * MINUTE);
}

describe('choix de cible', () => {
  it('riposte : la brigade tire sur la garnison au contact, pas sur l’infanterie ni le radar lointains', () => {
    const s = milSandbox(
      [
        { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 }, // u1 : matériel de tête
        { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 }, // u2
        { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 2 }, // u3 : 5 à 40 km
        { owner: 'bbb', systemId: 'tst.tank', pos: NEAR, count: 3 }, // u4 : garnison au contact
        { owner: 'bbb', systemId: 'tst.infantry', pos: FAR, count: 5 }, // u5 : lointaine
        { owner: 'bbb', systemId: 'tst.radar', pos: FAR, count: 1 }, // u6 : bâtiment lointain
      ],
      { world },
    );
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2', 'u3'] }).ok).toBe(true);
    // Le matériel de tête (char) préférerait l'infanterie (6 contre 8 × 0,7 = 5,6) : l'ancien choix.
    expect(s.units.u1!.sys).toBe('tst.tank');
    fight(s);
    expect(lost(s, 'u4')).toBeGreaterThan(0);
    expect(lost(s, 'u5')).toBe(0);
    expect(lost(s, 'u6')).toBe(0);
  });

  it('composition : la pile vise ce que TOUS ses matériels détruisent le mieux', () => {
    const s = milSandbox(
      [
        { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 3 }, // u1 : tête (90 PV)
        { owner: 'aaa', systemId: 'tst.antitank', pos: P, count: 6 }, // u2 : 30 PV
        { owner: 'bbb', systemId: 'tst.infantry', pos: NEAR, count: 4 }, // u3
        { owner: 'bbb', systemId: 'tst.tank', pos: NEAR, count: 2 }, // u4
      ],
      { world },
    );
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
    expect(s.units.u1!.sys).toBe('tst.tank');
    // Tête seule : infanterie (6) avant chars (5,6). Pile entière : 3 × 8 × 0,7 + 6 × 30 × 0,7 = 142,8
    // contre les chars, 3 × 6 + 6 × 0,5 = 21 contre l'infanterie.
    fight(s, 5);
    expect(lost(s, 'u4')).toBeGreaterThan(0);
    expect(lost(s, 'u3')).toBe(0);
  });

  it('composition à portée : seuls les matériels qui portent comptent', () => {
    const s = milSandbox(
      [
        { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 3 }, // u1 : tête (90 PV), 0 à 4 km
        { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 5 }, // u2 : 75 PV, 5 à 40 km
        { owner: 'bbb', systemId: 'tst.truck', pos: [1.035, 39.0], count: 2 }, // u3 : ≈ 3 km
        { owner: 'bbb', systemId: 'tst.radar', pos: FAR, count: 1 }, // u4 : bâtiment lointain
      ],
      { world },
    );
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
    expect(s.units.u1!.sys).toBe('tst.tank');
    // Fiche moyenne de la pile (tous matériels confondus) : camion (3 × 8 + 5 × 4) / 8 = 5,5 devant
    // radar (3 × 4 + 5 × 6) / 8 = 5,25. À portée réelle : chars sur le camion 3 × 8 = 24, artillerie
    // sur le radar 5 × 6 = 30 : la pile frappe le radar. Aucun des deux ne menace : pas de riposte.
    // Premier round seulement (le radar détruit, la pile passe ensuite au camion).
    fight(s, 5);
    expect(lost(s, 'u4')).toBeGreaterThan(0);
    expect(lost(s, 'u3')).toBe(0);
  });

  it('frappe à distance : sans menace au contact, l’artillerie vise loin', () => {
    const s = milSandbox(
      [
        { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 2 },
        { owner: 'bbb', systemId: 'tst.infantry', pos: FAR, count: 5 },
      ],
      { world },
    );
    fight(s);
    expect(lost(s, 'u2')).toBeGreaterThan(0);
  });

  it('cible d’ordre conservée ; choix déterministe', () => {
    const run = () => {
      const s = milSandbox(
        [
          { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 4 },
          { owner: 'aaa', systemId: 'tst.artillery', pos: P, count: 2 },
          { owner: 'bbb', systemId: 'tst.tank', pos: NEAR, count: 3 },
          { owner: 'bbb', systemId: 'tst.radar', pos: FAR, count: 1 },
        ],
        { world },
      );
      applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] });
      expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
      // Ordre explicite du joueur : le radar lointain, malgré la menace au contact.
      expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u4' }).ok).toBe(
        true,
      );
      advanceTo(s, s.time + 15 * MINUTE);
      return s;
    };
    const a = run();
    expect(lost(a, 'u4')).toBeGreaterThan(0);
    expect(stateHash(run())).toBe(stateHash(a));
  });

  it('poursuite d’une pile mixte : arrêt à la portée de tous ses matériels, distance de paire exacte', () => {
    // Avant correction : la portée commune (3 km, infanterie) n'était pas un seuil de la paire ; la
    // pile dépassait ce point jusqu'à la cible (0 km) et la distance de paire restait figée à 4 km.
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: P, count: 2 }, // 0 à 4 km
      { owner: 'aaa', systemId: 'tst.infantry', pos: P, count: 6 }, // 0 à 3 km
      { owner: 'bbb', systemId: 'tst.tank', pos: [1.12, 39.0], count: 1 }, // ≈ 10 km
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'merge', unitIds: ['u1', 'u2'] }).ok).toBe(true);
    expect(applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' }).ok).toBe(true);
    expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u3' }).ok).toBe(true);
    advanceTo(s, 20 * MINUTE); // arrêt vers 15 min, cible encore en vie
    const u = s.units.u1!;
    expect(u.move).toBeNull();
    const real = distanceKm(unitPosAt(s, u, s.time), unitPosAt(s, s.units.u3!, s.time));
    expect(real).toBeCloseTo(3, 2);
    expect(s.pairs['u1|u3']!.d).toBeCloseTo(real, 6);
  });
});
