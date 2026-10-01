import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptLicense, stripHtml } from '../src/lib.js';

const REPO = resolve(__dirname, '../../..');

describe('acceptLicense', () => {
  it('accepte domaine public, CC0, CC BY et CC BY-SA', () => {
    expect(acceptLicense('pd', 'Public domain')).toBe('Domaine public');
    expect(acceptLicense('cc0', 'CC0')).toBe('CC0 1.0');
    expect(acceptLicense('cc-by-4.0', 'CC BY 4.0')).toBe('CC BY 4.0');
    expect(acceptLicense('cc-by-sa-3.0', 'CC BY-SA 3.0')).toBe('CC BY-SA 3.0');
    expect(acceptLicense('cc-by-sa-2.5', 'CC BY-SA 2.5')).toBe('CC BY-SA 2.5');
  });

  it('refuse NC, ND, usage loyal et licences inconnues', () => {
    expect(acceptLicense('cc-by-nc-4.0', 'CC BY-NC 4.0')).toBeNull();
    expect(acceptLicense('cc-by-nd-2.0', 'CC BY-ND 2.0')).toBeNull();
    expect(acceptLicense('', 'Fair use')).toBeNull();
    expect(acceptLicense('', 'GODL-India')).toBeNull();
    expect(acceptLicense('', '')).toBeNull();
  });

  it("n'admet la Licence Ouverte et l'OGL qu'en mode étendu (surcharges manuelles)", () => {
    expect(acceptLicense('', 'Licence Ouverte')).toBeNull();
    expect(acceptLicense('', 'Licence Ouverte', true)).toBe('Licence Ouverte');
    expect(acceptLicense('ogl-3', 'OGL 3', true)).toBe('OGL v3');
  });

  it("n'admet la GODL-India que pour une surcharge qui la cite (validation au cas par cas)", () => {
    expect(acceptLicense('', 'GODL-India', true)).toBeNull();
    expect(acceptLicense('', 'GODL-India', true, ['GODL-India'])).toBe('GODL-India');
    expect(acceptLicense('', 'Government Open Data License - India', true, ['GODL-India'])).toBe(
      'GODL-India',
    );
    expect(acceptLicense('cc-by-nc-4.0', 'CC BY-NC 4.0', true, ['GODL-India'])).toBeNull();
  });
});

describe('stripHtml', () => {
  it('retire les balises et décode les entités', () => {
    expect(stripHtml('<a href="x">U.S. Navy</a> photo &amp; co')).toBe('U.S. Navy photo & co');
  });
});

describe('manifeste data/art/photos.json', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO, 'data/art/photos.json'), 'utf8'),
  ) as Record<
    string,
    {
      file: string;
      thumb: string;
      credit: string;
      license: string;
      sourceUrl: string;
      title: string;
    }
  >;
  const ids = new Set(
    (
      JSON.parse(readFileSync(resolve(REPO, 'data/catalog-ids.json'), 'utf8')) as {
        systems: { id: string }[];
      }
    ).systems.map((s) => s.id),
  );

  it('ne référence que des systèmes du catalogue, avec fichiers présents et attribution complète', () => {
    for (const [id, e] of Object.entries(manifest)) {
      expect(ids.has(id), id).toBe(true);
      expect(e.file).toBe(`/art/photos/${id}.webp`);
      expect(e.thumb).toBe(`/art/photos/${id}.thumb.webp`);
      expect(existsSync(resolve(REPO, 'apps/client/public', e.file.slice(1))), e.file).toBe(true);
      expect(existsSync(resolve(REPO, 'apps/client/public', e.thumb.slice(1))), e.thumb).toBe(true);
      expect(e.credit.length, id).toBeGreaterThan(0);
      expect(e.sourceUrl, id).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      // Licence gouvernementale indienne : validée par Amine pour l'Agni-V seulement.
      if (e.license === 'GODL-India') expect(id).toBe('other.agni-v');
      expect(e.license, id).toMatch(
        /^(Domaine public|CC0 1\.0|CC BY(-SA)? \d\.\d|Licence Ouverte|OGL v3|GODL-India)$/,
      );
    }
  });
});
