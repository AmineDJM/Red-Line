/**
 * Mode démonstration : catalogue complet et arbre technologique plausibles, sans serveur.
 * - Les systèmes du catalogue sans prix réel reçoivent un prix en dollars estimé (démonstration).
 * - Les identifiants de data/catalog-ids.json absents du catalogue sont complétés par des fiches
 *   génériques (pour que l'arsenal et l'encyclopédie montrent toute la liste).
 * - Sans data/research, un arbre de démonstration est bâti sur les portes de recherche fixes.
 * Chiffres de démonstration uniquement : le jeu réel lit tout depuis data/ via le serveur.
 */
import {
  type Category,
  type Doctrine,
  type ResearchBranch,
  type ResearchNode,
  type TargetClass,
  type WeaponSystem,
} from '@redline/shared';
import { t } from '../i18n/index.js';

const idsFile = import.meta.glob('../../../../data/catalog-ids.json', { import: 'default' });

interface CatalogIdEntry {
  id: string;
  name: string;
  category: Category;
  doctrine: Doctrine;
  origin: string;
}

/** Prix unitaire de démonstration par catégorie (génération 4), en dollars. */
const DEMO_PRICE: Record<Category, number> = {
  fighter: 85e6,
  bomber: 420e6,
  air_support: 55e6,
  helicopter: 32e6,
  drone: 14e6,
  tank: 8.5e6,
  ifv: 3.8e6,
  artillery: 6e6,
  air_defense: 180e6,
  strike_missile: 4e6,
  nuclear: 60e6,
  surface_ship: 900e6,
  submarine: 1.6e9,
  infantry: 45e6,
  space: 450e6,
  logistics: 20e6,
  radar: 90e6,
};

const TARGET: Record<Category, TargetClass> = {
  fighter: 'aircraft',
  bomber: 'aircraft',
  air_support: 'aircraft',
  helicopter: 'helicopter',
  drone: 'drone',
  tank: 'armor',
  ifv: 'armor',
  artillery: 'armor',
  air_defense: 'armor',
  strike_missile: 'missile',
  nuclear: 'missile',
  surface_ship: 'ship',
  submarine: 'submarine',
  infantry: 'infantry',
  space: 'building',
  logistics: 'armor',
  radar: 'building',
};

const MOVE: Record<Category, WeaponSystem['movement']> = {
  fighter: 'air',
  bomber: 'air',
  air_support: 'air',
  helicopter: 'air',
  drone: 'air',
  tank: 'land',
  ifv: 'land',
  artillery: 'land',
  air_defense: 'land',
  strike_missile: 'static',
  nuclear: 'static',
  surface_ship: 'sea',
  submarine: 'sea',
  infantry: 'land',
  space: 'static',
  logistics: 'land',
  radar: 'static',
};

const SPEED: Record<Category, number> = {
  fighter: 1900,
  bomber: 950,
  air_support: 850,
  helicopter: 280,
  drone: 220,
  tank: 60,
  ifv: 65,
  artillery: 55,
  air_defense: 50,
  strike_missile: 0,
  nuclear: 0,
  surface_ship: 55,
  submarine: 40,
  infantry: 30,
  space: 0,
  logistics: 70,
  radar: 0,
};

const RANGE: Record<Category, number> = {
  fighter: 120,
  bomber: 2500,
  air_support: 30,
  helicopter: 8,
  drone: 12,
  tank: 4,
  ifv: 3,
  artillery: 40,
  air_defense: 120,
  strike_missile: 1500,
  nuclear: 9000,
  surface_ship: 250,
  submarine: 60,
  infantry: 2,
  space: 0,
  logistics: 0,
  radar: 0,
};

/** Génération estimée d'après le nom (démonstration). */
function guessGeneration(e: CatalogIdEntry): number {
  const n = e.name.toLowerCase();
  if (/f-35|f-22|su-57|j-20|j-35|b-21|kf-21|tempest|fcas|hypers|zircon|avangard|kinzhal/.test(n))
    return 5;
  if (/f-5|mig-21|mig-23|t-55|t-62|m60|f-4|mirage (iii|5|f1)|kilo|type 69/.test(n)) return 2;
  if (/f-16|f-15|su-27|mig-29|t-72|leopard 2a4|m1a1|mirage 2000/.test(n)) return 4;
  return e.category === 'infantry' || e.category === 'logistics' ? 3 : 4;
}

function synthesize(e: CatalogIdEntry): WeaponSystem {
  const gen = guessGeneration(e);
  const price = Math.round(DEMO_PRICE[e.category] * (0.55 + gen * 0.12));
  const unitSize = 1;
  const air = MOVE[e.category] === 'air';
  return {
    id: e.id,
    name: e.name,
    doctrine: e.doctrine,
    origin: e.origin,
    category: e.category,
    roles: [],
    generation: gen,
    targetClass: TARGET[e.category],
    movement: MOVE[e.category],
    canCapture: e.category === 'infantry' || e.category === 'ifv',
    cost: { money: price * unitSize, resources: {} },
    buildTimeH: Math.round(12 + gen * 10 + price / 25e6),
    upkeepPerDay: Math.round((price * 0.08) / 365),
    speedKmh: SPEED[e.category],
    operationalRadiusKm: air ? 600 + gen * 150 : null,
    weaponRangeKm: { min: 0, max: RANGE[e.category] },
    damage: {
      infantry: 4,
      armor: 4,
      aircraft: air ? 6 : 1,
      helicopter: 3,
      drone: 3,
      ship: 2,
      submarine: 1,
      missile: e.category === 'air_defense' ? 6 : 0,
      building: 3,
    },
    hp: 100,
    armor: 0.2,
    stealth: gen >= 5 ? 0.7 : 0,
    detectionRangeKm: air ? 150 : 40,
    ew: { jamming: 0, jamResistance: 0.2 },
    payload: { slots: 2 },
    unitSize,
    requires: [],
    licensable: true,
    exportable: true,
    icon: e.category,
    sheet: {
      engine: null,
      lengthM: null,
      wingspanM: null,
      mtowKg: null,
      warheadKg: null,
      speedLabel: SPEED[e.category] ? `${SPEED[e.category]} km/h` : null,
      rangeKm: air ? 1500 + gen * 300 : null,
    },
    enabled: true,
    unitPriceUsd: price,
  };
}

/** Porte de recherche plausible pour un système synthétique. */
function gateFor(s: WeaponSystem): string[] {
  const g = s.generation;
  switch (s.category) {
    case 'fighter':
    case 'air_support':
      return [`research.aero.${['gen2', 'gen2', 'gen3', 'gen4', 'gen4plus', 'gen5'][g] ?? 'gen4'}`];
    case 'bomber':
      return [
        g >= 5
          ? 'research.aero.stealth-bomber'
          : g >= 4
            ? 'research.aero.bomber2'
            : 'research.aero.bomber1',
      ];
    case 'helicopter':
      return [`research.aero.helo${Math.min(3, Math.max(1, g - 2))}`];
    case 'drone':
      return [`research.aero.drones${Math.min(3, Math.max(1, g - 2))}`];
    case 'tank':
    case 'ifv':
    case 'artillery':
      return [`research.land.gen${Math.min(5, Math.max(1, g))}`];
    case 'air_defense':
      return [`research.missiles.sam${Math.min(5, Math.max(1, g))}`];
    case 'strike_missile':
      return [g >= 5 ? 'research.missiles.hypersonic' : 'research.missiles.cruise1'];
    case 'nuclear':
      return ['research.nuclear.weapons'];
    case 'surface_ship':
      return [`research.naval.gen${Math.min(5, Math.max(1, g))}`];
    case 'submarine':
      return [`research.naval.sub${Math.min(3, Math.max(1, g - 2))}`];
    case 'space':
      return [g >= 5 ? 'research.sensors.space2' : 'research.sensors.space1'];
    case 'radar':
      return [`research.sensors.radar${Math.min(3, Math.max(1, g - 2))}`];
    default:
      return [];
  }
}

/** Convertit un catalogue exprimé en unités de jeu (phase 1) en dollars de démonstration. */
function toDollars(s: WeaponSystem): WeaponSystem {
  if (s.unitPriceUsd) return s;
  const unit = Math.round((s.cost.money / Math.max(1, s.unitSize)) * 60_000);
  return {
    ...s,
    unitPriceUsd: unit,
    cost: { ...s.cost, money: unit * s.unitSize },
    upkeepPerDay: Math.round((unit * s.unitSize * 0.08) / 365),
  };
}

export async function demoCatalog(base: WeaponSystem[]): Promise<WeaponSystem[]> {
  const out = base.map(toDollars);
  const have = new Set(out.map((s) => s.id));
  const load = Object.values(idsFile)[0];
  if (load) {
    const raw = (await load()) as { systems?: CatalogIdEntry[] };
    for (const e of raw.systems ?? []) {
      if (have.has(e.id)) continue;
      const s = synthesize(e);
      s.requires = gateFor(s);
      out.push(s);
    }
  }
  return out;
}

// ——— Arbre technologique de démonstration ———

type Line = { branch: ResearchBranch; keys: string[]; prefix?: string };

const LINES: Line[] = [
  { branch: 'aero', keys: ['gen2', 'gen3', 'gen4', 'gen4plus', 'gen5'] },
  { branch: 'aero', keys: ['bomber1', 'bomber2', 'stealth-bomber'] },
  { branch: 'aero', keys: ['helo1', 'helo2', 'helo3'] },
  { branch: 'aero', keys: ['drones1', 'drones2', 'drones3'] },
  { branch: 'aero', keys: ['aew', 'tanker', 'transport'] },
  { branch: 'land', keys: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5'] },
  { branch: 'land', keys: ['mlrs', 'ew'] },
  { branch: 'naval', keys: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'carrier'] },
  { branch: 'naval', keys: ['sub1', 'sub2', 'sub3', 'ssbn'] },
  { branch: 'missiles', keys: ['sam1', 'sam2', 'sam3', 'sam4', 'sam5', 'abm'] },
  { branch: 'missiles', keys: ['cruise1', 'cruise2', 'antiship'] },
  { branch: 'missiles', keys: ['ballistic1', 'ballistic2', 'ballistic3', 'hypersonic'] },
  { branch: 'missiles', keys: ['weapons', 'icbm', 'slbm'], prefix: 'nuclear' },
  { branch: 'sensors', keys: ['radar1', 'radar2', 'radar3'] },
  { branch: 'sensors', keys: ['space1', 'space2', 'asat'] },
  { branch: 'cyber', keys: ['l1', 'l2', 'l3'] },
  { branch: 'intel', keys: ['interior1', 'interior2', 'interior3'] },
  { branch: 'intel', keys: ['exterior1', 'exterior2', 'exterior3'] },
  { branch: 'intel', keys: ['military1', 'military2', 'military3'] },
  { branch: 'industry', keys: ['l1', 'l2', 'l3'] },
];

const EFFECTS: Record<string, Record<string, number>> = {
  'research.industry.l1': { 'production.speed': 1.1 },
  'research.industry.l2': { 'production.speed': 1.1, 'production.cost': 0.95 },
  'research.industry.l3': { 'production.speed': 1.15, 'income.money': 1.05 },
  'research.sensors.radar2': { 'sensors.radarRange': 1.15 },
  'research.sensors.radar3': { 'sensors.radarRange': 1.2, 'sensors.stealthDetect': 1.3 },
  'research.cyber.l2': { 'cyber.attack': 1.2, 'cyber.defense': 1.2 },
  'research.intel.exterior2': { 'intel.exterior.level': 1 },
  'research.intel.interior2': { 'intel.interior.level': 1 },
  'research.intel.military2': { 'intel.military.level': 1 },
  'research.missiles.abm': { 'missiles.interception': 1.25 },
  'research.aero.tanker': { 'air.range': 1.3 },
};

export function demoResearch(): ResearchNode[] {
  const nodes: ResearchNode[] = [];
  for (const line of LINES) {
    let prev: string | null = null;
    line.keys.forEach((k, i) => {
      const id = `research.${line.prefix ?? line.branch}.${k}`;
      const tier = i + (line.keys[0]?.endsWith('2') ? 1 : 0);
      nodes.push({
        id,
        name: t(`researchNodes.${id.replace(/^research\./, '').replace(/\./g, '_')}`, {
          defaultValue: id,
        }),
        description: t(`researchNodes.desc.${line.prefix ?? line.branch}`, { defaultValue: '' }),
        branch: line.branch,
        tier,
        cost: {
          money: Math.round((150e6 + tier * 260e6) / 1e6) * 1e6,
          resources: { electronics: 400 + tier * 300 },
        },
        durationH: 48 + tier * 60,
        requires: prev ? [prev] : [],
        effects: EFFECTS[id] ?? {},
      });
      prev = id;
    });
  }
  // Quelques dépendances croisées (lisibilité du graphe).
  const req = (id: string, r: string) => nodes.find((n) => n.id === id)?.requires.push(r);
  req('research.aero.gen5', 'research.sensors.radar2');
  req('research.aero.stealth-bomber', 'research.aero.gen5');
  req('research.naval.carrier', 'research.aero.gen4');
  req('research.missiles.hypersonic', 'research.missiles.cruise2');
  req('research.nuclear.icbm', 'research.missiles.ballistic3');
  req('research.nuclear.slbm', 'research.naval.ssbn');
  req('research.sensors.asat', 'research.missiles.ballistic2');
  req('research.aero.drones3', 'research.aero.gen5');
  return nodes;
}
