/** Ressources des provinces côté client : correspondances, raisons de blocage traduites, données. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProvinceDefSchema } from '@redline/shared';
import fr from '../src/i18n/fr.json';
import { BUILDING_GROUPS } from '../src/components/Buildings.js';
import {
  BUILD_BLOCKS,
  SITE_RESTRICTIONS,
  buildMenuGroups,
  extractionResource,
  servicesBonusPct,
} from '../src/lib/resources.js';

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

  it('menu Construire : seuls les bâtiments ouverts, les impossibles absents (pas grisés)', () => {
    const coastalOnly = new Set(['port', 'naval_base', 'coastal_battery']);
    // Alger : argent seulement, côtière ; une mine héritée d'une ancienne sauvegarde reste (amélioration).
    const alger = buildMenuGroups(BUILDING_GROUPS, {
      existing: ['mine', 'air_base'],
      coastal: true,
      coastalOnly,
      options: [
        { type: 'oil_field', blocked: 'no_resource' },
        { type: 'farm', blocked: 'no_resource' },
        { type: 'refinery' },
        { type: 'power_plant' },
        { type: 'electronics_plant' },
        { type: 'port' },
        { type: 'bunker', blocked: 'in_progress' },
      ],
    });
    const res = alger.find((g) => g.id === 'resources')!;
    expect(res.types).not.toContain('oil_field');
    expect(res.types).not.toContain('farm');
    expect(res.types).toContain('mine'); // déjà présente
    expect(res.types).toContain('refinery');
    expect(res.hidden).toEqual({ no_resource: ['oil_field', 'farm'] });
    // Chantier en cours : temporaire, reste affiché (désactivé), pas caché.
    expect(alger.find((g) => g.id === 'defense')!.types).toContain('bunker');
    // Hassi Messaoud (intérieure, pétrole) : puits proposé, bâtiments côtiers absents.
    const hassi = buildMenuGroups(BUILDING_GROUPS, {
      existing: [],
      coastal: false,
      coastalOnly,
      options: [
        { type: 'oil_field' },
        { type: 'mine', blocked: 'no_resource' },
        { type: 'farm', blocked: 'no_resource' },
        { type: 'electronics_plant', blocked: 'not_urban' },
        { type: 'port', blocked: 'coastal_only' },
        { type: 'naval_base', blocked: 'coastal_only' },
      ],
    });
    expect(hassi.find((g) => g.id === 'resources')!.types).toEqual([
      'oil_field',
      'refinery',
      'power_plant',
    ]);
    expect(hassi.find((g) => g.id === 'military')!.types).not.toContain('port');
    // Sans options du moteur : règle côtière connue du client (coastal_battery absente).
    const bare = buildMenuGroups(BUILDING_GROUPS, { existing: [], coastal: false, coastalOnly });
    expect(bare.find((g) => g.id === 'defense')!.hidden.coastal_only).toEqual(['coastal_battery']);
    // Famille vide : retirée du menu.
    const only = buildMenuGroups([{ id: 'x', types: ['oil_field'] }], {
      existing: [],
      coastal: true,
      coastalOnly,
      options: [{ type: 'oil_field', blocked: 'no_resource' }],
    });
    expect(only).toEqual([]);
    // Chaque explication est traduite et cite la liste.
    for (const r of SITE_RESTRICTIONS)
      expect(get(`buildings.ui.hidden.${r}`)).toMatch(/\{\{list\}\}/);
    expect(get('buildings.ui.upgradeTo')).toMatch(/\{\{level\}\}/);
  });

  it('carte réelle : Alger argent seulement (pas de puits ni de mine proposés), Ouargla pétrole', () => {
    const file = join(import.meta.dirname, '..', '..', '..', 'data', 'map', 'provinces.json');
    const provs = ProvinceDefSchema.array().parse(JSON.parse(readFileSync(file, 'utf8')));
    const alger = provs.find((p) => p.nationId === 'dza' && p.isCapital)!;
    expect(alger.cityName).toBe('Alger');
    expect(alger.resources).toEqual([]);
    const ouargla = provs.find((p) => p.name === 'Ouargla Nord-Est')!;
    expect(ouargla.resources![0]).toMatchObject({ type: 'oil', richness: 3 });
  });
});
