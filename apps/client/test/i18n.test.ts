import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import {
  LOCALES,
  LOCALE_NAMES,
  LOCALE_TAGS,
  RTL_LOCALES,
  isLocale,
  matchLocale,
  pickLocale,
  type Locale,
} from '@redline/shared';
import { detectLocale, fillPlurals, localeFromPath, stripLocalePrefix } from '../src/i18n/index.js';

const DIR = join(import.meta.dirname, '../src/i18n/locales');
const load = (l: Locale) => JSON.parse(readFileSync(join(DIR, `${l}.json`), 'utf8'));

describe('détection de la langue', () => {
  const base = { pathname: '/', search: '', stored: null, languages: [] as string[] };

  it('préfixe de route > paramètre > mémorisé > navigateur > anglais', () => {
    expect(
      detectLocale({ ...base, pathname: '/ar/games', search: '?lang=ja', stored: 'de' }),
    ).toEqual({
      lang: 'ar',
      source: 'path',
    });
    expect(detectLocale({ ...base, search: '?lang=ja', stored: 'de' })).toEqual({
      lang: 'ja',
      source: 'query',
    });
    expect(detectLocale({ ...base, stored: 'de', languages: ['fr-FR'] })).toEqual({
      lang: 'de',
      source: 'storage',
    });
    expect(detectLocale({ ...base, languages: ['pt-PT', 'en'] })).toEqual({
      lang: 'pt',
      source: 'browser',
    });
    expect(detectLocale({ ...base, languages: ['sw'] })).toEqual({ lang: 'en', source: 'default' });
  });

  it('valeurs inconnues ignorées', () => {
    expect(detectLocale({ ...base, stored: 'xx', search: '?lang=zz' }).source).toBe('default');
    expect(localeFromPath('/xx/foo')).toBeNull();
    expect(localeFromPath('/en')).toBe('en');
    expect(localeFromPath('/english')).toBeNull();
  });

  it('retire le préfixe de langue', () => {
    expect(stripLocalePrefix('/en/game/42')).toBe('/game/42');
    expect(stripLocalePrefix('/en')).toBe('/');
    expect(stripLocalePrefix('/game/42')).toBe('/game/42');
  });

  it('variantes régionales et écritures', () => {
    expect(matchLocale('zh-TW')).toBe('zh');
    expect(matchLocale('pt-BR')).toBe('pt');
    expect(matchLocale('ar-EG')).toBe('ar');
    expect(pickLocale(['xx', 'tr-TR'])).toBe('tr');
  });
});

describe('langues déclarées', () => {
  it('quinze langues, chacune nommée dans son écriture, sens d’écriture connu', () => {
    expect(LOCALES).toHaveLength(15);
    for (const l of LOCALES) {
      expect(isLocale(l)).toBe(true);
      expect(LOCALE_NAMES[l].length).toBeGreaterThan(1);
      expect(LOCALE_TAGS[l]).toBeTruthy();
    }
    expect(RTL_LOCALES).toEqual(['ar']);
  });

  it('un fichier de langue par langue cible', () => {
    for (const l of LOCALES.filter((x) => x !== 'fr'))
      expect(Object.keys(load(l)).length).toBeGreaterThan(10);
  });
});

/** Résout une clé plurielle dans la langue demandée (règles CLDR de Intl). */
function plural(l: Locale, key: string, count: number): string {
  const i = createInstance();
  void i.init({
    lng: l,
    resources: { [l]: { translation: fillPlurals(load(l), l) } },
    interpolation: { escapeValue: false },
  });
  return i.t(key, { count });
}

describe('pluriels ICU et variables', () => {
  it('russe : une, quelques, beaucoup', () => {
    expect(plural('ru', 'armies.piles', 1)).toBe('1 стек');
    expect(plural('ru', 'armies.piles', 3)).toBe('3 стека');
    expect(plural('ru', 'armies.piles', 11)).toBe('11 стеков');
  });
  it('arabe : six catégories', () => {
    expect(plural('ar', 'armies.piles', 0)).toBe('0 كومة');
    expect(plural('ar', 'armies.piles', 1)).toBe('كومة واحدة');
    expect(plural('ar', 'armies.piles', 2)).toBe('كومتان');
    expect(plural('ar', 'armies.piles', 5)).toBe('5 أكوام');
    expect(plural('ar', 'armies.piles', 12)).toBe('12 كومة');
  });
  it('anglais, japonais : variables préservées', () => {
    expect(plural('en', 'armies.piles', 1)).toBe('1 stack');
    expect(plural('en', 'armies.piles', 4)).toBe('4 stacks');
    expect(plural('ja', 'armies.piles', 4)).toBe('4 スタック');
  });
});

describe('formats localisés', () => {
  it('nombres et monnaie selon la langue', () => {
    expect(new Intl.NumberFormat(LOCALE_TAGS.de).format(1234567)).toBe('1.234.567');
    expect(new Intl.NumberFormat('ar-u-nu-latn').format(1234)).toMatch(/^1[,٬]234$/);
    const usd = new Intl.NumberFormat(LOCALE_TAGS.en, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
    expect(usd.format(1500)).toBe('$1,500');
  });
});
