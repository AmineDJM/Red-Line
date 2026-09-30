import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, distanceKm } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { destroyUnit } from '../src/combat/combat.js';
import { mil } from '../src/modules/mil/state.js';
import { settle, cleanTop } from '../src/sim/settle.js';
import { cityOf } from './fixtures.js';
import { milSandbox, notesOf } from './mil-fixtures.js';

const H = (h: number) => Math.round(h * HOUR);

describe('aviation : patrouille, carburant, retour à la base', () => {
  it('patrouille (CAP) puis retour automatique au bingo, atterrissage et remise en œuvre', () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }]);
    const ms = () => mil(s).ms.u1!;
    expect(ms().fa).toBe(true);
    expect(ms().up).toBe(false);
    expect(ms().base).toBe('aaa-2');
    const at: [number, number] = [7.5, 44];
    expect(applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at, radiusKm: 100 }).ok).toBe(true);
    expect(ms().up).toBe(true);
    advanceTo(s, H(1));
    expect(ms().mis).toBe('patrol');
    expect(ms().ph).toBe('station');
    const v = viewFor(s, 'aaa').units.u1!;
    expect(v.mission?.kind).toBe('patrol');
    expect(v.mission?.airborne).toBe(true);
    expect(v.mission?.baseProvinceId).toBe('aaa-2');
    // Bingo exact : autonomie 3 h − réserve 0,25 h − retour (d / 900 km/h), depuis le décollage.
    const d = distanceKm(cityOf('aaa-2'), at);
    const bingo = H(3 - 0.25 - d / 900);
    expect(Math.abs(ms().bingo! - bingo)).toBeLessThan(2000);
    advanceTo(s, bingo - MINUTE);
    expect(ms().mis).toBe('patrol');
    advanceTo(s, bingo + MINUTE);
    expect(ms().mis).toBe('rtb');
    expect(ms().ph).toBe('back');
    const landing = bingo + H(d / 900);
    advanceTo(s, landing + MINUTE);
    expect(ms().up).toBe(false);
    expect(ms().fuel).toBeCloseTo(3, 9);
    expect(ms().ready).toBeGreaterThan(s.time);
    expect(s.units.u1).toBeDefined();
    // Remise en œuvre : pas de nouveau décollage avant `ready`.
    const r = applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at, radiusKm: 100 });
    expect(r.error).toBe('cooldown');
    advanceTo(s, ms().ready + 1);
    expect(applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at, radiusKm: 100 }).ok).toBe(true);
  });

  it("rayon d'action compté depuis la base ; autonomie insuffisante refusée", () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }]);
    const far = applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at: [20, 44], radiusKm: 50 });
    expect(far.ok).toBe(false);
    expect(far.error).toBe('out_of_range');
  });

  it('sans base atteignable : appareil perdu à l’épuisement du carburant', () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.jet', pos: [45, 44] }]);
    expect(mil(s).ms.u1!.up).toBe(true); // créé en l'air, loin de toute base
    const notes = advanceTo(s, H(3.5));
    expect(s.units.u1).toBeUndefined();
    const lost = notesOf(notes, 'generic').find((n) => n.title === 'Appareil perdu');
    expect(lost).toBeDefined();
    expect(Math.abs(lost!.time - H(3))).toBeLessThan(1000);
  });

  it('ravitaillement en vol : le chasseur rejoint le ravitailleur au bingo puis reprend sa patrouille', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }, // u1
      { owner: 'aaa', systemId: 'tst.tanker', pos: cityOf('aaa-2') }, // u2
    ]);
    const jet = () => mil(s).ms.u1!;
    const tk = () => mil(s).ms.u2!;
    expect(applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u2'], at: [7.5, 44], radiusKm: 50 }).ok).toBe(true);
    expect(tk().mis).toBe('refuel');
    expect(applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u1'], at: [10, 44], radiusKm: 100 }).ok).toBe(true);
    const bingo = jet().bingo!;
    advanceTo(s, bingo + MINUTE);
    expect(jet().ph).toBe('tanker');
    expect(jet().tk).toBe('u2');
    const give0 = tk().give;
    advanceTo(s, bingo + H(0.5));
    expect(tk().give).toBeLessThan(give0);
    expect(jet().mis).toBe('patrol');
    expect(jet().up).toBe(true);
    // Sans ravitailleur il aurait atterri vers bingo + 0,7 h ; il est encore en patrouille.
    advanceTo(s, bingo + H(1));
    expect(jet().up).toBe(true);
    expect(jet().mis).toBe('patrol');
    expect(jet().bingo!).toBeGreaterThan(bingo + H(1));
  });

  it('ravitailleurs et avions radar : cibles prioritaires', () => {
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.bomber', pos: [9.9, 44.0] }, // u1 (en l'air)
      { owner: 'aaa', systemId: 'tst.tanker', pos: [10.1, 44.0] }, // u2 (en l'air)
      { owner: 'bbb', systemId: 'tst.fighter', pos: [10, 44.1] }, // u3
      { owner: 'aaa', systemId: 'tst.infantry', pos: [4.9, 40] }, // u4
    ]);
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u4'], to: [5.3, 40] }); // guerre
    advanceTo(s, 40 * MINUTE);
    expect(s.units.u2 ? s.units.u2.hp < s.units.u2.maxHp : true).toBe(true);
    expect(s.units.u1!.hp).toBe(s.units.u1!.maxHp);
  });

  it('porte-avions : appareils embarqués, catapultage, appontage, perte avec le porteur', () => {
    const sea: [number, number] = [7.5, 44];
    const s = milSandbox([
      { owner: 'aaa', systemId: 'tst.carrier', pos: sea }, // u1
      { owner: 'aaa', systemId: 'tst.navyjet', pos: sea }, // u2
    ]);
    const ms = () => mil(s).ms.u2!;
    expect(ms().emb).toBe('u1');
    expect(s.units.u2!.off).toBe(true);
    let v = viewFor(s, 'aaa').units.u2!;
    expect(v.status).toBe('embarked');
    expect(v.mission?.baseUnitId).toBe('u1');
    expect(applyOrder(s, 'aaa', { kind: 'patrol', unitIds: ['u2'], at: [10, 44], radiusKm: 50 }).ok).toBe(true);
    expect(s.units.u2!.off).toBeFalsy();
    expect(ms().up).toBe(true);
    advanceTo(s, H(3));
    expect(ms().up).toBe(false);
    expect(ms().emb).toBe('u1');
    expect(s.units.u2!.off).toBe(true);
    v = viewFor(s, 'aaa').units.u2!;
    expect(v.status).toBe('embarked');
    destroyUnit(s, s.units.u1!, null);
    settle(s);
    cleanTop(s);
    expect(s.units.u2).toBeUndefined();
  });

  it('rebase vers une autre base aérienne ; déplacement simple vers un terrain ami = changement de base', () => {
    const s = milSandbox([{ owner: 'aaa', systemId: 'tst.jet', pos: cityOf('aaa-2') }]);
    expect(applyOrder(s, 'aaa', { kind: 'rebase', unitIds: ['u1'], provinceId: 'aaa-3' }).ok).toBe(true);
    advanceTo(s, H(1.5));
    expect(mil(s).ms.u1!.base).toBe('aaa-3');
    expect(mil(s).ms.u1!.up).toBe(false);
    advanceTo(s, H(3));
    expect(applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-1') }).ok).toBe(true);
    advanceTo(s, H(5));
    expect(mil(s).ms.u1!.base).toBe('aaa-1');
    expect(mil(s).ms.u1!.up).toBe(false);
    // Base inexistante : refusé.
    expect(applyOrder(s, 'aaa', { kind: 'rebase', unitIds: ['u1'], provinceId: 'bbb-2' }).ok).toBe(false);
  });
});
