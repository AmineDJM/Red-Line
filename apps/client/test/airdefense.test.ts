import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogFileSchema, type UnitView, type WeaponSystem } from '@redline/shared';
import '../src/i18n/index.js';
import { AirDefenseCaps, AirDefenseChips } from '../src/components/AirDefenseCaps.js';
import { orderReason } from '../src/lib/loc.js';

const catalog: WeaponSystem[] = CatalogFileSchema.parse(
  JSON.parse(
    readFileSync(join(__dirname, '../../../data/catalog/air_defense.json'), 'utf8'),
  ) as unknown,
).systems;
const sys = (id: string) => catalog.find((s) => s.id === id)!;

describe('défense antiaérienne : fiche et refus traduits', () => {
  it('fiche S-400 : catégories interceptées avec portées, hypersoniques grisés, magasin restant', () => {
    const unit = {
      id: 'u1',
      owner: 'rus',
      level: 'own',
      pos: [37, 55],
      lastSeen: 0,
      uncertaintyKm: 0,
      airDefense: { ammo: 18, max: 32, fullAt: 3_600_000 },
    } as UnitView;
    const html = renderToStaticMarkup(
      createElement(AirDefenseCaps, { system: sys('ru.s-400'), unit, now: 0 }),
    );
    expect(html).toContain('Défense antiaérienne');
    expect(html).toContain('Missiles balistiques');
    expect(html).toMatch(/3–380(&nbsp;| | )km/);
    expect(html).toMatch(/5–60(&nbsp;| | )km/);
    expect(html).toContain('adcaps__off');
    expect(html).toContain('18/32');
    expect(html).toContain('Plein dans');
  });

  it('pastilles du Pantsir : drones et croisière, pas de balistiques', () => {
    const html = renderToStaticMarkup(
      createElement(AirDefenseChips, { system: sys('ru.pantsir-s1') }),
    );
    expect(html).toContain('Drones : 0–20');
    expect(html).toContain('Missiles balistiques : non intercepté');
  });

  it('raisons de refus : catégorie et portée par catégorie', () => {
    expect(
      orderReason({
        reason: 'ad_cannot_engage',
        params: { name: 'Pantsir-S1', cat: 'ballistic_missile' },
      }),
    ).toBe("Pantsir-S1 n'intercepte pas les missiles balistiques.");
    expect(
      orderReason({
        reason: 'ad_out_of_range',
        params: { name: 'S-400 Triumf', dist: 410, min: 3, max: 380, cat: 'aircraft' },
      }),
    ).toBe('S-400 Triumf — hors de portée : 410 km, portée 3–380 km contre les avions.');
  });
});
