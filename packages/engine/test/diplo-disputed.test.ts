import { describe, expect, it } from 'vitest';
import { DAY } from '@redline/shared';
import { advanceTo, applyOrder, publicView, viewFor } from '../src/index.js';
import { transferProvince } from '../src/combat/capture.js';
import { atWar } from '../src/state/access.js';
import { uprising } from '../src/modules/diplo/unrest.js';
import { signal } from '../src/modules/registry.js';
import { cityOf, unitsOf } from './fixtures.js';
import { B, CHARTER, D, diploWorld, game, mapWithDisputed, ok } from './diplo-helpers.js';

/** Zone disputée « bbb-4 » revendiquée par aaa et bbb, tenue au départ par bbb ; révolte certaine chaque jour. */
function disputedGame(over: Record<string, unknown> = {}) {
  const map = mapWithDisputed({
    provinceIds: ['bbb-4'],
    claimants: ['aaa', 'bbb'],
    tension: 90,
    revoltRate: 1,
  });
  const world = diploWorld(
    {
      stability: {
        start: 70,
        coupThreshold: 15,
        revoltThreshold: 30,
        armedUprisingChance: 1,
        ...over,
      },
    },
    map,
  );
  return game({ world });
}

describe('diplomatie : territoires disputés et rebelles', () => {
  it('vue : zone disputée, détenteur, tension, agitation de la province', () => {
    const s = disputedGame();
    const v = viewFor(s, 'ccc');
    expect(v.diplomacy!.disputed).toEqual([
      {
        id: 'zone',
        name: 'Zone disputée',
        provinceIds: ['bbb-4'],
        holder: 'bbb',
        claimants: ['aaa', 'bbb'],
        tension: 90,
      },
    ]);
    expect(v.provinces['bbb-4']!.disputedId).toBe('zone');
    expect(v.provinces['bbb-4']!.unrest).toBe(45);
    expect(v.provinces['bbb-5']!.disputedId).toBeUndefined();
  });

  it('soulèvement armé contre le détenteur, puis contre le nouveau détenteur (règle symétrique)', () => {
    const s = disputedGame();
    advanceTo(s, DAY);
    const reb = unitsOf(s, 'reb-bbb');
    expect(reb.length).toBeGreaterThanOrEqual(2);
    expect(atWar(s, 'reb-bbb', 'bbb')).toBe(true);
    expect(atWar(s, 'reb-bbb', 'aaa')).toBe(false);
    const pv = publicView(s);
    expect(pv.nations['reb-bbb']!.name).toBe('Rebelles (Nation BBB)');
    expect(
      Object.values(pv.units)
        .filter((u) => u.owner === 'reb-bbb')
        .every((u) => u.affiliation === 'rebel'),
    ).toBe(true);
    expect(pv.news!.some((n) => n.category === 'revolt')).toBe(true);
    // Les rebelles marchent sur la ville.
    expect(reb.every((u) => u.move !== null)).toBe(true);

    // Le territoire change de mains : la même règle vise désormais le nouveau détenteur.
    transferProvince(s, 'bbb-4', 'aaa');
    expect(D(s).disputed.zone!.holder).toBe('aaa');
    advanceTo(s, 2 * DAY);
    expect(unitsOf(s, 'reb-aaa').length).toBeGreaterThanOrEqual(2);
    expect(atWar(s, 'reb-aaa', 'aaa')).toBe(true);
    expect(atWar(s, 'reb-aaa', 'bbb')).toBe(false);
  });

  it('financer des rebelles coûte moins cher au prétendant ; province prise par les rebelles → ralliée au prétendant', () => {
    const map = mapWithDisputed({
      provinceIds: ['bbb-4'],
      claimants: ['aaa', 'bbb'],
      tension: 10,
      revoltRate: 0,
    });
    const world = diploWorld({}, map);
    const s = game({ world });
    ok(s, 'aaa', { kind: 'fundRebels', provinceId: 'bbb-4', amount: 50 });
    const byClaimant = D(s).unrest['bbb-4']!;
    const t = game({ world });
    ok(t, 'ccc', { kind: 'fundRebels', provinceId: 'bbb-4', amount: 50 });
    expect(byClaimant).toBeCloseTo(D(t).unrest['bbb-4']! * 2);
    expect(s.nations.aaa!.money).toBe(2000 - 50);
    // Pas de financement contre un allié ni sur ses propres terres.
    expect(applyOrder(s, 'bbb', { kind: 'fundRebels', provinceId: 'bbb-4', amount: 10 }).ok).toBe(
      false,
    );
    ok(s, 'aaa', { kind: 'createAlliance', name: 'Axe', flag: 'A', charter: CHARTER });
    ok(s, 'aaa', { kind: 'inviteToAlliance', nationId: 'ccc' });
    ok(s, 'ccc', { kind: 'answerInvite', allianceId: B(s).allianceOf.aaa!, accept: true });
    expect(applyOrder(s, 'aaa', { kind: 'fundRebels', provinceId: 'ccc-1', amount: 10 }).ok).toBe(
      false,
    );

    // Les rebelles (sans défenseur) prennent la ville : la province se rallie au prétendant qui les finançait.
    const u = game({
      world,
      units: [{ owner: 'bbb', systemId: 'tst.infantry', pos: cityOf('bbb-2') }],
    });
    ok(u, 'aaa', { kind: 'fundRebels', provinceId: 'bbb-4', amount: 100 });
    uprising(u, 'bbb-4', 2);
    advanceTo(u, 3 * DAY);
    expect(u.provinces['bbb-4']!.owner).toBe('aaa');
    expect(viewFor(u, 'aaa').news!.some((n) => n.category === 'revolt')).toBe(true);
  });

  it('signal rebels_funded (opération de renseignement) : même effet que l’ordre', () => {
    const map = mapWithDisputed({
      provinceIds: ['bbb-4'],
      claimants: ['aaa', 'bbb'],
      tension: 10,
      revoltRate: 0,
    });
    const s = game({ world: diploWorld({}, map) });
    signal(s, 'rebels_funded', { by: 'ccc', pid: 'bbb-5', amount: 100 });
    expect(D(s).unrest['bbb-5']).toBeGreaterThan(0);
    expect(viewFor(s, 'bbb').provinces['bbb-5']!.unrest).toBeGreaterThan(0);
  });

  it('mercenaires : unités d’affiliation « mercenary », payées, fin de contrat', () => {
    const s = game();
    const before = s.nations.aaa!.money;
    ok(s, 'aaa', { kind: 'hireMercenaries', provinceId: 'aaa-2', count: 2 });
    const m = unitsOf(s, 'aaa');
    expect(m).toHaveLength(1);
    expect(m[0]!.count).toBe(2);
    expect(s.nations.aaa!.money).toBeLessThan(before);
    expect(viewFor(s, 'aaa').units[m[0]!.id]!.affiliation).toBe('mercenary');
    expect(
      applyOrder(s, 'aaa', { kind: 'hireMercenaries', provinceId: 'bbb-2', count: 1 }).ok,
    ).toBe(false);
    advanceTo(s, 31 * DAY);
    expect(unitsOf(s, 'aaa')).toHaveLength(0);
  });

  it('courtiser un neutre : inclinaison visible, puis adhésion de l’IA neutre', () => {
    const s = game({
      players: [
        { nationId: 'aaa', isAi: false },
        { nationId: 'bbb', isAi: false },
      ],
    });
    expect(applyOrder(s, 'aaa', { kind: 'courtNeutral', nationId: 'ccc', aid: 100 }).ok).toBe(
      false,
    ); // pas d'alliance
    ok(s, 'aaa', { kind: 'createAlliance', name: 'Entente', flag: 'E', charter: CHARTER });
    const id = B(s).allianceOf.aaa!;
    ok(s, 'aaa', { kind: 'courtNeutral', nationId: 'ccc', aid: 400 });
    expect(s.nations.ccc!.money).toBe(2400);
    const lean = viewFor(s, 'bbb').diplomacy!.neutrals.find((x) => x.nationId === 'ccc')!.leaning[
      id
    ]!;
    expect(lean).toBeGreaterThan(0.5);
    ok(s, 'aaa', { kind: 'courtNeutral', nationId: 'ccc', aid: 900 });
    advanceTo(s, DAY);
    expect(B(s).allianceOf.ccc).toBe(id);
  });
});
