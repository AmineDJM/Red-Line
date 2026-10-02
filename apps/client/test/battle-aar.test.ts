import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BattleReportSummary } from '@redline/shared';
import '../src/i18n/index.js';
import { AarHeader, BattleAarView, fmtEstimate } from '../src/components/BattleAar.js';
import { demoAar } from '../src/api/mockRest.js';

const summary: BattleReportSummary = {
  id: 'bt12',
  at: [2, 48],
  provinceId: 'esp-3',
  startedAt: 3 * 86_400_000,
  endedAt: 3 * 86_400_000 + 3 * 3_600_000,
  title: 'Bataille de Murcie',
  attacker: {
    nations: ['dza'],
    engaged: [{ systemId: 'ru.t-90m', count: 12 }],
    losses: [{ systemId: 'ru.t-90m', count: 2 }],
  },
  defender: {
    nations: ['esp'],
    engaged: [{ systemId: 'us.m1a2', count: 9 }],
    losses: [{ systemId: 'us.m1a2', count: 6 }],
  },
  outcome: 'attacker',
};

describe('rapport après action (fenêtre Batailles)', () => {
  const aar = demoAar(summary, new Map(), 'dza');
  const html = renderToStaticMarkup(
    createElement('div', null, [
      createElement(AarHeader, { key: 'h', aar, id: summary.id }),
      createElement(BattleAarView, { key: 'v', aar }),
    ]),
  );

  it('en-tête : référence, lieu, milieu et issue', () => {
    expect(html).toContain('RAPPORT APRÈS ACTION BT12');
    expect(html).toContain('terrestre');
    expect(html).toContain('Victoire décisive de l’attaquant');
  });

  it('camps : le sien exact, l’adversaire estimé avec sa cote de renseignement', () => {
    expect(html).toContain('chiffres exacts');
    expect(html).toContain('estimations du renseignement');
    expect(html).toContain('Renseignement B3');
    expect(html).toContain('Contact terrestre non identifié');
    // Fourchette des estimations adverses.
    expect(html).toMatch(/≈&nbsp;9|≈ 9/);
  });

  it('bilan, courbe des pertes, phases, facteurs et conséquences', () => {
    for (const s of [
      'Tués',
      'Blessés',
      'Disparus',
      'Prisonniers',
      'Missiles tirés',
      'Sorties aériennes',
      'Pertes cumulées',
      'Préparation des feux',
      'Contre-attaque',
      'Facteurs décisifs',
      'Supériorité aérienne',
      'Ravitaillement',
      'Prise de Murcie',
    ])
      expect(html).toContain(s);
    expect(html).toContain('<svg');
    expect(html).toContain('aar-line--red');
  });

  it('format des estimations', () => {
    expect(fmtEstimate({ best: 12, min: 12, max: 12 })).toBe('12');
    expect(fmtEstimate({ best: 9, min: 7, max: 11 })).toBe('≈ 9 (7–11)');
  });
});
