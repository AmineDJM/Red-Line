import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  applySystem,
  createGame,
  publicView,
  viewFor,
} from '../src/index.js';
import { canImport, modifier } from '../src/modules/registry.js';
import { atWar } from '../src/state/access.js';
import type { EngineState } from '../src/state/types.js';
import { cityOf, testWorld, unitsOf } from './fixtures.js';
import { B, CHARTER, D, game, ok } from './diplo-helpers.js';

/** Quatre joueurs humains, chacun chef de sa propre alliance : le Conseil = 4 chefs (aucun siège tournant). */
function councilGame(
  rule: { majority?: 'simple' | 'two_thirds'; veto?: boolean } = {},
  speed = 1,
): EngineState {
  const s = createGame(testWorld(), {
    seed: 3,
    players: ['aaa', 'bbb', 'ccc', 'ddd'].map((nationId) => ({ nationId, isAi: false })),
    units: [
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-1') },
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
    ],
    speed,
    diplomacy: { ...rule, rotatingSeats: 0 },
  }) as EngineState;
  for (const n of ['aaa', 'bbb', 'ccc', 'ddd'])
    ok(s, n, { kind: 'createAlliance', name: `Alliance ${n}`, flag: n, charter: CHARTER });
  return s;
}

const opens = (s: EngineState) => D(s).session.opensAt;

describe('diplomatie : Conseil de sécurité', () => {
  it('séance mensuelle : propositions, puis vote de 12 h réelles (converties avec la vitesse)', () => {
    const s = councilGame({}, 4);
    expect(opens(s)).toBe(30 * DAY);
    expect(D(s).voteWindowMs).toBe(12 * HOUR * 4);
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'arms_embargo',
      target: { nationId: 'bbb' },
      text: '',
    });
    // Vote impossible pendant la phase des propositions.
    const rid = D(s).session.resolutions[0]!.id;
    expect(
      applyOrder(s, 'ccc', { kind: 'voteResolution', resolutionId: rid, vote: 'yes' }).error,
    ).toBe('locked');
    const notes = advanceTo(s, 30 * DAY);
    expect(notes.some((n) => n.kind === 'council')).toBe(true);
    const v = viewFor(s, 'ccc').council!;
    expect(v.session!.phase).toBe('voting');
    expect(v.members).toEqual(['aaa', 'bbb', 'ccc', 'ddd']);
    expect(v.session!.votingEndsAt).toBe(30 * DAY + 48 * HOUR);
    // Proposition close pendant le vote.
    expect(
      applyOrder(s, 'ddd', {
        kind: 'proposeResolution',
        type: 'condemnation',
        target: { nationId: 'bbb' },
        text: '',
      }).error,
    ).toBe('locked');
    // La nation visée ne vote pas.
    expect(applyOrder(s, 'bbb', { kind: 'voteResolution', resolutionId: rid, vote: 'no' }).ok).toBe(
      false,
    );
  });

  it('embargo adopté : import au catalogue verrouillé pour la nation visée, levé à l’expiration', () => {
    const s = councilGame();
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'arms_embargo',
      target: { nationId: 'bbb' },
      text: 'Embargo.',
    });
    advanceTo(s, 30 * DAY);
    const rid = D(s).session.resolutions[0]!.id;
    for (const n of ['aaa', 'ccc', 'ddd'])
      ok(s, n, { kind: 'voteResolution', resolutionId: rid, vote: 'yes' });
    expect(canImport(s, 'bbb', 'tst.tank')).toBeNull();
    advanceTo(s, 30 * DAY + 12 * HOUR);
    expect(B(s).embargoed.bbb).toBe(true);
    expect(canImport(s, 'bbb', 'tst.tank')).toBe('locked');
    expect(canImport(s, 'aaa', 'tst.tank')).toBeNull();
    const v = viewFor(s, 'aaa');
    expect(v.council!.inForce[0]).toMatchObject({ type: 'arms_embargo', status: 'passed' });
    expect(v.nations.bbb!.embargoed).toBe(true);
    // Nouvelle séance ouverte aux propositions.
    expect(v.council!.session!.phase).toBe('proposals');
    expect(v.council!.nextSessionAt).toBe(60 * DAY);
    advanceTo(s, 61 * DAY);
    expect(B(s).embargoed.bbb).toBeUndefined();
    expect(canImport(s, 'bbb', 'tst.tank')).toBeNull();
  });

  it('veto d’un chef d’alliance', () => {
    const s = councilGame({ veto: true });
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'economic_sanctions',
      target: { nationId: 'bbb' },
      text: '',
    });
    advanceTo(s, 30 * DAY);
    const rid = D(s).session.resolutions[0]!.id;
    ok(s, 'aaa', { kind: 'voteResolution', resolutionId: rid, vote: 'yes' });
    ok(s, 'ccc', { kind: 'voteResolution', resolutionId: rid, vote: 'yes' });
    ok(s, 'ddd', { kind: 'voteResolution', resolutionId: rid, vote: 'no' });
    advanceTo(s, 31 * DAY);
    expect(B(s).sanctions.bbb).toBeUndefined();
    expect(viewFor(s, 'aaa').news!.some((n) => /veto/i.test(n.headline))).toBe(true);

    // Sans veto, 2 contre 1 suffit à la majorité simple, pas aux deux tiers stricts avec 2 contre 2.
    const t = councilGame({ veto: false });
    ok(t, 'aaa', {
      kind: 'proposeResolution',
      type: 'economic_sanctions',
      target: { nationId: 'bbb' },
      text: '',
    });
    advanceTo(t, 30 * DAY);
    const r2 = D(t).session.resolutions[0]!.id;
    ok(t, 'aaa', { kind: 'voteResolution', resolutionId: r2, vote: 'yes' });
    ok(t, 'ccc', { kind: 'voteResolution', resolutionId: r2, vote: 'yes' });
    ok(t, 'ddd', { kind: 'voteResolution', resolutionId: r2, vote: 'no' });
    advanceTo(t, 31 * DAY);
    expect(B(t).sanctions.bbb).toBeLessThan(1);
    expect(viewFor(t, 'bbb').nations.bbb!.sanctioned).toBe(true);
  });

  it('majorité des deux tiers', () => {
    const s = councilGame({ majority: 'two_thirds', veto: false });
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'condemnation',
      target: { nationId: 'bbb' },
      text: '',
    });
    ok(s, 'bbb', {
      kind: 'proposeResolution',
      type: 'condemnation',
      target: { nationId: 'aaa' },
      text: '',
    });
    advanceTo(s, 30 * DAY);
    const [r1, r2] = D(s).session.resolutions.map((r) => r.id);
    // r1 : 2 pour, 1 contre (2/3) → adoptée. r2 : 1 pour, 1 contre → rejetée.
    ok(s, 'aaa', { kind: 'voteResolution', resolutionId: r1!, vote: 'yes' });
    ok(s, 'ccc', { kind: 'voteResolution', resolutionId: r1!, vote: 'yes' });
    ok(s, 'ddd', { kind: 'voteResolution', resolutionId: r1!, vote: 'no' });
    ok(s, 'bbb', { kind: 'voteResolution', resolutionId: r2!, vote: 'yes' });
    ok(s, 'ccc', { kind: 'voteResolution', resolutionId: r2!, vote: 'no' });
    const before = { a: B(s).stability.aaa!, b: B(s).stability.bbb! };
    advanceTo(s, 30 * DAY + 13 * HOUR);
    expect(B(s).stability.bbb!).toBeLessThan(before.b);
    expect(B(s).stability.aaa!).toBe(before.a);
    expect(D(s).rep.bbb).toBeLessThan(50);
  });

  it('cessez-le-feu violé : forte perte de stabilité et vote de sanctions automatique', () => {
    const s = councilGame();
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    ok(s, 'aaa', { kind: 'proposePeace', nationId: 'bbb', type: 'ceasefire' });
    ok(s, 'bbb', { kind: 'answerPeace', nationId: 'aaa', accept: true });
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(viewFor(s, 'aaa').diplomacy!.relations.find((r) => r.nationId === 'bbb')?.relation).toBe(
      'ceasefire',
    );
    const before = B(s).stability.aaa!;
    advanceTo(s, 2 * DAY);
    // Violation : attaque (ordre) pendant la trêve.
    const tgt = unitsOf(s, 'bbb')[0]!;
    const r = applyOrder(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    expect(r.ok).toBe(true);
    void tgt;
    expect(B(s).stability.aaa!).toBeLessThanOrEqual(before - 25);
    expect(D(s).rep.aaa).toBeLessThan(30);
    const sess = D(s).session;
    expect(sess.phase).toBe('voting'); // séance d'urgence
    expect(sess.resolutions[0]).toMatchObject({
      type: 'economic_sanctions',
      target: { nationId: 'aaa' },
      status: 'voting',
    });
    expect(viewFor(s, 'ccc').news!.some((n) => /cessez-le-feu/i.test(n.headline))).toBe(true);
  });

  it('séance d’urgence et événements mondiaux (commande système)', () => {
    const s = councilGame();
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'condemnation',
      target: { nationId: 'bbb' },
      text: '',
    });
    expect(
      applySystem(s, { kind: 'worldEvent', event: 'emergency_council', message: 'Crise.' }).ok,
    ).toBe(true);
    expect(D(s).session.phase).toBe('voting');
    expect(modifier(s, 'aaa', 'income.money')).toBe(1);
    expect(
      applySystem(s, { kind: 'worldEvent', event: 'market_crash', params: { days: 2 } }).ok,
    ).toBe(true);
    expect(modifier(s, 'aaa', 'income.money')).toBeCloseTo(0.8);
    expect(publicView(s).news!.some((n) => n.category === 'economy')).toBe(true);
    advanceTo(s, 3 * DAY);
    expect(modifier(s, 'aaa', 'income.money')).toBe(1);
  });

  it('zone d’exclusion aérienne et force de maintien de la paix', () => {
    const s = councilGame();
    ok(s, 'aaa', {
      kind: 'proposeResolution',
      type: 'no_fly_zone',
      target: { provinceIds: ['bbb-4', 'bbb-5'] },
      text: '',
    });
    ok(s, 'ccc', {
      kind: 'proposeResolution',
      type: 'peacekeeping',
      target: { provinceIds: ['bbb-4'] },
      text: '',
    });
    advanceTo(s, 30 * DAY);
    for (const r of D(s).session.resolutions)
      for (const n of ['aaa', 'ccc', 'ddd'])
        ok(s, n, { kind: 'voteResolution', resolutionId: r.id, vote: 'yes' });
    advanceTo(s, 31 * DAY);
    expect(B(s).noFly).toEqual({ 'bbb-4': true, 'bbb-5': true });
    const v = viewFor(s, 'bbb');
    expect(v.provinces['bbb-4']!.noFlyZone).toBe(true);
    const pk = unitsOf(s, 'onu');
    expect(pk.length).toBeGreaterThan(0);
    expect(v.nations.onu!.name).toBe('Casques bleus');
    const seen = Object.values(v.units).filter((u) => u.owner === 'onu');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.affiliation === 'peacekeeper')).toBe(true);
    // Attaquer les casques bleus : condamnation et sanctions mises au vote.
    const repBefore = D(s).rep.bbb!;
    ok(s, 'bbb', { kind: 'attack', unitIds: [unitsOf(s, 'bbb')[0]!.id], targetId: pk[0]!.id });
    expect(D(s).rep.bbb!).toBeLessThan(repBefore);
    expect(D(s).session.resolutions.some((r) => r.auto && r.target.nationId === 'bbb')).toBe(true);
    // Fin de mandat : les casques bleus se retirent.
    advanceTo(s, 55 * DAY);
    expect(unitsOf(s, 'onu')).toHaveLength(0);
  });

  it('cessez-le-feu imposé par résolution', () => {
    const s = councilGame();
    ok(s, 'aaa', { kind: 'declareWar', nationId: 'bbb' });
    ok(s, 'ccc', {
      kind: 'proposeResolution',
      type: 'ceasefire',
      target: { nationId: 'aaa' },
      text: '',
    });
    advanceTo(s, 30 * DAY);
    const rid = D(s).session.resolutions[0]!.id;
    for (const n of ['bbb', 'ccc', 'ddd'])
      ok(s, n, { kind: 'voteResolution', resolutionId: rid, vote: 'yes' });
    advanceTo(s, 31 * DAY);
    expect(atWar(s, 'aaa', 'bbb')).toBe(false);
    expect(B(s).ceasefires['aaa|bbb']).toBeGreaterThan(s.time);
  });
});
