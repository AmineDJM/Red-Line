/**
 * Validation des ORBAT (data/orbat/<jeu>/<nation>.json).
 *
 * Contrôles : schéma OrbatSchema, nation existante et nom de fichier cohérent, identifiants de systèmes et de
 * licences présents dans data/catalog-ids.json, portes de recherche connues (data/research) et fermées par
 * prérequis, époque (era / eraYear) pour les jeux historiques, couverture des 201 nations en 2025, textes de
 * l'écran de sélection, matériel naval des pays enclavés, nucléaire réservé aux puissances dotées.
 * Affiche les totaux par nation, la somme mondiale des budgets et le nombre total d'éléments par famille.
 *
 * Usage : pnpm --filter @redline/tools-orbat validate [-- --set 2025] [-- --nations]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogFileSchema,
  OrbatSchema,
  ResearchFileSchema,
  type Category,
  type Orbat,
  type ResearchNode,
  type WeaponSystem,
} from '@redline/shared';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA = join(ROOT, 'data');

/** Portes de recherche fixes du brief (docs/agents-brief-v2.md). */
const GATES = `
research.aero.gen2 research.aero.gen3 research.aero.gen4 research.aero.gen4plus research.aero.gen5
research.aero.bomber1 research.aero.bomber2 research.aero.stealth-bomber
research.aero.helo1 research.aero.helo2 research.aero.helo3
research.aero.drones1 research.aero.drones2 research.aero.drones3
research.aero.aew research.aero.tanker research.aero.transport
research.land.gen1 research.land.gen2 research.land.gen3 research.land.gen4 research.land.gen5
research.land.mlrs research.land.ew
research.naval.gen1 research.naval.gen2 research.naval.gen3 research.naval.gen4 research.naval.gen5
research.naval.carrier research.naval.sub1 research.naval.sub2 research.naval.sub3 research.naval.ssbn
research.missiles.sam1 research.missiles.sam2 research.missiles.sam3 research.missiles.sam4 research.missiles.sam5
research.missiles.abm research.missiles.cruise1 research.missiles.cruise2 research.missiles.antiship
research.missiles.ballistic1 research.missiles.ballistic2 research.missiles.ballistic3 research.missiles.hypersonic
research.nuclear.weapons research.nuclear.icbm research.nuclear.slbm
research.sensors.radar1 research.sensors.radar2 research.sensors.radar3 research.sensors.space1
research.sensors.space2 research.sensors.asat research.cyber.l1 research.cyber.l2 research.cyber.l3
research.intel.interior1 research.intel.interior2 research.intel.interior3 research.intel.exterior1
research.intel.exterior2 research.intel.exterior3 research.intel.military1 research.intel.military2
research.intel.military3 research.industry.l1 research.industry.l2 research.industry.l3
`
  .split(/\s+/)
  .filter(Boolean);

/** Familles d'affichage (catégories du catalogue). */
const FAMILIES: Record<Category, string> = {
  fighter: 'Chasseurs',
  bomber: 'Bombardiers',
  air_support: 'Appui et soutien aériens',
  helicopter: 'Hélicoptères',
  drone: 'Drones',
  tank: 'Chars',
  ifv: 'VCI / VTT',
  artillery: 'Artillerie',
  air_defense: 'Défense aérienne',
  strike_missile: 'Missiles de frappe',
  nuclear: 'Vecteurs nucléaires',
  surface_ship: 'Navires de surface',
  submarine: 'Sous-marins',
  infantry: 'Infanterie (bataillons)',
  space: 'Satellites',
  logistics: 'Logistique',
  radar: 'Radars',
} as Record<Category, string>;

const NAVAL = new Set<string>(['surface_ship', 'submarine']);

/** Bornes de la somme mondiale des budgets 2025 (SIPRI : 2 718 Md$ en 2024, 2 887 Md$ en 2025). */
const WORLD_BUDGET_WARN: [number, number] = [2.4e12, 3.0e12];
const WORLD_BUDGET_ERROR: [number, number] = [2.0e12, 3.5e12];

// ——— Chargement ———

interface CatalogIdEntry {
  id: string;
  name: string;
  category: string;
  doctrine: string;
}
interface NationEntry {
  id: string;
  name: string;
}
interface ProvinceEntry {
  nationId: string;
  coastal: boolean;
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

const catalogIds = new Map<string, CatalogIdEntry>(
  (readJson(join(DATA, 'catalog-ids.json')) as { systems: CatalogIdEntry[] }).systems.map((s) => [
    s.id,
    s,
  ]),
);

const catalog = new Map<string, WeaponSystem>();
const catalogDir = join(DATA, 'catalog');
if (existsSync(catalogDir)) {
  for (const f of readdirSync(catalogDir).filter((f) => f.endsWith('.json'))) {
    const parsed = CatalogFileSchema.safeParse(readJson(join(catalogDir, f)));
    if (parsed.success) for (const s of parsed.data.systems) catalog.set(s.id, s);
  }
}

const research = new Map<string, ResearchNode>();
const researchDir = join(DATA, 'research');
if (existsSync(researchDir)) {
  for (const f of readdirSync(researchDir).filter((f) => f.endsWith('.json'))) {
    const parsed = ResearchFileSchema.safeParse(readJson(join(researchDir, f)));
    if (parsed.success) for (const n of parsed.data.nodes) research.set(n.id, n);
  }
}

const nations = new Map<string, NationEntry>(
  (readJson(join(DATA, 'map', 'nations.json')) as NationEntry[]).map((n) => [n.id, n]),
);
const coastal = new Set<string>();
for (const p of readJson(join(DATA, 'map', 'provinces.json')) as ProvinceEntry[]) {
  if (p.coastal) coastal.add(p.nationId);
}

// ——— Arguments ———

const argv = process.argv.slice(2);
const onlySet = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : undefined;
const showNations = argv.includes('--nations');

// ——— Contrôles ———

const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);

const fmtUsd = (v: number) => {
  if (v >= 1e9) return `${(v / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Md$`;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} M$`;
  return `${(v / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} k$`;
};
const fmtInt = (v: number) => v.toLocaleString('fr-FR');

function checkOrbat(set: string, file: string, o: Orbat) {
  const where = `${set}/${file}`;
  const nid = file.replace(/\.json$/, '');
  if (o.nationId !== nid) err(`${where} : nationId « ${o.nationId} » ≠ nom de fichier`);
  if (!nations.has(o.nationId)) err(`${where} : nation inconnue « ${o.nationId} »`);
  if (/^\d{4}$/.test(set) && o.year !== Number(set)) err(`${where} : year ${o.year} ≠ jeu ${set}`);
  const year = o.year;

  for (const [i, it] of o.inventory.entries()) {
    const entry = catalogIds.get(it.systemId);
    if (!entry) {
      err(`${where} : inventaire[${i}] système inconnu « ${it.systemId} »`);
      continue;
    }
    if (it.count === 0) warn(`${where} : ${it.systemId} (${it.variant ?? ''}) a un effectif nul`);
    if (NAVAL.has(entry.category) && !coastal.has(o.nationId)) {
      err(`${where} : ${it.systemId} (navire) pour une nation sans côte`);
    }
    if (entry.category === 'nuclear' && !o.research.includes('research.nuclear.weapons')) {
      err(`${where} : vecteur nucléaire ${it.systemId} sans research.nuclear.weapons`);
    }
    const sys = catalog.get(it.systemId);
    if (!sys) {
      warn(`${where} : ${it.systemId} absent de data/catalog (présent dans catalog-ids.json)`);
    } else if (sys.era && sys.era.introduced > year && !(it.note ?? '').includes('plus proche')) {
      err(
        `${where} : ${it.systemId} introduit en ${sys.era.introduced} (> ${year}) sans mention « modèle le plus proche »`,
      );
    }
  }

  for (const l of o.licences) {
    if (!catalogIds.has(l)) err(`${where} : licence sur un système inconnu « ${l} »`);
  }

  const owned = new Set(o.research);
  for (const r of o.research) {
    const node = research.get(r);
    if (!node) {
      if (!GATES.includes(r)) err(`${where} : nœud de recherche inconnu « ${r} »`);
      else warn(`${where} : porte ${r} absente de data/research`);
      continue;
    }
    for (const req of node.requires) {
      if (!owned.has(req)) err(`${where} : ${r} acquis sans son prérequis ${req}`);
    }
    if (node.eraYear !== undefined && node.eraYear > year) {
      err(`${where} : ${r} (époque ${node.eraYear}) postérieur à ${year}`);
    }
  }
  if (!o.research.some((r) => GATES.includes(r)) && o.inventory.length > 0) {
    warn(`${where} : aucune porte de recherche du brief`);
  }

  if (set === '2025') {
    if (!o.description) err(`${where} : description manquante`);
    if (!o.doctrineText) err(`${where} : doctrineText manquant`);
    if (o.description) {
      const n = o.description.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
      if (n < 3 || n > 6) warn(`${where} : description de ${n} phrases (attendu 3 à 5)`);
    }
    if (o.sources.length === 0) err(`${where} : aucune source`);
  }
}

interface SetStats {
  nations: number;
  budget: number;
  personnel: number;
  families: Map<string, number>;
  perNation: { id: string; budget: number; personnel: number; elements: number; conf: string }[];
}

function checkSet(set: string): SetStats {
  const dir = join(DATA, 'orbat', set);
  const stats: SetStats = {
    nations: 0,
    budget: 0,
    personnel: 0,
    families: new Map(),
    perNation: [],
  };
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const parsed = OrbatSchema.safeParse(readJson(join(dir, file)));
    if (!parsed.success) {
      err(
        `${set}/${file} : schéma invalide — ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`,
      );
      continue;
    }
    const o = parsed.data;
    checkOrbat(set, file, o);
    stats.nations++;
    stats.budget += o.defenseBudgetUsd;
    stats.personnel += o.activePersonnel ?? 0;
    let elements = 0;
    for (const it of o.inventory) {
      const cat = catalogIds.get(it.systemId)?.category ?? 'inconnu';
      stats.families.set(cat, (stats.families.get(cat) ?? 0) + it.count);
      elements += it.count;
    }
    stats.perNation.push({
      id: o.nationId,
      budget: o.defenseBudgetUsd,
      personnel: o.activePersonnel ?? 0,
      elements,
      conf: o.confidence,
    });
  }
  if (set === '2025') {
    const present = new Set(stats.perNation.map((n) => n.id));
    const missing = [...nations.keys()].filter((n) => !present.has(n));
    if (missing.length) err(`2025 : ${missing.length} nations sans ORBAT (${missing.join(', ')})`);
    if (stats.budget < WORLD_BUDGET_ERROR[0] || stats.budget > WORLD_BUDGET_ERROR[1]) {
      err(`2025 : somme mondiale des budgets ${fmtUsd(stats.budget)} hors bornes`);
    } else if (stats.budget < WORLD_BUDGET_WARN[0] || stats.budget > WORLD_BUDGET_WARN[1]) {
      warn(`2025 : somme mondiale des budgets ${fmtUsd(stats.budget)} hors de la plage attendue`);
    }
  }
  return stats;
}

function report(set: string, s: SetStats) {
  console.log(`\n══ Jeu ${set} : ${s.nations} nations ══`);
  console.log(`Budget mondial        ${fmtUsd(s.budget)}`);
  console.log(`Effectifs d'active    ${fmtInt(s.personnel)}`);
  const total = [...s.families.values()].reduce((a, b) => a + b, 0);
  console.log(`Éléments (total)      ${fmtInt(total)}`);
  console.log('\nÉléments par famille');
  const order = Object.keys(FAMILIES) as Category[];
  for (const cat of [
    ...order,
    ...[...s.families.keys()].filter((c) => !order.includes(c as Category)),
  ]) {
    const n = s.families.get(cat);
    if (!n) continue;
    console.log(`  ${(FAMILIES[cat as Category] ?? cat).padEnd(28)} ${fmtInt(n).padStart(9)}`);
  }
  const conf = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const n of s.perNation) conf[n.conf] = (conf[n.conf] ?? 0) + 1;
  console.log(`\nConfiance : haute ${conf.high}, moyenne ${conf.medium}, faible ${conf.low}`);
  const sorted = [...s.perNation].sort((a, b) => b.budget - a.budget);
  const shown = showNations ? sorted : sorted.slice(0, 15);
  console.log(`\n${showNations ? 'Nations' : '15 premiers budgets'}`);
  console.log(
    `  ${'nation'.padEnd(8)}${'budget'.padStart(12)}${'effectifs'.padStart(12)}${'éléments'.padStart(11)}  confiance`,
  );
  for (const n of shown) {
    console.log(
      `  ${n.id.padEnd(8)}${fmtUsd(n.budget).padStart(12)}${fmtInt(n.personnel).padStart(12)}${fmtInt(n.elements).padStart(11)}  ${n.conf}`,
    );
  }
}

const orbatRoot = join(DATA, 'orbat');
const sets = readdirSync(orbatRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!onlySet || d.name === onlySet))
  .map((d) => d.name)
  .sort()
  .reverse();
if (sets.length === 0) err(`aucun jeu d'ORBAT dans ${orbatRoot}`);
for (const set of sets) report(set, checkSet(set));

if (warnings.length) {
  console.log(`\n${warnings.length} avertissement(s)`);
  for (const w of warnings.slice(0, 60)) console.log(`  ! ${w}`);
  if (warnings.length > 60) console.log(`  … et ${warnings.length - 60} autres`);
}
if (errors.length) {
  console.error(`\n${errors.length} erreur(s)`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\nORBAT valides.');
