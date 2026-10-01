/**
 * Complétude des traductions (CI, sans appel réseau) : pour chaque langue cible et chaque domaine,
 * toutes les clés de la source française existent, les variables `{{…}}` et le balisage sont
 * conservés, les pluriels couvrent les catégories CLDR de la langue, la longueur reste raisonnable,
 * et l'empreinte de la source (mode incrémental) est à jour.
 */
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from '@redline/shared';
import { TARGETS } from '../src/config.js';
import { pending, sourceUnits } from '../src/check.js';
import { checkText, flatten, merge, pluralCats, toUnits, vars } from '../src/units.js';

/** Domaines à couvrir pour toutes les langues ; les autres le sont en anglais (repli ensuite). */
const FULL = ['client', 'server'];
const ENGLISH_ONLY = ['data', 'nations'];

describe('traductions : complétude', () => {
  it('quatorze langues cibles (le français est la source)', () => {
    expect(TARGETS).toHaveLength(LOCALES.length - 1);
    expect(TARGETS).not.toContain('fr');
  });

  for (const domain of FULL) {
    for (const lang of TARGETS) {
      it(`${domain}/${lang} : clés, variables, pluriels, longueur, empreintes`, () => {
        const todo = pending(domain, lang);
        expect(
          todo.map((u) => u.id),
          `${todo.length} unité(s) à traduire ou invalides`,
        ).toEqual([]);
      });
    }
  }

  for (const domain of ENGLISH_ONLY) {
    it(`${domain}/en : complet (autres langues : repli anglais)`, () => {
      expect(pending(domain, 'en' as Locale).map((u) => u.id)).toEqual([]);
    });
  }

  it('le texte source de chaque domaine est non vide', () => {
    for (const d of [...FULL, ...ENGLISH_ONLY])
      expect(sourceUnits(d).units.length).toBeGreaterThan(0);
  });
});

describe('contrôles de traduction', () => {
  it('variables perdues ou ajoutées refusées', () => {
    expect(checkText('Bonjour {{name}}', 'Hello {{name}}', 'en')).toEqual([]);
    expect(checkText('Bonjour {{name}}', 'Hello', 'en')).not.toEqual([]);
    expect(checkText('Bonjour {{name}}', 'Hello {{nom}}', 'en')).not.toEqual([]);
  });
  it('« Red Line » jamais traduit', () => {
    expect(checkText('Bienvenue dans Red Line', 'Bienvenue dans Ligne Rouge', 'es')).not.toEqual(
      [],
    );
  });
  it('longueur excessive et texte non traduit refusés', () => {
    expect(checkText('Oui', 'x'.repeat(200), 'de')).not.toEqual([]);
    expect(checkText('Aucune armée sur la carte', 'Aucune armée sur la carte', 'ru')).not.toEqual(
      [],
    );
  });
  it('pluriels : catégories CLDR par langue', () => {
    expect(pluralCats('ru')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCats('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    expect(pluralCats('ja')).toEqual(['other']);
    expect(pluralCats('en')).toEqual(['one', 'other']);
  });
  it('les variables {{…}} sont extraites par nom', () => {
    expect([...vars('a {{x}} b {{ y, number }}')]).toEqual(['x', 'y']);
    expect(toUnits(flatten(merge({ a: { b_one: 'x', b_other: 'y' } }, {}))).length).toBe(1);
  });
});
