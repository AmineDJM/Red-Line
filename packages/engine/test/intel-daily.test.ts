import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '@redline/shared';
import { advanceTo, applyOrder, notificationsFor, viewFor } from '../src/index.js';
import { signal } from '../src/modules/registry.js';
import { ist } from '../src/modules/intel/state.js';
import { cityOf } from './fixtures.js';
import { intelGame } from './intel-helpers.js';

const COTATION = /Cotation [A-F][1-6]/;

describe('renseignement : notes quotidiennes', () => {
  it('trois notes (intérieur, extérieur, militaire) à dailyReportHour, cotées', () => {
    const s = intelGame([{ owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }]);
    advanceTo(s, 7 * HOUR - 1);
    expect(viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'daily')).toHaveLength(0);
    const notes = advanceTo(s, 7 * HOUR);
    const v = viewFor(s, 'aaa');
    const daily = v.intel!.reports.filter((r) => r.kind === 'daily');
    expect(daily.map((r) => r.dept).sort()).toEqual(['exterior', 'interior', 'military']);
    for (const r of daily) {
      expect(r.body.split('\n')[0]).toMatch(COTATION);
      expect(r.body.split('\n').length).toBeGreaterThan(1);
      expect('ABCDEF').toContain(r.reliability);
      expect(r.credibility).toBeGreaterThanOrEqual(1);
      expect(r.credibility).toBeLessThanOrEqual(6);
      expect(r.time).toBe(7 * HOUR);
    }
    // Notifications : uniquement pour le destinataire.
    const mine = notificationsFor(s, 'aaa', notes).filter((n) => n.kind === 'intel_report');
    expect(mine).toHaveLength(3);
    const theirs = notificationsFor(s, 'bbb', notes).filter((n) => n.kind === 'intel_report');
    expect(theirs.every((n) => n.kind === 'intel_report' && !mine.some((m) => m === n))).toBe(true);
    // Les IA ne reçoivent pas de notes (elles ne les lisent pas).
    expect(ist(s).nations.ccc!.reports.filter((r) => r.kind === 'daily')).toHaveLength(0);
    // Le lendemain, trois nouvelles notes.
    advanceTo(s, DAY + 7 * HOUR);
    expect(viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'daily')).toHaveLength(6);
  });

  it('la note intérieure résume les incidents reçus par signaux, puis repart de zéro', () => {
    const s = intelGame();
    signal(s, 'sabotage', {
      by: 'bbb',
      victim: 'aaa',
      pid: 'aaa-1',
      building: 'refinery',
      damage: 0.4,
    });
    signal(s, 'cyber', { by: 'bbb', victim: 'aaa', kind: 'radar', hours: 12 });
    advanceTo(s, 7 * HOUR);
    const note = viewFor(s, 'aaa').intel!.reports.find(
      (r) => r.kind === 'daily' && r.dept === 'interior',
    )!;
    expect(note.body).toContain('1 sabotage');
    expect(note.body).toContain('1 cyberattaque');
    advanceTo(s, DAY + 7 * HOUR);
    const next = viewFor(s, 'aaa').intel!.reports.find(
      (r) => r.kind === 'daily' && r.dept === 'interior',
    )!;
    expect(next.body).not.toContain('sabotage');
  });

  it('les opérations en cours et les contacts connus figurent dans les notes', () => {
    const s = intelGame([{ owner: 'aaa', systemId: 'tst.infantry', pos: cityOf('aaa-2') }]);
    advanceTo(s, 6 * HOUR);
    expect(
      applyOrder(s, 'aaa', { kind: 'intelOp', op: 'infiltrate_spy', target: { nationId: 'bbb' } })
        .ok,
    ).toBe(true);
    advanceTo(s, 7 * HOUR);
    const ext = viewFor(s, 'aaa').intel!.reports.find(
      (r) => r.kind === 'daily' && r.dept === 'exterior',
    )!;
    expect(ext.body).toContain('Opérations en cours : 1');
    const mil = viewFor(s, 'aaa').intel!.reports.find(
      (r) => r.kind === 'daily' && r.dept === 'military',
    )!;
    expect(mil.body).toContain('Contacts suivis : 0');
  });
});

describe('renseignement : rapports flash', () => {
  it('mouvement de forces nombreuses près de la frontière : un flash, pas plus d’un par délai', () => {
    const tanks = Array.from({ length: 7 }, (_, i) => ({
      owner: 'bbb',
      systemId: 'tst.tank',
      pos: [5.5 + i * 0.04, 40] as [number, number],
    }));
    const s = intelGame([{ owner: 'aaa', systemId: 'tst.radar', pos: [4.9, 40] }, ...tanks]);
    const ids = Object.keys(s.units).filter((id) => s.units[id]!.owner === 'bbb');
    expect(applyOrder(s, 'bbb', { kind: 'move', unitIds: ids, to: [5.6, 41.5] }).ok).toBe(true);
    advanceTo(s, HOUR);
    const flashes = viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'flash');
    expect(flashes).toHaveLength(1);
    const f = flashes[0]!;
    expect(f.title).toContain('Mouvement de forces');
    expect(f.body).toMatch(COTATION);
    expect(f.at).not.toBeNull();
    expect(f.subject?.nationId).toBe('bbb');
    // Identifiants cités : seulement des unités effectivement connues.
    const v = viewFor(s, 'aaa');
    for (const id of f.subject?.unitIds ?? []) expect(v.units[id]).toBeDefined();
    advanceTo(s, 2 * HOUR);
    expect(viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'flash')).toHaveLength(1);
  });

  it('frappe reçue (signal strike) : flash chez la victime, une fois par heure et par tireur', () => {
    const s = intelGame();
    advanceTo(s, HOUR);
    const hit = { by: 'bbb', victim: 'aaa', at: cityOf('aaa-2'), kind: 'missile', nuclear: false };
    signal(s, 'strike', hit);
    signal(s, 'strike', hit);
    const flashes = viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'flash');
    expect(flashes).toHaveLength(1);
    expect(flashes[0]!.body).toContain('Frappe de missiles subie');
    expect(ist(s).nations.aaa!.log.strikes).toBe(2);
    expect(viewFor(s, 'bbb').intel!.reports.filter((r) => r.kind === 'flash')).toHaveLength(0);
    advanceTo(s, 2 * HOUR + 1);
    signal(s, 'strike', hit);
    expect(viewFor(s, 'aaa').intel!.reports.filter((r) => r.kind === 'flash')).toHaveLength(2);
  });

  it('détonation nucléaire : détectée par tous les joueurs', () => {
    const s = intelGame();
    signal(s, 'nuclear_detonation', {
      by: 'ccc',
      victim: 'aaa',
      at: cityOf('aaa-2'),
      pid: 'aaa-2',
    });
    for (const n of ['aaa', 'bbb']) {
      const r = viewFor(s, n).intel!.reports.find((x) => x.title.includes('nucléaire'));
      expect(r?.kind).toBe('flash');
      expect(r!.body).toContain('Province aaa-2');
    }
  });

  it('signaux mal formés ou inconnus ignorés', () => {
    const s = intelGame();
    signal(s, 'strike', { victim: 42 });
    signal(s, 'imagery', { nation: 'zzz' });
    signal(s, 'rien', {});
    expect(ist(s).nations.aaa!.reports).toHaveLength(0);
  });
});
