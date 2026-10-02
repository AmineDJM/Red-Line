import { describe, expect, it } from 'vitest';
import { INTEL_OPS } from '@redline/shared';
import fr from '../src/i18n/fr.json';
import {
  INTEL_TABS,
  TAB_DEPT,
  TAB_OPS,
  TARGET_KIND,
  tabOfReport,
  threatTone,
} from '../src/lib/intelTabs.js';

/** Console de renseignement : chaque opération a sa place, sa cible et ses textes. */
describe('fenêtre de renseignement : onglets et opérations', () => {
  const ops = Object.values(TAB_OPS).flat();

  it('sept onglets, chaque opération dans exactement un onglet d’action', () => {
    expect(INTEL_TABS).toEqual([
      'sigint',
      'humint',
      'military',
      'interior',
      'detainees',
      'dossiers',
      'reports',
    ]);
    for (const op of INTEL_OPS)
      expect(
        ops.filter((o) => o === op),
        op,
      ).toHaveLength(1);
    expect(ops).toHaveLength(INTEL_OPS.length);
  });

  it('chaque opération a une nature de cible, un libellé et une aide', () => {
    const t = fr.intel as unknown as {
      ops: Record<string, string>;
      opsHelp: Record<string, string>;
    };
    for (const op of INTEL_OPS) {
      expect(TARGET_KIND[op], op).toBeDefined();
      expect(t.ops[op], op).toBeTruthy();
      expect(t.opsHelp[op], op).toBeTruthy();
    }
  });

  it('départements des onglets (DGSE extérieur, DRM militaire, DGSI intérieur)', () => {
    expect(TAB_DEPT).toEqual({
      sigint: 'military',
      humint: 'exterior',
      military: 'military',
      interior: 'interior',
    });
    // L'action par défaut de l'onglet militaire reste la reconnaissance (parcours e2e).
    expect(TAB_OPS.military[0]).toBe('recon_military');
  });

  it('classement des rapports et couleur de la menace', () => {
    expect(tabOfReport({ dept: 'interior', source: 'humint', kind: 'counterintel' })).toBe(
      'interior',
    );
    expect(tabOfReport({ dept: 'exterior', source: 'humint', kind: 'result' })).toBe('humint');
    expect(tabOfReport({ dept: 'military', source: 'sigint', kind: 'daily' })).toBe('military');
    expect(tabOfReport({ dept: 'military', source: 'sigint', kind: 'intentions' })).toBe('sigint');
    expect(threatTone(80)).toBe('red');
    expect(threatTone(40)).toBe('amber');
    expect(threatTone(20)).toBe('cyan');
    expect(threatTone(0)).toBe('green');
  });
});
