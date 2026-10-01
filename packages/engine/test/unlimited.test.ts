import { describe, expect, it } from 'vitest';
import { DAY, HOUR, RESOURCES, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  applySystem,
  deserializeState,
  serializeState,
  stateHash,
  unlimitedNations,
  viewFor,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { ecoGame, ecoWorld } from './eco-fixtures.js';
import { unitsOf } from './fixtures.js';

const CAP = 1e15;
const RES_CAP = 1e12;

/** Nation ruinée : ni argent ni ressources. */
function ruin(s: EngineState, n: string): void {
  s.nations[n]!.money = 0;
  for (const r of RESOURCES) s.nations[n]!.res[r] = 0;
}

const F16: Order = { kind: 'produce', provinceId: 'aaa-2', systemId: 'us.f-16', count: 40 };
const SU57: Order = { kind: 'produce', provinceId: 'aaa-2', systemId: 'ru.su-57', count: 5 };

describe('mode illimité (commande système « unlimited »)', () => {
  it('aucune dépense refusée faute de fonds ; réserve gelée au plafond', () => {
    const s = ecoGame();
    ruin(s, 'aaa');
    expect(applyOrder(s, 'aaa', F16)).toMatchObject({ ok: false, error: 'insufficient_funds' });
    expect(applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: true }).ok).toBe(true);
    expect(unlimitedNations(s)).toEqual(['aaa']);
    expect(s.nations.aaa!.money).toBe(CAP);
    for (const r of RESOURCES) expect(s.nations.aaa!.res[r]).toBe(RES_CAP);

    const accepted: Order[] = [
      F16,
      { kind: 'research', nodeId: 'research.aero.gen5' },
      { kind: 'research', nodeId: 'research.industry.l1' },
      { kind: 'build', provinceId: 'aaa-3', building: 'mine' },
      { kind: 'buyLicence', systemId: 'us.f-16' },
      { kind: 'mobilize', on: true },
    ];
    for (const o of accepted) {
      expect(applyOrder(s, 'aaa', o), o.kind).toMatchObject({ ok: true });
      expect(s.nations.aaa!.money).toBe(CAP);
    }
    // Les dépenses restent comptées (statistiques, grand livre du jour).
    const en = (s.mods.eco as { nations: Record<string, { spent: number }> }).nations.aaa!;
    expect(en.spent).toBeGreaterThan(40 * 30e6);

    // La R&D reste nécessaire pour produire (pas de déblocage automatique).
    expect(applyOrder(s, 'aaa', SU57)).toMatchObject({ ok: false, error: 'research_required' });

    // Plusieurs jours : entretien, budgets, mobilisation… la réserve reste au plafond, sans pénurie
    // ni poste « autres » fantôme dû à la remise à niveau.
    advanceTo(s, 3 * DAY);
    expect(s.nations.aaa!.money).toBe(CAP);
    const v = viewFor(s, 'aaa');
    expect(v.economy.unlimited).toBe(true);
    expect(v.economy.money).toBe(CAP);
    expect(v.economy.detail?.resources?.oil?.shortage ?? false).toBe(false);
    const eco = s.mods.eco as { nations: Record<string, { lastDay: Record<string, number> }> };
    expect(eco.nations.aaa!.lastDay.other).toBeUndefined();
    // Les autres joueurs voient la nation illimitée (avis public, partie non classée).
    expect(viewFor(s, 'bbb').nations.aaa!.unlimited).toBe(true);
    expect(viewFor(s, 'bbb').nations.bbb!.unlimited).toBeUndefined();
    expect(viewFor(s, 'bbb').economy.unlimited).toBeUndefined();
    // Les F-16 commandés sont livrés.
    advanceTo(s, 10 * DAY);
    expect(unitsOf(s, 'aaa', 'us.f-16').reduce((a, u) => a + u.count, 0)).toBeGreaterThanOrEqual(
      40,
    );
  });

  it('désactivation : la réserve d’avant l’activation est rendue (dotations comprises)', () => {
    const s = ecoGame();
    ruin(s, 'aaa');
    s.nations.aaa!.money = 5e6;
    applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: true });
    // Activer deux fois ne change pas la réserve sauvegardée.
    applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: true });
    expect(applyOrder(s, 'aaa', F16).ok).toBe(true);
    applySystem(s, { kind: 'grant', nationId: 'aaa', money: 1e6 });
    expect(s.nations.aaa!.money).toBe(CAP);
    expect(applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: false }).ok).toBe(true);
    expect(unlimitedNations(s)).toEqual([]);
    expect(s.unl).toBeUndefined();
    expect(s.nations.aaa!.money).toBe(6e6);
    expect(s.nations.aaa!.res.oil).toBe(0);
    expect(viewFor(s, 'aaa').economy.unlimited).toBeUndefined();
    expect(applyOrder(s, 'aaa', F16)).toMatchObject({ ok: false, error: 'insufficient_funds' });
    // Désactiver une nation qui ne l'est pas : sans effet.
    expect(applySystem(s, { kind: 'unlimited', nationId: 'bbb', on: false }).ok).toBe(true);
    expect(applySystem(s, { kind: 'unlimited', nationId: 'zzz', on: true }).ok).toBe(false);
  });

  it('rejeu identique : découpage des appels, sérialisation en cours de route', () => {
    type Step = { t: number; run: (s: EngineState) => void };
    const SCRIPT: Step[] = [
      {
        t: 1 * HOUR,
        run: (s) => void applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: true }),
      },
      { t: 2 * HOUR, run: (s) => void applyOrder(s, 'aaa', F16) },
      {
        t: 3 * HOUR,
        run: (s) => void applyOrder(s, 'aaa', { kind: 'research', nodeId: 'research.aero.gen5' }),
      },
      {
        t: 5 * HOUR,
        run: (s) =>
          void applyOrder(s, 'aaa', { kind: 'build', provinceId: 'aaa-3', building: 'mine' }),
      },
      { t: 30 * HOUR, run: (s) => void applyOrder(s, 'aaa', { kind: 'mobilize', on: true }) },
      {
        t: 60 * HOUR,
        run: (s) => void applySystem(s, { kind: 'unlimited', nationId: 'aaa', on: false }),
      },
      { t: 61 * HOUR, run: (s) => void applyOrder(s, 'aaa', F16) },
    ];
    const play = (s: EngineState, until: number, from = -1, chunk = 0) => {
      for (const step of SCRIPT) {
        if (step.t <= from || step.t > until) continue;
        if (chunk > 0) for (let t = Math.max(0, from); t < step.t; t += chunk) advanceTo(s, t);
        advanceTo(s, step.t);
        step.run(s);
      }
      advanceTo(s, until);
    };
    const a = ecoGame({ seed: 5 });
    const b = ecoGame({ seed: 5 });
    play(a, 4 * DAY);
    play(b, 4 * DAY, -1, 37 * 60_000); // pas de 37 min : la remise à niveau ne dépend pas du découpage
    expect(stateHash(a)).toBe(stateHash(b));
    expect(viewFor(a, 'aaa')).toEqual(viewFor(b, 'aaa'));

    const c = ecoGame({ seed: 5 });
    const mid = 10 * HOUR;
    play(c, mid);
    expect(c.unl?.aaa).toBeDefined();
    const r = deserializeState(ecoWorld(), serializeState(c)) as EngineState;
    expect(stateHash(r)).toBe(stateHash(c));
    expect(unlimitedNations(r)).toEqual(['aaa']);
    play(r, 4 * DAY, mid);
    expect(stateHash(r)).toBe(stateHash(a));
    expect(r.unl).toBeUndefined();
  });
});
