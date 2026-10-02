import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogFileSchema, type UnitView, type WeaponSystem } from '@redline/shared';
import '../src/i18n/index.js';
import { EffectRow, EffectTable } from '../src/components/Effectiveness.js';
import { effectContextFor, selectionEffectAgainst, unitEffect } from '../src/lib/effectiveness.js';
import { canCaptureUnit } from '../src/lib/unitActions.js';

const dir = join(__dirname, '../../../data/catalog');
const catalog: Record<string, WeaponSystem> = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap(
      (f) =>
        CatalogFileSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown).systems,
    )
    .map((s) => [s.id, s]),
);
const ctx = effectContextFor(catalog, null);
const unit = (over: Partial<UnitView>): UnitView =>
  ({
    id: 'u1',
    owner: 'rus',
    level: 'own',
    pos: [37, 55],
    lastSeen: 0,
    uncertaintyKm: 0,
    ...over,
  }) as UnitView;

describe('efficacité par catégorie : panneau, fiche, barre d’ordre', () => {
  it('Su-34 : pastilles avec info-bulle « bon contre les blindés », sous-marins masqués', () => {
    const scores = unitEffect(unit({ systemId: 'ru.su-34', count: 12 }), catalog, ctx)!;
    const html = renderToStaticMarkup(
      createElement(EffectRow, { scores, ctx, name: 'Su-34', system: catalog['ru.su-34'] }),
    );
    expect(html).toContain('data-testid="effect-row"');
    expect(html).toMatch(/Su-34 : (bon|excellent) contre les blindés/);
    expect(html).not.toContain('data-target="submarine"');
    expect(html).toContain('Nul contre : ');
  });

  it('Pantsir : portées d’interception dans les info-bulles (drones, missiles)', () => {
    const s = catalog['ru.pantsir-s1']!;
    const scores = unitEffect(unit({ systemId: s.id, count: 4 }), catalog, ctx)!;
    const html = renderToStaticMarkup(
      createElement(EffectRow, { scores, ctx, name: s.name, system: s }),
    );
    expect(html).toMatch(/contre les drones · interception 0–20/);
    expect(html).toMatch(/contre les missiles · interception Missiles de croisière 1–15/);
  });

  it('brigade mixte : moyenne pondérée de la composition', () => {
    const u = unit({
      systemId: 'ru.t-90m',
      count: 4,
      parts: [
        { systemId: 'ru.t-90m', count: 3 },
        { systemId: 'ru.infantry-light', count: 1 },
      ],
    });
    const mix = unitEffect(u, catalog, ctx)!;
    const t = unitEffect(unit({ systemId: 'ru.t-90m', count: 1 }), catalog, ctx)!;
    const i = unitEffect(unit({ systemId: 'ru.infantry-light', count: 1 }), catalog, ctx)!;
    expect(mix.helicopter).toBeCloseTo((3 * t.helicopter + i.helicopter) / 4, 10);
  });

  it('fiche d’arme : dix catégories, « nul » grisé', () => {
    const html = renderToStaticMarkup(
      createElement(EffectTable, { system: catalog['us.m777']!, ctx }),
    );
    expect(html).toContain('Efficacité par type de cible');
    expect(html).toContain('Sous-marins');
    expect(html).toContain('effcard__row--off');
    expect(html.match(/effcard__row/g)!.length).toBeGreaterThanOrEqual(10);
  });

  it('barre d’ordre : char contre artillerie mieux noté que contre un char', () => {
    const sel = [unit({ systemId: 'eu.leopard-2a7', count: 4 })];
    const art = selectionEffectAgainst(
      sel,
      unit({ id: 't', systemId: 'us.m777', level: 'precise' }),
      catalog,
      ctx,
    )!;
    const tank = selectionEffectAgainst(
      sel,
      unit({ id: 't', systemId: 'ru.t-90m', level: 'precise' }),
      catalog,
      ctx,
    )!;
    expect(art.score).toBeGreaterThan(tank.score);
    expect(
      selectionEffectAgainst(
        sel,
        unit({ id: 't', systemId: 'ru.t-90m', level: 'detected' }),
        catalog,
        ctx,
      ),
    ).toBeNull();
  });
});

describe('capture (avertissement de la barre d’ordre et du panneau)', () => {
  it('artillerie et chars capturent, S-400 seul non, pile S-400 + artillerie oui', () => {
    const one = (id: string) => unit({ systemId: id, count: 2 });
    expect(canCaptureUnit(one('us.m777'), catalog)).toBe(true);
    expect(canCaptureUnit(one('eu.leopard-2a7'), catalog)).toBe(true);
    expect(canCaptureUnit(one('ru.s-400'), catalog)).toBe(false);
    expect(canCaptureUnit(one('ru.iskander-m'), catalog)).toBe(false);
    const mixed = unit({
      systemId: 'ru.s-400',
      count: 3,
      parts: [
        { systemId: 'ru.s-400', count: 1 },
        { systemId: 'ru.2s19-msta', count: 2 },
      ],
    });
    expect(canCaptureUnit(mixed, catalog)).toBe(true);
  });
});
