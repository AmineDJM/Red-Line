import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import { advanceTo, applyOrder, viewFor } from '../src/index.js';
import { atWar } from '../src/state/access.js';
import { cityOf, unitsOf } from './fixtures.js';
import { B, CHARTER, D, game, ok } from './diplo-helpers.js';

/** aaa et ccc alliés (défense mutuelle), bbb extérieur. */
function allied(charter = CHARTER) {
  const s = game({
    units: [
      { owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-3') },
      { owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-4') },
      { owner: 'ccc', systemId: 'tst.infantry', pos: cityOf('ccc-1') },
    ],
  });
  ok(s, 'aaa', { kind: 'createAlliance', name: 'Pacte du Nord', flag: 'PN', charter });
  const id = B(s).allianceOf.aaa!;
  ok(s, 'aaa', { kind: 'inviteToAlliance', nationId: 'ccc' });
  ok(s, 'ccc', { kind: 'answerInvite', allianceId: id, accept: true });
  return { s, id };
}

describe('diplomatie : alliances', () => {
  it('création, invitation, adhésion : tableau partagé, vue et relation « ally »', () => {
    const { s, id } = allied();
    expect(B(s).allianceOf).toEqual({ aaa: id, ccc: id });
    const v = viewFor(s, 'ccc');
    expect(v.diplomacy!.myAllianceId).toBe(id);
    expect(v.diplomacy!.alliances[0]).toMatchObject({
      name: 'Pacte du Nord',
      leader: 'aaa',
      members: ['aaa', 'ccc'],
    });
    expect(v.diplomacy!.relations.find((r) => r.nationId === 'aaa')?.relation).toBe('ally');
    expect(v.nations.aaa!.allianceId).toBe(id);
    // Vue d'un non-membre : pas de votes internes ni de trésor.
    const vb = viewFor(s, 'bbb');
    expect(vb.diplomacy!.myAllianceId).toBeNull();
    expect(vb.diplomacy!.alliances[0]!.votes).toEqual([]);
    expect(v.news!.some((n) => n.category === 'alliance')).toBe(true);
    // Seul le chef invite ; une nation déjà alliée ne peut en créer une autre.
    expect(applyOrder(s, 'ccc', { kind: 'inviteToAlliance', nationId: 'ddd' }).ok).toBe(false);
    expect(
      applyOrder(s, 'ccc', { kind: 'createAlliance', name: 'Autre', flag: 'A', charter: CHARTER })
        .ok,
    ).toBe(false);
  });

  it('défense mutuelle : attaquer un membre met en guerre avec toute l’alliance après le délai', () => {
    const { s } = allied();
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    expect(atWar(s, 'bbb', 'aaa')).toBe(true);
    expect(atWar(s, 'bbb', 'ccc')).toBe(false);
    const A = Object.values(D(s).alliances)[0]!;
    expect(A.votes).toHaveLength(1);
    expect(A.votes[0]).toMatchObject({ kind: 'skip_mutual_defense', subject: 'bbb' });
    advanceTo(s, 6 * HOUR);
    expect(atWar(s, 'bbb', 'ccc')).toBe(true);
    expect(D(s).aggressor['bbb|ccc']).toBe('ccc'); // déclaration défensive, sans pénalité d'agression
    expect(D(s).rep.ccc).toBe(50);
    expect(D(s).rep.bbb).toBeLessThan(50);
    expect(viewFor(s, 'ddd').news!.some((n) => /défense mutuelle/i.test(n.headline + n.body))).toBe(
      true,
    );
  });

  it('vote de dispense : l’alliance peut refuser la défense mutuelle', () => {
    const { s } = allied();
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    const vote = Object.values(D(s).alliances)[0]!.votes[0]!;
    ok(s, 'aaa', { kind: 'allianceVote', voteId: vote.id, yes: true });
    ok(s, 'ccc', { kind: 'allianceVote', voteId: vote.id, yes: true });
    // Tous les membres ont voté : clôture immédiate, dispense accordée.
    const A = Object.values(D(s).alliances)[0]!;
    expect(A.votes).toHaveLength(0);
    expect(A.skip.bbb).toBeGreaterThan(s.time);
    advanceTo(s, DAY);
    expect(atWar(s, 'bbb', 'ccc')).toBe(false);
    // Une nouvelle guerre contre bbb pendant la dispense ne rouvre pas de vote.
    ok(s, 'bbb', { kind: 'proposePeace', nationId: 'aaa', type: 'peace' });
    ok(s, 'aaa', { kind: 'answerPeace', nationId: 'bbb', accept: true });
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    expect(Object.values(D(s).alliances)[0]!.votes).toHaveLength(0);
  });

  it('vote de dispense rejeté : la défense mutuelle s’applique à l’échéance', () => {
    const { s } = allied();
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'aaa' });
    const vote = Object.values(D(s).alliances)[0]!.votes[0]!;
    ok(s, 'aaa', { kind: 'allianceVote', voteId: vote.id, yes: false });
    ok(s, 'ccc', { kind: 'allianceVote', voteId: vote.id, yes: false });
    expect(atWar(s, 'bbb', 'ccc')).toBe(true);
  });

  it('droit de passage : entrer chez un allié ne déclare pas la guerre', () => {
    const { s } = allied();
    const inf = unitsOf(s, 'aaa', 'tst.infantry')[0]!;
    ok(s, 'aaa', { kind: 'move', unitIds: [inf.id], to: cityOf('ccc-1') });
    advanceTo(s, 2 * DAY);
    expect(atWar(s, 'aaa', 'ccc')).toBe(false);
    expect(s.provinces['ccc-1']!.owner).toBe('ccc');

    const t = allied({ ...CHARTER, passage: false }).s;
    const u2 = unitsOf(t, 'aaa', 'tst.infantry')[0]!;
    ok(t, 'aaa', { kind: 'move', unitIds: [u2.id], to: cityOf('ccc-1') });
    advanceTo(t, 2 * DAY);
    expect(atWar(t, 'aaa', 'ccc')).toBe(true);
  });

  it('départ en pleine guerre : coûte stabilité et réputation ; trésor commun', () => {
    const { s, id } = allied();
    ok(s, 'ccc', { kind: 'allianceTreasury', amount: 500 });
    expect(D(s).alliances[id]!.treasury).toBe(500);
    expect(applyOrder(s, 'ccc', { kind: 'allianceTreasury', amount: -100 }).ok).toBe(false); // pas le chef
    ok(s, 'aaa', { kind: 'allianceTreasury', amount: -200 });
    expect(D(s).alliances[id]!.treasury).toBe(300);
    ok(s, 'bbb', { kind: 'declareWar', nationId: 'ccc' });
    const before = B(s).stability.ccc!;
    ok(s, 'ccc', { kind: 'leaveAlliance' });
    expect(B(s).stability.ccc!).toBeLessThan(before);
    expect(D(s).rep.ccc).toBeLessThan(50);
    expect(B(s).allianceOf.ccc).toBeUndefined();
    expect(viewFor(s, 'ccc').stability!.factors.some((f) => f.label === "Départ d'alliance")).toBe(
      true,
    );
  });

  it('chef inactif trop longtemps : vote de remplacement puis nouveau chef', () => {
    const { s, id } = allied();
    // ccc reste actif, aaa (chef, joueur humain) ne donne plus d'ordre.
    for (let d = 1; d <= 4; d++) {
      advanceTo(s, d * DAY - HOUR);
      ok(s, 'ccc', { kind: 'stance', unitIds: [unitsOf(s, 'ccc')[0]!.id], stance: 'defend' });
    }
    advanceTo(s, 4 * DAY + HOUR);
    const A = D(s).alliances[id]!;
    const vote = A.votes.find((v) => v.kind === 'replace_leader');
    expect(vote?.subject).toBe('ccc');
    ok(s, 'ccc', { kind: 'allianceVote', voteId: vote!.id, yes: true });
    advanceTo(s, 6 * DAY);
    expect(D(s).alliances[id]!.leader).toBe('ccc');
  });

  it('exclusion par vote', () => {
    const { s, id } = allied();
    ok(s, 'aaa', { kind: 'allianceProposeVote', vote: 'expel', subject: 'ccc' });
    // Le proposant vote oui ; ccc ne vote pas sur sa propre exclusion : clôture immédiate.
    expect(D(s).alliances[id]!.members).toEqual(['aaa']);
    expect(B(s).allianceOf.ccc).toBeUndefined();
  });
});
