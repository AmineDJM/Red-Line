import { describe, expect, it } from 'vitest';
import {
  DETAINEE_ACTIONS,
  DETAINEE_KINDS,
  DETAINEE_STATUSES,
  type AgentView,
  type IntelView,
} from '@redline/shared';
import fr from '../src/i18n/fr.json';
import frEngine from '../src/i18n/fr.engine.json';
import {
  agentValueOf,
  agentsAbroad,
  detaineeAlerts,
  effectLines,
  groupOptions,
  riskGrade,
  stillHeld,
} from '../src/lib/detainees.js';

/** Onglet « Détenus » : conséquences affichées avant confirmation, listes, textes. */
describe('détenus : logique de la console', () => {
  it('conséquences : lignes ordonnées, tons, risque gradué', () => {
    const lines = effectLines({
      relations: -40,
      reputation: -18,
      stability: -6,
      retaliation: 0.8,
      serviceHit: 0.35,
      serviceDays: 90,
      worldRelations: -10,
      council: 0.6,
    });
    expect(lines.map((l) => l.key)).toEqual([
      'relations',
      'reputation',
      'stability',
      'worldRelations',
      'retaliation',
      'serviceHit',
      'council',
    ]);
    expect(lines.find((l) => l.key === 'relations')!.tone).toBe('red');
    expect(lines.find((l) => l.key === 'retaliation')!.tone).toBe('red');
    expect(lines.find((l) => l.key === 'serviceHit')!.days).toBe(90);
    expect(riskGrade(0)).toBe('none');
    expect(riskGrade(0.1)).toBe('low');
    expect(riskGrade(0.4)).toBe('moderate');
    expect(riskGrade(0.7)).toBe('high');
    // Libération : relations en hausse (vert), rien de superflu.
    const rel = effectLines({
      relations: 6,
      reputation: 1,
      stability: -1,
      retaliation: 0,
      serviceHit: 0,
    });
    expect(rel.map((l) => [l.key, l.tone])).toEqual([
      ['relations', 'green'],
      ['reputation', 'green'],
      ['stability', 'red'],
    ]);
  });

  it('options regroupées : une action, plusieurs durées de peine', () => {
    const fx = { relations: -1, reputation: 0, stability: 0, retaliation: 0, serviceHit: 0 };
    const g = groupOptions([
      { action: 'interrogate', allowed: true, effects: fx },
      { action: 'jail', days: 30, allowed: true, effects: fx },
      { action: 'jail', days: 90, allowed: true, effects: fx },
      { action: 'execute', allowed: false, reason: 'war_only', effects: fx },
    ]);
    expect(g.map((x) => [x.action, x.options.length])).toEqual([
      ['interrogate', 1],
      ['jail', 2],
      ['execute', 1],
    ]);
  });

  it('nos agents détenus : en cours d’abord, négociables tant qu’ils sont détenus', () => {
    const a = (id: string, fate: NonNullable<AgentView['detention']>['fate'], since: number) =>
      ({
        id,
        codename: id,
        nationId: 'rus',
        status: 'captured',
        since: 0,
        detention: { fate, since },
      }) as AgentView;
    const intel = {
      agents: [
        a('x', 'executed', 50),
        a('y', 'jailed', 10),
        a('z', 'held', 20),
        { id: 'w', codename: 'w', nationId: 'rus', status: 'active', since: 0 } as AgentView,
      ],
      detainees: [
        {
          id: 'd',
          ref: 'D-1',
          nationId: 'rus',
          kind: 'source',
          status: 'pending',
          arrestedAt: 0,
          value: 1.5,
        },
      ],
      swaps: [
        {
          id: 's',
          from: 'rus',
          to: 'fra',
          at: 0,
          expiresAt: 1,
          give: [],
          get: [],
          money: 0,
          accordDays: 0,
          status: 'open',
        },
      ],
    } as unknown as IntelView;
    expect(agentsAbroad(intel).map((x) => x.id)).toEqual(['z', 'y', 'x']);
    expect(
      agentsAbroad(intel)
        .filter(stillHeld)
        .map((x) => x.id),
    ).toEqual(['z', 'y']);
    expect(detaineeAlerts(intel, 'fra')).toBe(2);
    expect(detaineeAlerts(intel, 'rus')).toBe(1);
  });

  it('valeur d’échange : officier > source, accès compris', () => {
    expect(
      agentValueOf({ kind: 'officer', cover: 'nonofficial', access: 'street' }, undefined),
    ).toBe(4);
    expect(agentValueOf({ kind: 'source', access: 'staff' }, undefined)).toBe(3);
    expect(agentValueOf({ kind: 'officer', access: 'street' }, { diplomat: 2 })).toBe(2);
  });

  it('textes : chaque type, situation, décision et notification a son libellé', () => {
    const dz = fr.intel.dz as unknown as Record<string, Record<string, string>>;
    for (const k of DETAINEE_KINDS) {
      expect(dz.kinds![k]).toBeTruthy();
      expect(dz.kindsShort![k]).toBeTruthy();
    }
    for (const s of DETAINEE_STATUSES) expect(dz.status![s]).toBeTruthy();
    for (const a of DETAINEE_ACTIONS) {
      expect(dz.actions![a]).toBeTruthy();
      expect(dz.help![a]).toBeTruthy();
    }
    for (const b of ['war_only', 'never', 'interrogating', 'done', 'not_plausible', 'final'])
      expect(dz.blocked![b]).toBeTruthy();
    const note = frEngine.engine.note as unknown as Record<string, { title: string; text: string }>;
    for (const id of [
      'detaineeNew',
      'detaineeHeld',
      'spyInterrogated',
      'spyReturned',
      'spyJailed',
      'spyExecuted',
      'spyReleased',
      'spyServed',
      'swapProposal',
      'swapCounter',
      'swapAccepted',
      'swapRefused',
      'reprisalExecute',
      'reprisalJail',
      'reprisalArrest',
      'reprisalExpel',
    ])
      expect(note[id]?.title && note[id]?.text).toBeTruthy();
  });
});
