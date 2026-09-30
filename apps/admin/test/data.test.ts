/**
 * Valide toutes les données d'équilibrage du dépôt (data/catalog, data/balance, data/scenarios)
 * avec les schémas zod partagés, puis vérifie la cohérence de jeu du catalogue.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BalanceSchema,
  CatalogFileSchema,
  DOCTRINES,
  type Balance,
  type WeaponSystem,
} from '@redline/shared';

const DATA = resolve(import.meta.dirname, '../../../data');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (dir: string) =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort();

const catalogFiles = jsonFiles('catalog');
const systems: WeaponSystem[] = [];
const fileErrors: string[] = [];
for (const file of catalogFiles) {
  const parsed = CatalogFileSchema.safeParse(readJson(join(DATA, 'catalog', file)));
  if (!parsed.success) {
    fileErrors.push(
      `${file} : ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`,
    );
    continue;
  }
  if (parsed.data.category) {
    for (const s of parsed.data.systems) {
      if (s.category !== parsed.data.category) fileErrors.push(`${file} : ${s.id} hors catégorie`);
    }
  }
  systems.push(...parsed.data.systems);
}
const byId = new Map(systems.map((s) => [s.id, s]));
const fighters = systems.filter((s) => s.category === 'fighter');

describe('data/catalog', () => {
  it('tous les fichiers respectent CatalogFileSchema', () => {
    expect(catalogFiles.length).toBeGreaterThan(0);
    expect(fileErrors).toEqual([]);
  });

  it('identifiants uniques, préfixés par la doctrine', () => {
    expect(byId.size).toBe(systems.length);
    for (const s of systems) expect(s.id.split('.')[0], s.id).toBe(s.doctrine);
  });

  it('fiches complètes : sheet et champs optionnels explicitement renseignés', () => {
    const raw = catalogFiles.flatMap(
      (f) => (readJson(join(DATA, 'catalog', f)) as { systems: Record<string, unknown>[] }).systems,
    );
    const required = [
      'roles',
      'canCapture',
      'unitSize',
      'requires',
      'enabled',
      'sheet',
      'operationalRadiusKm',
    ];
    for (const s of raw)
      for (const k of required) expect(s, `${String(s.id)}.${k}`).toHaveProperty(k);
  });

  it('les aéronefs volent et ont un rayon d’action, les unités terrestres roulent', () => {
    for (const s of systems) {
      if (['fighter', 'bomber', 'air_support', 'helicopter', 'drone'].includes(s.category)) {
        expect(s.movement, s.id).toBe('air');
        expect(s.operationalRadiusKm, s.id).toBeGreaterThan(0);
      }
      if (['tank', 'ifv', 'artillery', 'air_defense', 'infantry'].includes(s.category)) {
        expect(s.movement, s.id).toBe('land');
        expect(s.operationalRadiusKm, s.id).toBeNull();
      }
      expect(s.weaponRangeKm.max, s.id).toBeGreaterThanOrEqual(s.weaponRangeKm.min);
    }
  });

  it('seules les unités terrestres de manœuvre capturent ; toute l’infanterie capture', () => {
    for (const s of systems) {
      if (s.canCapture) expect(['infantry', 'tank', 'ifv'], s.id).toContain(s.category);
      if (s.category === 'infantry') expect(s.canCapture, s.id).toBe(true);
    }
    for (const d of DOCTRINES) {
      expect(
        systems.some((s) => s.category === 'infantry' && s.doctrine === d),
        d,
      ).toBe(true);
    }
  });
});

describe('chasseurs et multirôles', () => {
  const expected = [
    'us.f-5e', 'us.f-16', 'us.f-15e', 'us.fa-18e', 'us.f-22', 'us.f-35',
    'ru.mig-21', 'ru.mig-29', 'ru.mig-31', 'ru.su-27', 'ru.su-30', 'ru.su-35', 'ru.su-57',
    'cn.j-7', 'cn.j-10', 'cn.j-11', 'cn.j-16', 'cn.j-20', 'cn.j-35',
    'eu.mirage-2000', 'eu.tornado', 'eu.gripen', 'eu.typhoon', 'eu.rafale',
    'other.jf-17', 'other.kf-21', 'other.tejas',
  ]; // prettier-ignore

  it('la catégorie est complète (27 systèmes)', () => {
    expect(fighters.map((f) => f.id).sort()).toEqual([...expected].sort());
  });

  it('la furtivité n’est significative que pour la 5e génération', () => {
    for (const f of fighters) {
      if (f.generation === 5) expect(f.stealth, f.id).toBeGreaterThanOrEqual(0.5);
      else expect(f.stealth, f.id).toBeLessThanOrEqual(0.15);
    }
  });

  it('coût et délai de production croissent avec la génération', () => {
    const avg = (gen: number, pick: (f: WeaponSystem) => number) => {
      const list = fighters.filter((f) => f.generation === gen);
      return list.reduce((a, f) => a + pick(f), 0) / list.length;
    };
    const gens = [2, 3, 4, 5];
    for (let i = 1; i < gens.length; i++) {
      expect(avg(gens[i]!, (f) => f.cost.money)).toBeGreaterThan(
        avg(gens[i - 1]!, (f) => f.cost.money),
      );
      expect(avg(gens[i]!, (f) => f.buildTimeH)).toBeGreaterThan(
        avg(gens[i - 1]!, (f) => f.buildTimeH),
      );
    }
    const f5 = byId.get('us.f-5e')!;
    const f35 = byId.get('us.f-35')!;
    expect(f35.cost.money).toBeGreaterThan(5 * f5.cost.money);
    expect(f35.buildTimeH).toBeGreaterThan(4 * f5.buildTimeH);
  });

  it('matrice de contre-mesures : forts contre avions et hélicoptères, moyens contre drones, faibles au sol', () => {
    for (const f of fighters) {
      const d = f.damage;
      if (!f.roles.includes('strike') || f.roles.includes('air_superiority')) {
        expect(d.aircraft, f.id).toBeGreaterThan(d.drone);
      }
      expect(d.helicopter, f.id).toBeGreaterThan(d.drone);
      expect(d.drone, f.id).toBeGreaterThan(d.armor);
      expect(d.armor, f.id).toBeLessThanOrEqual(5);
      expect(d.infantry, f.id).toBeLessThanOrEqual(4);
      expect(d.submarine, f.id).toBe(0);
      expect(
        f.requires.every((r) => /^research\.aero\.gen[0-9a-z]+$/.test(r)),
        f.id,
      ).toBe(true);
    }
  });
});

describe('table des contre-mesures (phase 1)', () => {
  /** Systèmes qui infligent au moins `min` dégâts par round à la classe visée. */
  const strong = (target: keyof WeaponSystem['damage'], min: number) =>
    systems.filter((s) => s.damage[target] >= min);
  const cats = (list: WeaponSystem[]) => new Set(list.map((s) => s.category));

  it('infanterie ← blindés, artillerie, aviation', () => {
    const c = cats(strong('infantry', 8));
    for (const k of ['tank', 'ifv', 'artillery', 'helicopter'] as const)
      expect(c.has(k), k).toBe(true);
    expect(cats(strong('infantry', 5)).has('drone')).toBe(true);
  });
  it('blindés ← antichar, hélicoptères, drones', () => {
    const c = cats(strong('armor', 8));
    for (const k of ['tank', 'helicopter', 'drone'] as const) expect(c.has(k), k).toBe(true);
    expect(c.has('fighter')).toBe(false);
  });
  it('artillerie ← contre-batterie, drones, aviation (cible blindée légère)', () => {
    for (const s of systems.filter((x) => x.category === 'artillery')) {
      expect(s.targetClass).toBe('armor');
      expect(s.armor, s.id).toBeLessThanOrEqual(0.35);
      expect(s.damage.armor, s.id).toBeGreaterThan(0);
    }
  });
  it('hélicoptères ← défense aérienne courte portée et chasseurs', () => {
    const top = strong('helicopter', 14);
    expect(top.some((s) => s.roles.includes('short_range_sam'))).toBe(true);
    expect(top.some((s) => s.category === 'fighter')).toBe(true);
    expect(cats(strong('helicopter', 5)).has('tank')).toBe(false);
  });
  it('drones ← brouillage et défense aérienne courte portée', () => {
    const jammers = systems.filter((s) => s.ew.jamming >= 0.5 && s.damage.drone > 0);
    expect(jammers.length).toBeGreaterThan(0);
    const top = [...systems].sort((a, b) => b.damage.drone - a.damage.drone).slice(0, 2);
    expect(top.every((s) => s.roles.includes('short_range_sam'))).toBe(true);
  });
  it('défense aérienne ← brouillage (résistance limitée) et saturation (peu de PV)', () => {
    for (const s of systems.filter((x) => x.roles.includes('long_range_sam'))) {
      expect(s.ew.jamResistance, s.id).toBeLessThanOrEqual(0.5);
      expect(s.hp, s.id).toBeLessThan(30);
    }
  });
  it('les chars ne touchent ni avions ni drones', () => {
    for (const s of systems.filter((x) => x.category === 'tank')) {
      expect(s.damage.aircraft + s.damage.drone, s.id).toBe(0);
    }
  });
});

describe('data/balance', () => {
  const balances = jsonFiles('balance').map((f) => ({
    f,
    b: BalanceSchema.parse(readJson(join(DATA, 'balance', f))),
  }));

  it('default.json existe et respecte BalanceSchema', () => {
    expect(balances.map((x) => x.f)).toContain('default.json');
  });

  it('les armées de départ n’utilisent que des systèmes du catalogue', () => {
    for (const { f, b } of balances) {
      for (const u of [...b.startingArmy, ...b.garrisonArmy]) {
        expect(byId.has(u.systemId), `${f} : ${u.systemId}`).toBe(true);
      }
    }
  });

  it('réglages de temps et de victoire dans les plages prévues', () => {
    const b: Balance = balances.find((x) => x.f === 'default.json')!.b;
    expect(b.time.combatRoundMinutes).toBeGreaterThanOrEqual(15);
    expect(b.time.combatRoundMinutes).toBeLessThanOrEqual(30);
    expect(b.time.captureMinutes).toBeGreaterThanOrEqual(60);
    expect(b.time.captureMinutes).toBeLessThanOrEqual(120);
    expect(b.victory.provinceShare).toBeGreaterThan(0.5);
    const armyCost = b.startingArmy.reduce(
      (a, u) => a + byId.get(u.systemId)!.cost.money * u.count,
      0,
    );
    const garrisonCost = b.garrisonArmy.reduce(
      (a, u) => a + byId.get(u.systemId)!.cost.money * u.count,
      0,
    );
    expect(garrisonCost).toBeLessThan(armyCost / 3);
    // L'argent de départ permet quelques achats, pas une seconde armée complète.
    expect(b.economy.startingMoney).toBeGreaterThan(byId.get('us.f-16')!.cost.money * 3);
    expect(b.economy.startingMoney).toBeLessThan(armyCost * 1.5);
  });
});

describe('data/scenarios', () => {
  it('chaque scénario a la forme ScenarioSummary', () => {
    const files = jsonFiles('scenarios');
    expect(files).toContain('world-today.json');
    for (const f of files) {
      const s = readJson(join(DATA, 'scenarios', f)) as Record<string, unknown>;
      expect(typeof s.id, f).toBe('string');
      expect(s.id, f).toBe(f.replace(/\.json$/, ''));
      expect(typeof s.name, f).toBe('string');
      expect(typeof s.description, f).toBe('string');
      const p = s.playableNations;
      expect(p === 'all' || (Array.isArray(p) && p.every((n) => typeof n === 'string')), f).toBe(
        true,
      );
    }
  });
});
