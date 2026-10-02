/**
 * Textes localisables du moteur : chaque clé `engine.*` (ou identifiant `noteLoc`) référencée dans le
 * code du moteur existe dans le dictionnaire français du client (`fr.engine.json`), donc dans toutes
 * les langues traduites. Le moteur reste déterministe : il ne porte que des clés et des paramètres.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@redline/shared';
import { CLIENT_I18N, REPO } from '../src/config.js';
import { flatten, type Tree } from '../src/units.js';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

const fr = flatten(JSON.parse(readFileSync(join(CLIENT_I18N, 'fr.engine.json'), 'utf8')) as Tree);
const frKeys = new Set(
  Object.keys(fr).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')),
);
const files = walk(join(REPO, 'packages/engine/src'));

describe('clés localisables du moteur', () => {
  it('chaque clé engine.* utilisée dans le moteur existe dans fr.engine.json', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/['"`](engine\.[A-Za-z0-9_.]+)['"`]/g)) {
        if (!frKeys.has(m[1]!)) missing.push(`${f.replace(REPO, '')} : ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('chaque identifiant noteLoc a son titre et son texte', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/noteLoc\(\s*['"`]([A-Za-z0-9_.]+)['"`]/g)) {
        if (!frKeys.has(`engine.note.${m[1]}.title`)) missing.push(`${m[1]} (titre)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('les langues traduites couvrent les textes du moteur', () => {
    for (const l of LOCALES.filter((x) => x !== 'fr')) {
      const t = flatten(
        JSON.parse(readFileSync(join(CLIENT_I18N, 'locales', `${l}.json`), 'utf8')) as Tree,
      );
      const absent = [...frKeys].filter(
        (k) => !Object.keys(t).some((x) => x === k || x.startsWith(`${k}_`)),
      );
      expect(absent, l).toEqual([]);
    }
  });
});
