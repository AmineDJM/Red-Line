import { describe, expect, it } from 'vitest';
import { MINUTE, HOUR, movementEnd, type GameNotification } from '@redline/shared';
import { advanceTo, applyOrder, legZoneIntervals, nextEventTime } from '../src/index.js';
import { isValid } from '../src/sim/settle.js';
import { destroyUnit, roundDamage } from '../src/combat/combat.js';
import { settle, cleanTop } from '../src/sim/settle.js';
import { unitPairKey } from '../src/encounters/pairs.js';
import { atWar, veterancyLevel } from '../src/state/access.js';
import { CATALOG, cityOf, sandbox, testWorld, worldWith } from './fixtures.js';
import type { EngineState } from '../src/state/types.js';

function run(s: EngineState, t: number): GameNotification[] {
  return advanceTo(s, t);
}

describe('rencontres et interceptions', () => {
  it('convoi détruit en route par une défense aérienne AVANT son heure d’arrivée', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.helo', pos: cityOf('aaa-1') }, // u1 : convoi héliporté
      { owner: 'bbb', systemId: 'tst.sam', pos: cityOf('bbb-4') }, // u2
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [9, 40] }).ok).toBe(true);
    const arrival = movementEnd(s.units.u1!.move!);
    const notes = run(s, arrival + HOUR);
    const destroyed = notes.find((n) => n.kind === 'unit_destroyed' && n.unitId === 'u1');
    expect(destroyed).toBeDefined();
    expect(destroyed!.time).toBeLessThan(arrival);
    expect(notes.some((n) => n.kind === 'arrived' && n.unitId === 'u1')).toBe(false);
    expect(s.units.u1).toBeUndefined();
    // Guerre déclarée automatiquement à l'entrée en territoire bbb.
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    // L'engagement a commencé à l'entrée dans la portée (80 km), pas avant la frontière.
    const started = notes.find((n) => n.kind === 'combat_started')!;
    expect(started.time).toBeGreaterThan(0);
    expect(started.time).toBeLessThan(destroyed!.time + 1);
  });

  it('radar détruit ⇒ l’événement de détection prévu est annulé', () => {
    const setup = [
      { owner: 'aaa', systemId: 'tst.drone', pos: cityOf('aaa-3') }, // u1
      { owner: 'ccc', systemId: 'tst.radar', pos: [13, 47] as [number, number] }, // u2
    ];
    // Instant exact d'entrée dans la couverture du radar (200 km × (1 − furtivité 0,3)).
    const ref = sandbox(setup);
    applyOrder(ref, 'aaa', { kind: 'move', unitIds: ['u1'], to: [11.5, 47] });
    const leg = ref.units.u1!.move!.legs[0]!;
    const detectAt = legZoneIntervals(leg, [13, 47], 200 * 0.7)[0]![0];
    const key = unitPairKey('u1', 'u2');
    const refNotes = run(ref, detectAt + MINUTE);
    const det = refNotes.find((n) => n.kind === 'unit_detected' && n.unitId === 'u1')!;
    expect(det).toBeDefined();
    expect(Math.abs(det.time - detectAt)).toBeLessThanOrEqual(1);
    expect(ref.know.ccc?.u1?.seen).toBe(true);

    const s = sandbox(setup);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [11.5, 47] });
    run(s, detectAt - MINUTE); // après le seuil « identifié » du drone sur le radar (150 km)
    const pending = s.pairs[key]!;
    const ev2 = s.queue.find((e) => e.k === 'contact' && e.key === key && e.s === pending.ev)!;
    expect(Math.abs(ev2.t - detectAt)).toBeLessThanOrEqual(1);
    destroyUnit(s, s.units.u2!, null);
    settle(s);
    cleanTop(s);
    expect(isValid(s, ev2)).toBe(false);
    expect(s.pairs[key]).toBeUndefined();
    const notes = run(s, detectAt + HOUR);
    expect(notes.some((n) => n.kind === 'unit_detected' && n.unitId === 'u1')).toBe(false);
    expect(s.know.ccc?.u1).toBeUndefined();
  });

  it('nouvel ordre ⇒ les anciennes interceptions sont annulées', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.helo', pos: cityOf('aaa-1') },
      { owner: 'bbb', systemId: 'tst.sam', pos: cityOf('bbb-4') },
    ]);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [9, 40] });
    const key = unitPairKey('u1', 'u2');
    const old = s.queue.filter((e) => (e.k === 'contact' && e.key === key) || ('u' in e && e.u === 'u1'));
    expect(old.length).toBeGreaterThan(0);
    run(s, 20 * MINUTE);
    // Demi-tour avant d'entrer en territoire bbb.
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-2') }).ok).toBe(true);
    for (const e of old) expect(isValid(s, e)).toBe(false);
    const notes = run(s, 10 * HOUR);
    expect(s.units.u1).toBeDefined();
    expect(notes.some((n) => n.kind === 'combat_started')).toBe(false);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(nextEventTime(s)).not.toBeNull();
  });

  it('croisement de deux unités mobiles : combat aérien en vol', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.fighter', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.fighter', pos: cityOf('bbb-2') },
    ]);
    // Guerre préalable via un ordre d'attaque d'une autre unité : ici, via les frontières.
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: [12.5, 44] });
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: [7.5, 44] });
    // Aucun des deux n'entre chez l'autre (mer intérieure) : pas de guerre, pas de combat.
    let notes = run(s, 2 * HOUR);
    expect(notes.some((n) => n.kind === 'combat_started')).toBe(false);
    expect(s.know.aaa?.u2).toBeDefined(); // mais ils se sont vus en se croisant
    // Avec guerre : ils s'engagent au croisement.
    const s2 = sandbox([
      { owner: 'aaa', systemId: 'tst.fighter', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.fighter', pos: cityOf('bbb-2') },
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] },
    ]);
    applyOrder(s2, 'aaa', { kind: 'move', unitIds: ['u3'], to: [5.3, 40] }); // entre en bbb-4 ⇒ guerre
    run(s2, 30 * MINUTE);
    expect(atWar(s2, 'aaa', 'bbb')).toBe(true);
    applyOrder(s2, 'aaa', { kind: 'move', unitIds: ['u1'], to: [12.5, 44] });
    applyOrder(s2, 'bbb', { kind: 'move', unitIds: ['u2'], to: [7.5, 44] });
    notes = run(s2, 4 * HOUR);
    const start = notes.find((n) => n.kind === 'combat_started');
    expect(start).toBeDefined();
    // Rapprochement : les deux avions sont à ~60 km l'un de l'autre au début du combat.
    expect(start!.time).toBeLessThan(30 * MINUTE + 20 * MINUTE);
  });
});

describe('combat, contre-mesures, vétérance', () => {
  function duel(a: string, b: string, hours = 3) {
    const s = sandbox([
      { owner: 'aaa', systemId: a, pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: b, pos: [7.5, 40.0] },
    ]);
    // Déclare la guerre (ordre d'attaque de l'une ou l'autre, si possible).
    const r = applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    if (!r.ok) {
      applyOrder(s, 'bbb', { kind: 'attack', unitIds: ['u2'], targetId: 'u1' });
    }
    const hp1 = s.units.u1!.hp;
    const hp2 = s.units.u2!.hp;
    const notes = run(s, hours * HOUR);
    return { s, notes, hp1, hp2 };
  }

  it('un char détruit une défense aérienne, qui ne peut rien contre lui', () => {
    const { s, notes, hp1 } = duel('tst.tank', 'tst.sam');
    expect(s.units.u2).toBeUndefined();
    expect(s.units.u1!.hp).toBe(hp1);
    expect(notes.some((n) => n.kind === 'unit_destroyed' && n.unitId === 'u2')).toBe(true);
  });

  it("un char ne peut pas viser un chasseur ; l'ordre est refusé", () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: 'tst.fighter', pos: [7.5, 40.0] },
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' })).toMatchObject({
      ok: false,
      error: 'invalid_target',
    });
  });

  it('un chasseur ne fait presque rien à un char (matrice de dégâts)', () => {
    const { s, hp2 } = duel('tst.fighter', 'tst.tank', 1);
    const lost = hp2 - s.units.u2!.hp;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(hp2 * 0.2);
  });

  it('dégâts = damage × effectif × vétérance × variance, réduits par le blindage et en ville', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.3] },
      { owner: 'bbb', systemId: 'tst.tank', pos: [7.5, 40.3] },
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-4') }, // dans sa ville
    ]);
    const tank = CATALOG.find((x) => x.id === 'tst.tank')!;
    const base = tank.damage.armor * 2 * (1 - tank.armor);
    expect(roundDamage(s, s.units.u1!, s.units.u2!, 1)).toBeCloseTo(base, 9);
    expect(roundDamage(s, s.units.u1!, s.units.u3!, 1)).toBeCloseTo(base / 1.25, 9);
    s.units.u1!.xp = 200; // niveau 2
    expect(veterancyLevel(s, 200)).toBe(2);
    expect(roundDamage(s, s.units.u1!, s.units.u2!, 1.1)).toBeCloseTo(base * 1.2 * 1.1, 9);
  });

  it('pertes en PV ⇒ effectif, XP et vétérance', () => {
    const { s } = duel('tst.tank', 'tst.infantry', 0.25);
    const inf = s.units.u2;
    const tank = s.units.u1!;
    expect(tank.xp).toBeGreaterThan(0);
    if (inf) expect(inf.count).toBe(Math.ceil(inf.hp / 10 - 1e-9));
    const { s: s2 } = duel('tst.tank', 'tst.infantry', 5);
    expect(s2.units.u2).toBeUndefined();
    expect(veterancyLevel(s2, s2.units.u1!.xp)).toBeGreaterThanOrEqual(0);
  });

  it('brouillage : un brouilleur allié réduit les dégâts reçus', () => {
    const w = testWorld();
    const s = sandbox(
      [
        { owner: 'aaa', systemId: 'tst.fighter', pos: [7.5, 40.0] },
        { owner: 'bbb', systemId: 'tst.helo', pos: [7.5, 40.1] },
        { owner: 'bbb', systemId: 'tst.jammer', pos: [7.6, 40.3] },
      ],
      { world: w },
    );
    const fighter = CATALOG.find((x) => x.id === 'tst.fighter')!;
    const d = roundDamage(s, s.units.u1!, s.units.u2!, 1);
    const raw = fighter.damage.helicopter;
    expect(d).toBeCloseTo(raw * (1 - 0.5 * (1 - fighter.ew.jamResistance)), 9);
  });

  it("posture 'hold' : pas de tir sans ordre ; 'aggressive' poursuit sa cible", () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: 'tst.tank', pos: [7.5, 40.0] },
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] },
    ]);
    applyOrder(s, 'aaa', { kind: 'stance', unitIds: ['u1'], stance: 'hold' });
    applyOrder(s, 'bbb', { kind: 'stance', unitIds: ['u2'], stance: 'hold' });
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u3'], to: [5.3, 40] }); // guerre
    const notes = run(s, 2 * HOUR);
    expect(atWar(s, 'aaa', 'bbb')).toBe(true);
    expect(notes.some((n) => n.kind === 'combat_started')).toBe(false);

    // Posture agressive : acquiert la cible au contact puis la poursuit quand elle s'enfuit.
    const s2 = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
      { owner: 'bbb', systemId: 'tst.tank', pos: [7.5, 40.0] },
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] },
    ]);
    applyOrder(s2, 'aaa', { kind: 'stance', unitIds: ['u1'], stance: 'aggressive' });
    applyOrder(s2, 'bbb', { kind: 'stance', unitIds: ['u2'], stance: 'hold' });
    applyOrder(s2, 'aaa', { kind: 'move', unitIds: ['u3'], to: [5.3, 40] }); // guerre
    run(s2, 20 * MINUTE);
    expect(s2.units.u1!.target).toBe('u2');
    expect(s2.units.u1!.tmode).toBe('auto');
    applyOrder(s2, 'bbb', { kind: 'move', unitIds: ['u2'], to: [9.0, 40.5] });
    run(s2, 40 * MINUTE);
    expect(s2.units.u1!.move).not.toBeNull(); // poursuite en cours
    run(s2, 12 * HOUR);
    expect(s2.units.u2).toBeUndefined();
    expect(s2.units.u1!.target).toBeNull();
  });

  it("ordre 'attack' : déplacement vers la cible puis engagement à portée", () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('bbb-4') },
      { owner: 'bbb', systemId: 'tst.infantry', pos: [7.7, 40.1] },
    ]);
    const r = applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    // Cible vue par le char (25 km) mais hors de portée d'arme (4 km).
    expect(r.ok).toBe(true);
    expect(s.units.u1!.move).not.toBeNull();
    const notes = run(s, 6 * HOUR);
    expect(notes.some((n) => n.kind === 'combat_started')).toBe(true);
    expect(s.units.u2).toBeUndefined();
  });

  it('unité hors de vue : ordre d’attaque refusé', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.tank', pos: cityOf('aaa-1') },
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-2') },
    ]);
    expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' })).toMatchObject({
      error: 'invalid_target',
    });
    expect(applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u2'], targetId: 'u1' })).toMatchObject({
      error: 'not_owner',
    });
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u9'], to: [1, 1] })).toMatchObject({
      error: 'unknown_unit',
    });
  });

  it('variance tirée du PRNG à graine', () => {
    const w = worldWith({});
    const mk = (seed: number) => {
      const s = sandbox(
        [
          { owner: 'aaa', systemId: 'tst.tank', pos: [7.5, 40.02] },
          { owner: 'bbb', systemId: 'tst.tank', pos: [7.5, 40.0] },
        ],
        { world: w, seed },
      );
      applyOrder(s, 'aaa', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
      run(s, 25 * MINUTE);
      return s.units.u2?.hp ?? 0;
    };
    expect(mk(1)).toBe(mk(1));
    expect(mk(1)).not.toBe(mk(2));
  });
});
