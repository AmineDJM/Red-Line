import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BalanceSchema,
  CatalogFileSchema,
  EFFECT_TARGETS,
  effectAgainst,
  effectLevel,
  effectTargetOf,
  effectivenessContext,
  interceptProfile,
  mixEffectiveness,
  systemEffectiveness,
  MilitaryBalanceSchema,
  type EffectTarget,
  type WeaponSystem,
} from '../src/index.js';

const DATA = resolve(import.meta.dirname, '../../../data');
const systems: WeaponSystem[] = readdirSync(join(DATA, 'catalog'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap(
    (f) =>
      CatalogFileSchema.parse(JSON.parse(readFileSync(join(DATA, 'catalog', f), 'utf8'))).systems,
  );
const balance = BalanceSchema.parse(
  JSON.parse(readFileSync(join(DATA, 'balance/default.json'), 'utf8')),
);
const ctx = effectivenessContext(systems, balance);
const sys = (id: string) => systems.find((s) => s.id === id)!;
const level = (id: string, t: EffectTarget) =>
  effectLevel(systemEffectiveness(sys(id), ctx)[t], ctx);
const NUL = 0;
const FAIBLE = 1;
const BON = 3;

describe('efficacité par catégorie de cible (valeurs réelles du moteur)', () => {
  it('notes bornées entre 0 et 1 pour tout le catalogue ; niveaux croissants', () => {
    for (const s of systems) {
      const sc = systemEffectiveness(s, ctx);
      for (const t of EFFECT_TARGETS) {
        expect(sc[t], `${s.id} ${t}`).toBeGreaterThanOrEqual(0);
        expect(sc[t], `${s.id} ${t}`).toBeLessThanOrEqual(1);
      }
    }
    expect([0, 0.01, 0.3, 0.6, 0.9].map((x) => effectLevel(x, ctx))).toEqual([0, 1, 2, 3, 4]);
  });

  it('S-400 : excellent contre les avions, bon au moins contre les missiles, nul au sol', () => {
    expect(level('ru.s-400', 'aircraft')).toBe(4);
    expect(level('ru.s-400', 'missile')).toBeGreaterThanOrEqual(BON);
    for (const t of ['armor', 'infantry', 'artillery', 'ship', 'submarine', 'building'] as const)
      expect(level('ru.s-400', t), t).toBe(NUL);
  });

  it('Su-34 : bon contre les blindés et les navires, faible contre les missiles, nul sous l’eau', () => {
    expect(level('ru.su-34', 'armor')).toBeGreaterThanOrEqual(BON);
    expect(level('ru.su-34', 'ship')).toBeGreaterThanOrEqual(BON);
    expect(level('ru.su-34', 'missile')).toBeLessThanOrEqual(FAIBLE);
    expect(level('ru.su-34', 'submarine')).toBe(NUL);
  });

  it('Su-30 : meilleur que le Su-34 contre les avions', () => {
    const a = systemEffectiveness(sys('ru.su-30'), ctx).aircraft;
    const b = systemEffectiveness(sys('ru.su-34'), ctx).aircraft;
    expect(a).toBeGreaterThan(b);
    expect(level('ru.su-30', 'aircraft')).toBeGreaterThanOrEqual(BON);
  });

  it('Leopard 2 : bon contre les blindés, nul contre les avions et les missiles', () => {
    expect(level('eu.leopard-2a7', 'armor')).toBeGreaterThanOrEqual(BON);
    expect(level('eu.leopard-2a7', 'aircraft')).toBe(NUL);
    expect(level('eu.leopard-2a7', 'missile')).toBe(NUL);
  });

  it('M777 : bon contre l’infanterie, nul contre ce qui vole', () => {
    expect(level('us.m777', 'infantry')).toBeGreaterThanOrEqual(BON);
    for (const t of ['aircraft', 'helicopter', 'drone', 'missile'] as const)
      expect(level('us.m777', t), t).toBe(NUL);
  });

  it('FREMM : bonne contre les sous-marins, les navires et les missiles', () => {
    for (const t of ['submarine', 'ship', 'missile'] as const)
      expect(level('eu.fremm', t), t).toBeGreaterThanOrEqual(BON);
  });

  it('défense à enveloppes : les avions sont notés sur l’interception, jamais sur les rounds', () => {
    const p = interceptProfile(sys('ru.s-400'), MilitaryBalanceSchema.parse(balance.military))!;
    expect(p.explicit).toBe(true);
    // Brouilleur sans fiche d'interception : ses dégâts « drone » restent des tirs en rounds.
    expect(systemEffectiveness(sys('ru.krasukha-4'), ctx).drone).toBeGreaterThan(0);
    expect(systemEffectiveness(sys('ru.krasukha-4'), ctx).aircraft).toBe(0);
  });

  it('pile mixte : moyenne pondérée par le nombre d’éléments', () => {
    const tank = sys('eu.leopard-2a7');
    const inf = sys('eu.infantry-light');
    const mix = mixEffectiveness(
      [
        { system: tank, count: 3 },
        { system: inf, count: 1 },
      ],
      ctx,
    );
    const a = systemEffectiveness(tank, ctx);
    const b = systemEffectiveness(inf, ctx);
    for (const t of EFFECT_TARGETS) expect(mix[t]).toBeCloseTo((3 * a[t] + b[t]) / 4, 10);
  });

  it('cible précise : un char est plus efficace contre l’artillerie que contre un autre char', () => {
    const p = [{ system: sys('eu.leopard-2a7'), count: 1 }];
    const vsArt = effectAgainst(p, sys('us.m777'), ctx)!;
    const vsTank = effectAgainst(p, sys('ru.t-90m'), ctx)!;
    expect(vsArt.target).toBe('artillery');
    expect(vsTank.target).toBe('armor');
    expect(vsArt.score).toBeGreaterThan(vsTank.score);
    const salvo = effectAgainst([{ system: sys('ru.s-400'), count: 1 }], sys('us.tomahawk'), ctx, {
      inFlight: true,
    })!;
    expect(salvo.target).toBe('missile');
    expect(salvo.score).toBeGreaterThan(0);
  });

  it('catégorie d’une cible : munitions au sol et aéronefs posés comptent comme bâtiments', () => {
    expect(effectTargetOf(sys('us.tomahawk'))).toBe('building');
    expect(effectTargetOf(sys('us.tomahawk'), { inFlight: true })).toBe('missile');
    expect(effectTargetOf(sys('other.shahed-136'), { inFlight: true })).toBe('drone');
    expect(effectTargetOf(sys('eu.rafale'), { landed: true })).toBe('building');
    expect(effectTargetOf(sys('eu.rafale'))).toBe('aircraft');
    expect(effectTargetOf(sys('us.virginia'))).toBe('submarine');
  });

  it('sans équilibrage : valeurs par défaut des schémas', () => {
    const c = effectivenessContext(systems, null);
    expect(systemEffectiveness(sys('ru.s-400'), c).aircraft).toBeGreaterThan(0);
  });
});
