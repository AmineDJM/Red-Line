import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE, distanceKm, type LngLat } from '@redline/shared';
import { advanceTo, applyOrder, diffViews, notificationsFor, viewFor } from '../src/index.js';
import { BALANCE, cityOf, sandbox } from './fixtures.js';

const at = (km: number): LngLat => [2.5 + km / 80.1, 44];

describe('brouillard de guerre', () => {
  it("aucune fuite : viewFor ne contient rien de ce qui n'est pas vu", () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }, // u1
      { owner: 'bbb', systemId: 'tst.tank', pos: cityOf('bbb-2') }, // u2 : loin
      { owner: 'bbb', systemId: 'tst.stealth', pos: [3.6, 44] }, // u3 : furtif, 88 km de la ville
      { owner: 'ccc', systemId: 'tst.frigate', pos: [-3, 44] }, // u4 : 440 km
    ]);
    advanceTo(s, HOUR);
    const v = viewFor(s, 'aaa');
    expect(Object.keys(v.units)).toEqual(['u1']);
    const json = JSON.stringify(v);
    for (const secret of ['u2', 'u3', 'u4', 'tst.tank', 'tst.stealth', 'tst.frigate']) {
      expect(json).not.toContain(`"${secret}"`);
    }
    expect(v.economy.money).toBe(s.nations.aaa!.money);
    expect(JSON.stringify(v.economy)).toBe(JSON.stringify(viewFor(s, 'aaa').economy));
    // Et la vue de bbb ne contient pas l'argent de aaa ni ses productions.
    const vb = viewFor(s, 'bbb');
    expect(vb.me).toBe('bbb');
    expect(vb.economy.money).toBe(s.nations.bbb!.money);
  });

  it('la furtivité réduit la portée de détection', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.radar', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.stealth', pos: at(100) }, // 200 × 0,2 = 40 km < 100
      { owner: 'bbb', systemId: 'tst.fighter', pos: at(150) }, // 200 × 0,9 = 180 km > 150
    ]);
    const v = viewFor(s, 'aaa');
    expect(v.units.u2).toBeUndefined();
    expect(v.units.u3).toBeDefined();
  });

  it('niveaux detected / identified / precise', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.radar', pos: cityOf('aaa-2') }, // portée 200 km
      { owner: 'bbb', systemId: 'tst.helo', pos: at(50) }, // ≤ 60 : précise
      { owner: 'bbb', systemId: 'tst.helo', pos: at(100) }, // ≤ 120 : identifiée
      { owner: 'bbb', systemId: 'tst.helo', pos: at(180) }, // ≤ 200 : détectée
      { owner: 'bbb', systemId: 'tst.helo', pos: at(250) }, // invisible
    ]);
    const v = viewFor(s, 'aaa');
    expect(v.units.u2).toMatchObject({
      level: 'precise',
      systemId: 'tst.helo',
      count: 1,
      hpRatio: 1,
    });
    expect(v.units.u2!.status).toBe('idle');
    expect(v.units.u3).toMatchObject({ level: 'identified', systemId: 'tst.helo' });
    expect(v.units.u3!.count).toBeUndefined();
    expect(v.units.u3!.hpRatio).toBeUndefined();
    expect(v.units.u4!.level).toBe('detected');
    expect(v.units.u4!.systemId).toBeUndefined();
    expect(v.units.u4!.count).toBeUndefined();
    expect(v.units.u4!.stance).toBeUndefined();
    expect(v.units.u5).toBeUndefined();
    for (const u of [v.units.u2!, v.units.u3!, v.units.u4!]) {
      expect(u.uncertaintyKm).toBe(0);
      expect(u.xp).toBeUndefined();
      expect(u.targetId).toBeUndefined();
    }
    expect(v.units.u1).toMatchObject({ level: 'own', stance: 'defend', xp: 0 });
  });

  it('ennemi observé : seulement le segment courant ; propre unité : trajet complet', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.drone', pos: [11, 40.5] }, // surveille le sud-est
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
    ]);
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: cityOf('bbb-2') });
    const own = viewFor(s, 'bbb').units.u2!;
    expect(own.move!.legs.length).toBeGreaterThan(1);
    expect(viewFor(s, 'aaa').units.u2).toBeUndefined();
    advanceTo(s, 3 * HOUR);
    const seen = viewFor(s, 'aaa').units.u2!;
    expect(seen).toBeDefined();
    expect(seen.move!.legs).toHaveLength(1);
    const cur = s.units.u2!.move!.legs.find((l) => l.t0 <= s.time && s.time < l.t1)!;
    expect(seen.move!.legs[0]!.to).toEqual(cur.to);
    expect(seen.move!.legs[0]!.t1).toBe(cur.t1);
    // Le début réel du trajet (avant l'observation) n'est pas révélé.
    expect(seen.pos).not.toEqual(s.units.u2!.pos);
    expect(seen.move!.legs[0]!.t0).toBeGreaterThan(0);
  });

  it('contact perdu : dernière position, incertitude croissante, oubli', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.radar', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.helo', pos: at(150) },
    ]);
    expect(viewFor(s, 'aaa').units.u2).toBeDefined();
    const v0 = viewFor(s, 'aaa');
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: at(400) });
    advanceTo(s, 1 * HOUR); // sort à 200 km après ~12 min
    const v1 = viewFor(s, 'aaa');
    const c = v1.units.u2!;
    expect(c.level).toBe('detected');
    expect(c.lastSeen).toBeGreaterThan(10 * MINUTE);
    expect(c.lastSeen).toBeLessThan(13 * MINUTE);
    expect(distanceKm(c.pos, cityOf('aaa-2'))).toBeCloseTo(200, 0);
    const growth = BALANCE.sensors.uncertaintyGrowthKmh;
    expect(c.uncertaintyKm).toBeCloseTo(((HOUR - c.lastSeen) / HOUR) * growth, 6);
    expect(c.move).toBeUndefined();
    // La position réelle n'est pas révélée.
    expect(distanceKm(c.pos, at(400))).toBeGreaterThan(100);
    const d = diffViews(v0, v1)!;
    expect(d.units!.upsert.map((u) => u.id)).toEqual(['u2']);
    advanceTo(s, c.lastSeen + BALANCE.sensors.forgetAfterMinutes * MINUTE + MINUTE);
    const v2 = viewFor(s, 'aaa');
    expect(v2.units.u2).toBeUndefined();
    expect(diffViews(v1, v2)!.units!.remove).toEqual(['u2']);
  });

  it('notifications filtrées par nation', () => {
    const s = sandbox([
      { owner: 'aaa', systemId: 'tst.radar', pos: cityOf('aaa-2') },
      { owner: 'bbb', systemId: 'tst.helo', pos: at(300) },
    ]);
    applyOrder(s, 'bbb', { kind: 'move', unitIds: ['u2'], to: at(150) });
    const notes = advanceTo(s, 2 * HOUR);
    const det = notes.filter((n) => n.kind === 'unit_detected');
    expect(det).toHaveLength(1);
    expect(
      notificationsFor(s, 'aaa', notes).filter((n) => n.kind === 'unit_detected'),
    ).toHaveLength(1);
    expect(
      notificationsFor(s, 'bbb', notes).filter((n) => n.kind === 'unit_detected'),
    ).toHaveLength(0);
    expect(notificationsFor(s, 'bbb', notes).filter((n) => n.kind === 'arrived')).toHaveLength(1);
    expect(notificationsFor(s, 'aaa', notes).filter((n) => n.kind === 'arrived')).toHaveLength(0);
  });

  it('diffViews : null si rien ne change, sinon seulement ce qui change', () => {
    const s = sandbox([{ owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }]);
    const a = viewFor(s, 'aaa');
    advanceTo(s, 10 * MINUTE);
    const b = viewFor(s, 'aaa');
    expect(diffViews(a, b)).toBeNull();
    applyOrder(s, 'aaa', { kind: 'move', unitIds: ['u1'], to: cityOf('aaa-3') });
    const c = viewFor(s, 'aaa');
    const d = diffViews(b, c)!;
    expect(d.units!.upsert).toHaveLength(1);
    expect(d.units!.remove).toHaveLength(0);
    expect(d.provinces).toBeUndefined();
    expect(d.nations).toBeUndefined();
    expect(d.economy).toBeUndefined();
  });
});
