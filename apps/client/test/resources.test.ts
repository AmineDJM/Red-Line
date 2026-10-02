/** Ressources des provinces côté client : correspondances, raisons de blocage traduites, données. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProvinceDefSchema } from '@redline/shared';
import fr from '../src/i18n/fr.json';
import { BUILD_BLOCKS, extractionResource, servicesBonusPct } from '../src/lib/resources.js';

const get = (path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], fr);

describe('ressources des provinces (client)', () => {
  it('bâtiments d’extraction → ressource (défauts et data/balance)', () => {
    expect(extractionResource(null, 'oil_field')).toBe('oil');
    expect(extractionResource(null, 'mine')).toBe('metals');
    expect(extractionResource(null, 'farm')).toBe('food');
    expect(extractionResource(null, 'bunker')).toBeUndefined();
    expect(extractionResource({ resources: { extraction: { mine: 'oil' } } }, 'mine')).toBe('oil');
    expect(servicesBonusPct(null)).toBe(10);
    expect(servicesBonusPct({ resources: { servicesIncomeBonus: 0.25 } })).toBe(25);
  });

  it('chaque raison de blocage, richesse et rang est traduite', () => {
    for (const b of BUILD_BLOCKS) expect(get(`buildings.ui.blocked.${b}`), b).toBeTypeOf('string');
    for (const r of ['1', '2', '3']) expect(get(`province.richness.${r}`)).toBeTypeOf('string');
    expect(get('game.orders.errors.resource_required')).toBeTypeOf('string');
    expect(get('province.resourceNone')).toMatch(/\{\{pct\}\}/);
  });

  it('carte réelle : Alger argent seulement (pas de puits ni de mine proposés), Ouargla pétrole', () => {
    const file = join(import.meta.dirname, '..', '..', '..', 'data', 'map', 'provinces.json');
    const provs = ProvinceDefSchema.array().parse(JSON.parse(readFileSync(file, 'utf8')));
    const alger = provs.find((p) => p.nationId === 'dza' && p.isCapital)!;
    expect(alger.cityName).toBe('Alger');
    expect(alger.resources).toEqual([]);
    // Hassi Messaoud : ancienne province « Ouargla Nord-Est », fusionnée (data/map/aliases.json).
    const aliases = JSON.parse(readFileSync(join(file, '..', 'aliases.json'), 'utf8')) as Record<
      string,
      string
    >;
    const ouargla = provs.find((p) => p.id === aliases['dza:Ouargla Nord-Est'])!;
    expect(ouargla.resources![0]).toMatchObject({ type: 'oil', richness: 3 });
  });
});
