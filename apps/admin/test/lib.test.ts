import { describe, expect, it } from 'vitest';
import { diffObjects, flatten } from '../src/lib/diff';
import { getIn, setIn } from '../src/lib/paths';
import { validateSystem } from '../src/lib/validation';
import { parseImport } from '../src/lib/importFile';
import { parseHash, href } from '../src/lib/router';
import { blankSystem } from '../src/lib/template';
import { fmt } from '../src/i18n';
import { formatGameTime } from '../src/screens/Games';

describe('chemins', () => {
  it('setIn est immuable et supprime la clé pour undefined', () => {
    const a = { cost: { money: 1, resources: { oil: 2 } } };
    const b = setIn(a, ['cost', 'resources', 'oil'], undefined);
    expect(a.cost.resources.oil).toBe(2);
    expect(b.cost.resources).toEqual({});
    expect(getIn(setIn(a, ['cost', 'money'], 9), ['cost', 'money'])).toBe(9);
  });
});

describe('différences champ par champ', () => {
  it('aplatit et compare', () => {
    expect(flatten({ a: { b: 1, c: [1, 2] } })).toEqual({ 'a.b': 1, 'a.c': [1, 2] });
    const d = diffObjects(
      { cost: { money: 1 }, roles: ['a'], x: 1 },
      { cost: { money: 2 }, roles: ['a', 'b'], x: 1 },
    );
    expect(d.map((c) => c.path)).toEqual(['cost.money', 'roles']);
    expect(diffObjects(null, { a: 1 })).toEqual([{ path: 'a', before: undefined, after: 1 }]);
  });
});

describe('validation lisible', () => {
  it('la fiche vierge est invalide seulement par son identifiant et son nom', () => {
    const r = validateSystem(blankSystem());
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path).sort()).toEqual(['id', 'name']);
  });
  it('messages en français avec libellés de champs', () => {
    const s = {
      ...blankSystem(),
      id: 'us.test',
      name: 'Test',
      armor: 2,
      cost: { money: -1 },
    } as Record<string, unknown>;
    delete s.hp;
    const r = validateSystem(s);
    const msg = Object.fromEntries(r.issues.map((i) => [i.path, `${i.label} : ${i.message}`]));
    expect(msg.armor).toBe('Blindage (0 à 0,9) : doit être inférieur ou égal à 0,9');
    expect(msg['cost.money']).toBe('Coût (argent) : doit être supérieur ou égal à 0');
    expect(msg.hp).toBe('Points de vie par élément : champ obligatoire');
  });
  it('avertissements de cohérence', () => {
    const s = {
      ...blankSystem(),
      id: 'ru.test',
      name: 'T',
      operationalRadiusKm: null,
      stealth: 0.8,
      generation: 4,
    };
    const r = validateSystem(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(3); // rayon manquant, préfixe, furtivité
  });
});

describe('import', () => {
  it('accepte un tableau ou { systems }', () => {
    const one = { ...blankSystem(), id: 'us.x', name: 'X' };
    const a = parseImport(JSON.stringify([one]));
    const b = parseImport(JSON.stringify({ systems: [one, { id: 'us.y' }] }));
    expect('rows' in a && a.rows[0]!.ok).toBe(true);
    expect('rows' in b && b.rows.map((r) => r.ok)).toEqual([true, false]);
    expect('error' in parseImport('{')).toBe(true);
    expect('error' in parseImport('{"a":1}')).toBe(true);
  });
});

describe('divers', () => {
  it('routes', () => {
    expect(parseHash('#/systems/us.f-16/history')).toEqual({ name: 'history', id: 'us.f-16' });
    expect(parseHash(href({ name: 'system', id: 'eu.rafale' }))).toEqual({
      name: 'system',
      id: 'eu.rafale',
    });
    expect(parseHash('')).toEqual({ name: 'catalog' });
  });
  it('formats', () => {
    expect(fmt('{a} et {b}', { a: 1 })).toBe('1 et {b}');
    expect(formatGameTime((2 * 24 + 14) * 3600_000 + 5 * 60_000)).toBe('J3 14:05');
  });
});
