/**
 * Valide toutes les données d'équilibrage du dépôt (data/catalog, data/research, data/balance,
 * data/scenarios) avec les schémas zod partagés, puis vérifie la cohérence de jeu de l'arsenal :
 * identifiants de référence, prix en dollars, portes de recherche, ères et table des contre-mesures.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILDING_TYPES,
  BalanceSchema,
  CatalogFileSchema,
  DOCTRINES,
  INTEL_OPS,
  MODIFIER_KEYS,
  RESEARCH_BRANCHES,
  ResearchFileSchema,
  ScenarioFileSchema,
  captureByRule,
  type Balance,
  type ResearchNode,
  type WeaponSystem,
} from '@redline/shared';

const DATA = resolve(import.meta.dirname, '../../../data');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (dir: string) =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort();
const issues = (e: { issues: { path: (string | number)[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ');

// ——— Catalogue ———

const catalogFiles = jsonFiles('catalog');
const systems: WeaponSystem[] = [];
const fileErrors: string[] = [];
for (const file of catalogFiles) {
  const parsed = CatalogFileSchema.safeParse(readJson(join(DATA, 'catalog', file)));
  if (!parsed.success) {
    fileErrors.push(`${file} : ${issues(parsed.error)}`);
    continue;
  }
  if (parsed.data.category !== file.replace(/\.json$/, '')) {
    fileErrors.push(`${file} : champ category = ${String(parsed.data.category)}`);
  }
  for (const s of parsed.data.systems) {
    if (s.category !== parsed.data.category) fileErrors.push(`${file} : ${s.id} hors catégorie`);
  }
  systems.push(...parsed.data.systems);
}
const byId = new Map(systems.map((s) => [s.id, s]));
const fighters = systems.filter((s) => s.category === 'fighter');
const reference = (
  readJson(join(DATA, 'catalog-ids.json')) as { systems: { id: string; category: string }[] }
).systems;

// ——— Recherche ———

const researchFiles = jsonFiles('research');
const nodes: (ResearchNode & { file: string })[] = [];
const researchErrors: string[] = [];
for (const file of researchFiles) {
  const parsed = ResearchFileSchema.safeParse(readJson(join(DATA, 'research', file)));
  if (!parsed.success) researchErrors.push(`${file} : ${issues(parsed.error)}`);
  else nodes.push(...parsed.data.nodes.map((n) => ({ ...n, file })));
}
const nodeById = new Map(nodes.map((n) => [n.id, n]));

/** Portes de recherche fixées par le brief (identifiants utilisés par le catalogue, l'ORBAT et le moteur). */
const GATES = [
  ...['gen2', 'gen3', 'gen4', 'gen4plus', 'gen5', 'bomber1', 'bomber2', 'stealth-bomber'].map(
    (x) => `aero.${x}`,
  ),
  ...['helo1', 'helo2', 'helo3', 'drones1', 'drones2', 'drones3', 'aew', 'tanker', 'transport'].map(
    (x) => `aero.${x}`,
  ),
  ...['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'mlrs', 'ew'].map((x) => `land.${x}`),
  ...['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'carrier', 'sub1', 'sub2', 'sub3', 'ssbn'].map(
    (x) => `naval.${x}`,
  ),
  ...['sam1', 'sam2', 'sam3', 'sam4', 'sam5', 'abm', 'cruise1', 'cruise2', 'antiship'].map(
    (x) => `missiles.${x}`,
  ),
  ...['ballistic1', 'ballistic2', 'ballistic3', 'hypersonic'].map((x) => `missiles.${x}`),
  ...['weapons', 'icbm', 'slbm'].map((x) => `nuclear.${x}`),
  ...['radar1', 'radar2', 'radar3', 'space1', 'space2', 'asat'].map((x) => `sensors.${x}`),
  ...['l1', 'l2', 'l3'].map((x) => `cyber.${x}`),
  ...['interior', 'exterior', 'military'].flatMap((d) => [1, 2, 3].map((l) => `intel.${d}${l}`)),
  ...['l1', 'l2', 'l3'].map((x) => `industry.${x}`),
].map((x) => `research.${x}`);

const AIR = ['fighter', 'bomber', 'air_support', 'helicopter', 'drone'];
const LAND = ['tank', 'ifv', 'artillery', 'air_defense', 'infantry'];
/** Comparaison tolérante (la catégorie « radar » vient d'un contrat récent). */
const isCat = (s: WeaponSystem, c: string) => (s.category as string) === c;
/** Munitions consommées au tir (missiles, bombes, munitions rôdeuses). */
const isMunition = (s: WeaponSystem) =>
  s.category === 'strike_missile' || s.category === 'nuclear' || s.missile !== undefined;

describe('data/catalog', () => {
  it('tous les fichiers respectent CatalogFileSchema (un fichier par catégorie)', () => {
    expect(catalogFiles.length).toBeGreaterThan(0);
    expect(fileErrors).toEqual([]);
  });

  it('identifiants = data/catalog-ids.json exactement, mêmes catégories', () => {
    expect(byId.size).toBe(systems.length);
    expect([...byId.keys()].sort()).toEqual(reference.map((r) => r.id).sort());
    for (const r of reference) expect(byId.get(r.id)?.category, r.id).toBe(r.category);
    for (const s of systems) expect(s.id.split('.')[0], s.id).toBe(s.doctrine);
  });

  it('fiches complètes : sheet, prix, ère, libellé et champs optionnels explicitement renseignés', () => {
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
      'unitPriceUsd',
      'era',
      'unitLabel',
    ];
    for (const s of raw)
      for (const k of required) expect(s, `${String(s.id)}.${k}`).toHaveProperty(k);
  });

  it('prix en dollars : cost.money = prix unitaire × unitSize, entretien et ressources positifs', () => {
    for (const s of systems) {
      expect(s.unitPriceUsd, s.id).toBeGreaterThan(0);
      expect(s.cost.money, s.id).toBe(s.unitPriceUsd! * s.unitSize);
      expect(s.upkeepPerDay, s.id).toBeGreaterThan(0);
      // Entretien annuel ≈ coût de possession : entre 0,3 % et 400 % du prix (l'infanterie paie ses soldes).
      const yearly = s.upkeepPerDay * 365;
      expect(yearly / s.cost.money, s.id).toBeGreaterThan(0.003);
      expect(yearly / s.cost.money, s.id).toBeLessThan(4);
      expect(Object.keys(s.cost.resources).length, s.id).toBeGreaterThan(0);
      expect(s.buildTimeH, s.id).toBeGreaterThan(0);
    }
  });

  it('ordres de grandeur des prix (dollars US actuels)', () => {
    const price = (id: string) => byId.get(id)!.unitPriceUsd!;
    const within = (id: string, lo: number, hi: number) => {
      expect(price(id), id).toBeGreaterThanOrEqual(lo);
      expect(price(id), id).toBeLessThanOrEqual(hi);
    };
    within('us.f-35', 70e6, 110e6);
    within('ru.su-57', 30e6, 60e6);
    within('eu.rafale', 90e6, 140e6);
    within('ru.t-90m', 3e6, 7e6);
    within('eu.leopard-2a7', 8e6, 15e6);
    within('ru.s-400', 300e6, 800e6);
    within('us.arleigh-burke', 1.8e9, 2.6e9);
    within('us.virginia', 2.8e9, 4.6e9);
    within('us.tomahawk', 1.5e6, 2.5e6);
    within('us.gerald-r-ford', 10e9, 16e9);
    within('us.infantry-light', 5e6, 60e6);
  });

  it('délais de production hiérarchisés', () => {
    const h = (id: string) => byId.get(id)!.buildTimeH;
    expect(h('us.f-35')).toBeGreaterThan(2 * h('us.m1a2-abrams'));
    expect(h('us.arleigh-burke')).toBeGreaterThan(3 * h('us.f-35'));
    expect(h('us.gerald-r-ford')).toBeGreaterThan(2 * h('us.arleigh-burke'));
    expect(h('us.virginia')).toBeGreaterThan(h('us.arleigh-burke'));
    expect(h('us.tomahawk')).toBeLessThan(h('us.m1a2-abrams'));
  });

  it('milieux : aéronefs en vol, unités terrestres au sol, navires en mer', () => {
    for (const s of systems) {
      if (AIR.includes(s.category)) {
        expect(s.movement, s.id).toBe('air');
        expect(s.operationalRadiusKm, s.id).toBeGreaterThan(0);
        expect(s.air?.fuelH, s.id).toBeGreaterThan(0);
      }
      if (LAND.includes(s.category)) {
        expect(s.movement, s.id).toBe('land');
        expect(s.operationalRadiusKm, s.id).toBeNull();
      }
      if (s.category === 'surface_ship' || s.category === 'submarine') {
        expect(s.movement, s.id).toBe('sea');
        expect(s.naval, s.id).toBeDefined();
        expect(s.naval!.submerged, s.id).toBe(s.category === 'submarine');
      }
      if (s.category === 'strike_missile' || s.category === 'nuclear') {
        expect(s.movement, s.id).toBe('air');
        expect(s.targetClass, s.id).toBe('missile');
        expect(s.missile, s.id).toBeDefined();
      }
      if (s.category === 'space' && !s.roles.includes('asat')) {
        expect(s.space, s.id).toBeDefined();
        expect(s.sensor, s.id).toBeDefined();
      }
      expect(s.weaponRangeKm.max, s.id).toBeGreaterThanOrEqual(s.weaponRangeKm.min);
    }
  });

  it('toutes les troupes terrestres capturent (infanterie, chars, véhicules, artillerie), jamais DCA ni missiles', () => {
    for (const s of systems) {
      expect(s.canCapture, s.id).toBe(captureByRule(s));
      if (s.canCapture)
        expect(['infantry', 'tank', 'ifv', 'artillery'], s.id).toContain(s.category);
      if (['air_defense', 'strike_missile', 'nuclear', 'radar', 'logistics'].includes(s.category))
        expect(s.canCapture, s.id).toBe(false);
      if (s.movement !== 'land') expect(s.canCapture, s.id).toBe(false);
      if (s.category === 'infantry') {
        expect(s.canCapture, s.id).toBe(true);
        expect(s.unitLabel, s.id).toBe('bataillon');
        expect(s.unitSize, s.id).toBe(1);
      }
    }
    for (const d of DOCTRINES) {
      expect(
        systems.some((s) => s.category === 'infantry' && s.doctrine === d),
        d,
      ).toBe(true);
    }
  });

  it('nucléaire jamais exportable ; logistique non combattante ; radars sans armes', () => {
    for (const s of systems.filter((x) => x.category === 'nuclear')) {
      expect(s.exportable, s.id).toBe(false);
      expect(s.licensable, s.id).toBe(false);
      expect(s.missile?.warhead, s.id).toBe('nuclear');
    }
    for (const s of systems.filter((x) => x.missile?.warhead === 'nuclear')) {
      expect(s.category, s.id).toBe('nuclear');
    }
    for (const s of systems.filter((x) => isCat(x, 'logistics') || isCat(x, 'radar'))) {
      expect(
        Object.values(s.damage).every((v) => v === 0),
        s.id,
      ).toBe(true);
      expect(s.canCapture, s.id).toBe(false);
    }
    for (const s of systems.filter((x) => x.category === 'logistics')) {
      expect(s.exportable, s.id).toBe(false);
    }
    for (const s of systems.filter((x) => isCat(x, 'radar'))) {
      expect(s.sensor, s.id).toBeDefined();
      expect(s.detectionRangeKm, s.id).toBe(s.sensor!.rangeKm);
    }
  });

  it('les capteurs spécialisés existent : guet aérien, radars anti-furtifs, sonars, satellites', () => {
    const sensorKinds = new Set(systems.map((s) => s.sensor?.kind).filter(Boolean));
    for (const k of ['radar', 'aew', 'sonar', 'optical', 'sigint', 'satellite', 'early_warning'])
      expect(sensorKinds.has(k as never), k).toBe(true);
    expect(systems.some((s) => (s.sensor?.stealthDetect ?? 0) >= 0.5)).toBe(true);
    expect(systems.filter((s) => s.air?.tankerFuelH).length).toBeGreaterThanOrEqual(4);
  });
  it('noms sans pays de doctrine entre parenthèses ; systèmes génériques marqués', () => {
    const country = / \((États-Unis|Russie|Chine|Europe|Inde|générique|Israël|France|Iran)\)$/;
    for (const s of systems) expect(s.name, s.id).not.toMatch(country);
    // Infanterie, satellites et brouilleurs : même nom pour chaque doctrine, doctrine en badge.
    for (const s of systems.filter((x) => x.category === 'infantry'))
      expect(s.generic, s.id).toBe(true);
    expect(systems.filter((s) => s.generic).length).toBeGreaterThanOrEqual(40);
  });
});

describe('chasseurs et multirôles (catégorie validée)', () => {
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

describe('table des contre-mesures', () => {
  /** Systèmes qui infligent au moins `min` dégâts par round à la classe visée. */
  const strong = (target: keyof WeaponSystem['damage'], min: number) =>
    systems.filter((s) => s.damage[target] >= min);
  const cats = (list: WeaponSystem[]) => new Set(list.map((s) => s.category));
  const units = systems.filter((s) => !isMunition(s));

  it('infanterie ← blindés, artillerie, aviation', () => {
    const c = cats(strong('infantry', 8));
    for (const k of ['tank', 'ifv', 'artillery', 'helicopter'] as const)
      expect(c.has(k), k).toBe(true);
    expect(cats(strong('infantry', 5)).has('drone')).toBe(true);
  });
  it('blindés ← antichar, hélicoptères, drones', () => {
    const c = cats(strong('armor', 8));
    for (const k of ['tank', 'helicopter', 'drone', 'infantry'] as const)
      expect(c.has(k), k).toBe(true);
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
    expect(jammers.length).toBeGreaterThanOrEqual(3);
    const top = [...units].sort((a, b) => b.damage.drone - a.damage.drone).slice(0, 3);
    expect(top.every((s) => s.roles.includes('short_range_sam'))).toBe(true);
  });
  it('défense aérienne ← brouillage (résistance limitée), saturation (peu de PV), antiradar', () => {
    for (const s of systems.filter((x) => x.roles.includes('long_range_sam'))) {
      expect(s.ew.jamResistance, s.id).toBeLessThanOrEqual(0.5);
      expect(s.hp, s.id).toBeLessThan(30);
    }
    const arm = systems.filter((s) => s.missile?.kind === 'antiradiation');
    expect(arm.length).toBeGreaterThanOrEqual(2);
    for (const s of arm) expect(s.damage.armor, s.id).toBeGreaterThanOrEqual(15);
  });
  it('les chars ne touchent ni avions ni drones', () => {
    for (const s of systems.filter((x) => x.category === 'tank')) {
      expect(s.damage.aircraft + s.damage.drone, s.id).toBe(0);
    }
  });
  it('avions et bombardiers ← chasseurs et défense aérienne à longue portée', () => {
    expect(fighters.filter((s) => s.damage.aircraft >= 14).length).toBeGreaterThan(5);
    expect(strong('aircraft', 18).some((s) => s.roles.includes('long_range_sam'))).toBe(true);
    for (const s of systems.filter((x) => x.category === 'bomber'))
      expect(s.damage.aircraft, s.id).toBe(0);
  });
  it('navires ← sous-marins, missiles antinavires, aviation maritime', () => {
    const c = cats(strong('ship', 20));
    for (const k of ['submarine', 'strike_missile', 'surface_ship'] as const)
      expect(c.has(k), k).toBe(true);
    expect(systems.some((s) => s.category === 'bomber' && s.damage.ship >= 15)).toBe(true);
  });
  it('sous-marins ← lutte anti-sous-marine (navires, hélicoptères, sous-marins, patrouille maritime)', () => {
    const c = cats(strong('submarine', 10));
    for (const k of ['surface_ship', 'helicopter', 'submarine', 'air_support'] as const)
      expect(c.has(k), k).toBe(true);
    for (const s of systems.filter((x) => ['fighter', 'tank', 'artillery'].includes(x.category)))
      expect(s.damage.submarine, s.id).toBe(0);
    for (const s of systems.filter((x) => x.category === 'submarine'))
      expect(s.stealth, s.id).toBeGreaterThanOrEqual(0.7);
  });
  it('missiles ← intercepteurs (croisière, balistiques, hypersoniques)', () => {
    const against = (k: string) =>
      systems.filter((s) => s.interceptor?.against.includes(k as never));
    expect(against('cruise').length).toBeGreaterThan(10);
    expect(against('ballistic').length).toBeGreaterThan(5);
    expect(against('hypersonic').length).toBeGreaterThanOrEqual(1);
    expect(against('drone').length).toBeGreaterThan(5);
    for (const s of systems.filter((x) => x.interceptor))
      expect(s.damage.missile + s.damage.drone + s.damage.aircraft, s.id).toBeGreaterThan(0);
    // Les hypersoniques sont les plus difficiles à intercepter.
    for (const s of systems.filter((x) => x.missile?.kind === 'hypersonic'))
      expect(s.missile!.evasion, s.id).toBeGreaterThanOrEqual(0.85);
  });
  it('satellites ← armes antisatellites', () => {
    const asat = systems.filter((s) => s.roles.includes('asat'));
    expect(asat.length).toBeGreaterThanOrEqual(3);
    for (const s of asat) expect(s.damage.missile, s.id).toBeGreaterThan(0);
  });
});

describe('data/research', () => {
  it('fichiers valides, un par branche, 80 à 120 nœuds', () => {
    expect(researchErrors).toEqual([]);
    expect(researchFiles).toEqual([...RESEARCH_BRANCHES].map((b) => `${b}.json`).sort());
    for (const n of nodes) expect(n.file, n.id).toBe(`${n.branch}.json`);
    expect(nodes.length).toBeGreaterThanOrEqual(80);
    expect(nodes.length).toBeLessThanOrEqual(120);
    expect(nodeById.size).toBe(nodes.length);
  });

  it('toutes les portes du brief existent', () => {
    for (const g of GATES) expect(nodeById.has(g), g).toBe(true);
  });

  it('prérequis existants, sans cycle, ère et rang cohérents', () => {
    for (const n of nodes) {
      for (const r of n.requires) {
        const p = nodeById.get(r);
        expect(p, `${n.id} → ${r}`).toBeDefined();
        expect(p!.eraYear ?? 0, `${n.id} → ${r}`).toBeLessThanOrEqual(n.eraYear ?? 9999);
        if (p!.branch === n.branch) expect(p!.tier, `${n.id} → ${r}`).toBeLessThan(n.tier);
      }
    }
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, path: string[]) => {
      if (state.get(id) === 2) return;
      expect(state.get(id), `cycle : ${[...path, id].join(' → ')}`).not.toBe(1);
      state.set(id, 1);
      for (const r of nodeById.get(id)?.requires ?? []) visit(r, [...path, id]);
      state.set(id, 2);
    };
    for (const n of nodes) visit(n.id, []);
  });

  it('coûts en dollars réalistes et effets reconnus', () => {
    for (const n of nodes) {
      expect(n.cost.money, n.id).toBeGreaterThanOrEqual(50e6);
      expect(n.eraYear, n.id).toBeDefined();
      for (const k of Object.keys(n.effects))
        expect(MODIFIER_KEYS as readonly string[], `${n.id} : ${k}`).toContain(k);
    }
    // Une génération de chasseur coûte des milliards.
    expect(nodeById.get('research.aero.gen5')!.cost.money).toBeGreaterThanOrEqual(10e9);
    expect(nodeById.get('research.aero.gen4')!.cost.money).toBeGreaterThanOrEqual(1e9);
    expect(nodes.filter((n) => Object.keys(n.effects).length > 0).length).toBeGreaterThanOrEqual(
      35,
    );
  });

  it('chaque système exige des portes existantes', () => {
    for (const s of systems)
      for (const r of s.requires) expect(nodeById.has(r), `${s.id} → ${r}`).toBe(true);
    const logistics = systems.filter((s) => s.category === 'logistics');
    for (const s of logistics) expect(s.requires, s.id).toEqual([]);
    for (const s of systems.filter((x) => x.category === 'nuclear'))
      expect(
        s.requires.some((r) => r.startsWith('research.nuclear.')),
        s.id,
      ).toBe(true);
  });
});

describe('ères (scénario Guerre froide 1985)', () => {
  it('années d’entrée en service plausibles', () => {
    for (const s of systems) {
      expect(s.era!.introduced, s.id).toBeGreaterThanOrEqual(1940);
      expect(s.era!.introduced, s.id).toBeLessThanOrEqual(2030);
      if (s.era!.retired !== undefined)
        expect(s.era!.retired, s.id).toBeGreaterThan(s.era!.introduced);
    }
  });

  it('un système disponible en 1985 se produit avec la technologie de 1985', () => {
    for (const s of systems.filter((x) => x.era!.introduced <= 1985)) {
      for (const r of s.requires)
        expect(nodeById.get(r)?.eraYear ?? 0, `${s.id} → ${r}`).toBeLessThanOrEqual(1985);
    }
  });

  it('en 1985 : pas de 5e génération, et chaque grand bloc a de quoi se battre', () => {
    const y85 = systems.filter((s) => s.era!.introduced <= 1985);
    expect(y85.some((s) => s.category === 'fighter' && s.generation === 5)).toBe(false);
    for (const d of ['us', 'ru'] as const) {
      for (const c of [
        'fighter',
        'tank',
        'ifv',
        'artillery',
        'air_defense',
        'submarine',
        'nuclear',
      ])
        expect(
          y85.some((s) => s.doctrine === d && s.category === c),
          `${d} ${c}`,
        ).toBe(true);
    }
  });
});

describe('data/balance', () => {
  const balances = jsonFiles('balance').map((f) => ({
    f,
    b: BalanceSchema.parse(readJson(join(DATA, 'balance', f))),
  }));
  const b: Balance = balances.find((x) => x.f === 'default.json')!.b;

  it('default.json existe et respecte BalanceSchema', () => {
    expect(balances.map((x) => x.f)).toContain('default.json');
  });

  it('les armées de départ n’utilisent que des systèmes du catalogue', () => {
    for (const { f, b: bal } of balances) {
      for (const u of [...bal.startingArmy, ...bal.garrisonArmy]) {
        expect(byId.has(u.systemId), `${f} : ${u.systemId}`).toBe(true);
      }
    }
  });

  it('réglages de temps et de victoire dans les plages prévues', () => {
    expect(b.time.combatRoundMinutes).toBeGreaterThanOrEqual(15);
    expect(b.time.combatRoundMinutes).toBeLessThanOrEqual(30);
    expect(b.time.captureMinutes).toBeGreaterThanOrEqual(60);
    expect(b.time.captureMinutes).toBeLessThanOrEqual(120);
    expect(b.victory.provinceShare).toBeGreaterThan(0.5);
    const cost = (list: Balance['startingArmy']) =>
      list.reduce((a, u) => a + byId.get(u.systemId)!.cost.money * u.count, 0);
    expect(cost(b.garrisonArmy)).toBeLessThan(cost(b.startingArmy) / 3);
    // Trésorerie de repli (nation sans ORBAT) : quelques achats, en dollars.
    expect(b.economy.startingMoney).toBeGreaterThan(byId.get('us.f-16')!.cost.money * 3);
    expect(b.economy.startingMoney).toBeLessThan(cost(b.startingArmy) * 10);
  });

  it('sections des phases 2+ renseignées (dollars)', () => {
    expect(b.money?.currency).toBe('USD');
    expect(b.money!.budgetPerDayFraction).toBeCloseTo(1 / 365, 6);
    for (const k of [
      'research',
      'licences',
      'blackMarket',
      'logistics',
      'mobilization',
      'buildings',
      'alert',
      'intel',
      'diplomacy',
      'stability',
    ] as const)
      expect(b[k], k).toBeDefined();
  });

  it('opérations de renseignement : toutes chiffrées en dollars', () => {
    // Toutes les opérations du protocole (profondeur SIGINT, HUMINT, militaire, intérieur comprise).
    expect(Object.keys(b.intel!.ops).sort()).toEqual([...INTEL_OPS].sort());
    for (const [k, op] of Object.entries(b.intel!.ops)) {
      expect(op.money, k).toBeGreaterThanOrEqual(1e6);
      expect(op.baseSuccess, k).toBeGreaterThan(0);
      expect(op.baseSuccess, k).toBeLessThanOrEqual(1);
      expect(op.exposure, k).toBeGreaterThanOrEqual(0);
      expect(op.durationH, k).toBeGreaterThan(0);
    }
    // Reconnaissance d'un pays entier : plus chère et plus longue qu'une province, en phases.
    const rn = b.intel!.reconNation!;
    for (const k of ['recon_economic', 'recon_military'] as const) {
      const op = rn.ops[k]!;
      expect(op.money, k).toBeGreaterThan(b.intel!.ops[k]!.money);
      expect(op.durationH, k).toBeGreaterThan(b.intel!.ops[k]!.durationH);
      expect(op.baseSuccess, k).toBeGreaterThan(0);
      expect(op.baseSuccess, k).toBeLessThanOrEqual(1);
    }
    expect(rn.waves).toBeGreaterThanOrEqual(2);
    expect(rn.provincesPerWave).toBeGreaterThanOrEqual(1);
  });

  it('bâtiments : chaque type a 5 niveaux au coût et à la durée croissants', () => {
    const bl = b.buildings!;
    for (const t of BUILDING_TYPES) {
      const levels = bl.levels[t];
      expect(levels, t).toBeDefined();
      expect(
        levels!.map((l) => l.level),
        t,
      ).toEqual([1, 2, 3, 4, 5]);
      expect(bl.buildCostUsd[t], t).toBe(levels![0]!.costUsd);
      expect(bl.buildHours[t], t).toBe(levels![0]!.buildHours);
      expect(bl.effects[t], t).toEqual(levels![0]!.effects);
      expect(levels![0]!.costUsd, t).toBeGreaterThanOrEqual(1e6);
      for (let i = 1; i < 5; i++) {
        expect(levels![i]!.costUsd, t).toBeGreaterThan(levels![i - 1]!.costUsd);
        expect(levels![i]!.buildHours, t).toBeGreaterThanOrEqual(levels![i - 1]!.buildHours);
        expect(Object.keys(levels![i]!.effects), t).toEqual(Object.keys(levels![0]!.effects));
      }
    }
  });
});

describe('data/scenarios', () => {
  const files = jsonFiles('scenarios');
  const nations = new Set(
    (readJson(join(DATA, 'map/nations.json')) as { id: string }[]).map((n) => n.id),
  );
  const scenarios = files.map((f) => ({
    f,
    s: ScenarioFileSchema.parse(readJson(join(DATA, 'scenarios', f))),
  }));

  it('scénarios attendus, valides, nations existantes', () => {
    expect(files).toEqual(
      ['cold-war-1985', 'eastern-europe', 'middle-east', 'pacific', 'world-today'].map(
        (x) => `${x}.json`,
      ),
    );
    for (const { f, s } of scenarios) {
      expect(s.id, f).toBe(f.replace(/\.json$/, ''));
      expect(s.name.length, f).toBeGreaterThan(0);
      expect(s.description.length, f).toBeGreaterThan(20);
      for (const n of s.nationIds ?? []) expect(nations.has(n), `${f} : ${n}`).toBe(true);
      const p = s.playableNations;
      if (Array.isArray(p)) for (const n of p) expect(nations.has(n), `${f} : ${n}`).toBe(true);
      expect(s.camera, f).toBeDefined();
    }
  });

  it('Guerre froide : année 1985, ORBAT 1985 ; les autres : 2025', () => {
    for (const { s } of scenarios) {
      if (s.id === 'cold-war-1985') {
        expect(s.year).toBe(1985);
        expect(s.orbatSet).toBe('1985');
      } else {
        expect(s.year, s.id).toBe(2025);
        expect(s.orbatSet, s.id).toBe('2025');
      }
    }
  });
});

/** Clés répétées dans un même objet JSON (JSON.parse garde la dernière en silence). */
function duplicateKeys(text: string): string[] {
  const stack: Set<string>[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const str = text.slice(i + 1, j);
      i = j + 1;
      let k = i;
      while (/\s/.test(text[k] ?? '')) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top) {
        if (top.has(str)) out.push(str);
        top.add(str);
      }
      continue;
    }
    if (c === '{') stack.push(new Set());
    else if (c === '}') stack.pop();
    i++;
  }
  return out;
}

describe('fichiers JSON de data/', () => {
  it('aucune clé dupliquée (une section écrasée en silence, ex. military)', () => {
    expect(duplicateKeys('{"a":{"b":1},"c":[{"b":2}],"a":3}')).toEqual(['a']);
    for (const dir of ['balance', 'catalog', 'research', 'scenarios']) {
      for (const f of jsonFiles(dir)) {
        const text = readFileSync(join(DATA, dir, f), 'utf8');
        expect(duplicateKeys(text), `${dir}/${f}`).toEqual([]);
      }
    }
  });
});
