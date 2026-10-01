import { describe, expect, it } from 'vitest';
import { frA, frAgree, frCap, frDe, frForms, frLe, frPlural } from '../src/french.js';

describe('grammaire des noms de pays', () => {
  it('« de » : contractions et élision', () => {
    expect(frDe('Maroc', 'le')).toBe('du Maroc');
    expect(frDe('France', 'la')).toBe('de la France');
    expect(frDe('Algérie', "l'")).toBe("de l'Algérie");
    expect(frDe('États-Unis', 'les')).toBe('des États-Unis');
    expect(frDe('Cuba', '')).toBe('de Cuba');
    expect(frDe('Israël', '')).toBe("d'Israël");
    expect(frDe('Oman', '')).toBe("d'Oman");
    expect(frDe('Haïti', '')).toBe("d'Haïti");
    expect(frDe('Hongrie', 'la')).toBe('de la Hongrie');
  });

  it('« à » : contractions', () => {
    expect(frA('Maroc', 'le')).toBe('au Maroc');
    expect(frA('France', 'la')).toBe('à la France');
    expect(frA('Algérie', "l'")).toBe("à l'Algérie");
    expect(frA('États-Unis', 'les')).toBe('aux États-Unis');
    expect(frA('Cuba', '')).toBe('à Cuba');
    expect(frA('Israël', '')).toBe('à Israël');
  });

  it('article seul et capitale de début de phrase', () => {
    expect(frLe('Maroc', 'le')).toBe('le Maroc');
    expect(frLe('France', 'la')).toBe('la France');
    expect(frLe('Algérie', "l'")).toBe("l'Algérie");
    expect(frLe('États-Unis', 'les')).toBe('les États-Unis');
    expect(frLe('Cuba', '')).toBe('Cuba');
    expect(frCap(frLe('Algérie', "l'"))).toBe("L'Algérie");
    expect(frCap('')).toBe('');
  });

  it('article absent ou invalide : forme neutre sans article', () => {
    expect(frLe('Maroc')).toBe('Maroc');
    expect(frDe('Ukraine', undefined)).toBe("d'Ukraine");
    expect(frA('Maroc', 'xx')).toBe('à Maroc');
  });

  it('formes groupées pour les gabarits', () => {
    expect(frForms('États-Unis', 'les')).toEqual({
      nation: 'États-Unis',
      nationLe: 'les États-Unis',
      NationLe: 'Les États-Unis',
      deNation: 'des États-Unis',
      aNation: 'aux États-Unis',
    });
  });

  it('accord du verbe avec les noms pluriels', () => {
    expect(frPlural('les')).toBe(true);
    expect(frPlural('la')).toBe(false);
    expect(frPlural(undefined)).toBe(false);
    expect(frAgree('les', 'attaque', 'attaquent')).toBe('attaquent');
    expect(frAgree("l'", 'attaque', 'attaquent')).toBe('attaque');
  });
});
