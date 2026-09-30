/** Revenus, bâtiments génériques et couleurs des nations (tout est déterministe). */
import type { BuildingType } from '@redline/shared';
import { ECONOMY, PALETTE } from './config.js';
import { hash01, round } from './geo.js';

export interface EcoInput {
  id: string;
  nation: string;
  area: number;
  pop: number;
  gdp: number;
  gdpPerCap: number; // dollars par habitant
  lat: number;
  coastal: boolean;
  hasCity: boolean;
  isCapital: boolean;
  borderForeign: boolean;
}

export interface Income {
  money: number;
  oil?: number;
  metals?: number;
  electronics?: number;
  food?: number;
}

const vary = (id: string, salt: string, spread: number) =>
  1 - spread + 2 * spread * hash01(`${id}:${salt}`);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function income(p: EcoInput): Income {
  const money = clamp(
    Math.round(
      (ECONOMY.moneyBase + ECONOMY.moneyPerSqrtGdp * Math.sqrt(p.gdp)) *
        vary(p.id, 'money', ECONOMY.variation),
    ),
    ECONOMY.moneyMin,
    ECONOMY.moneyMax,
  );
  const inc: Income = { money };
  // Pétrole : facteur national, superficie, et une part de provinces sans gisement.
  const oilF = ECONOMY.oilFactor[p.nation] ?? ECONOMY.oilDefault;
  const hasOil = hash01(`${p.id}:oilp`) < Math.min(0.9, 0.15 + oilF);
  if (hasOil) {
    const v =
      55 * oilF * Math.sqrt(Math.min(p.area, 400_000) / 50_000 + 0.2) * vary(p.id, 'oil', 0.5);
    if (v >= 1) inc.oil = clamp(Math.round(v), 1, 80);
  }
  // Métaux : surtout la superficie.
  if (hash01(`${p.id}:metp`) < 0.7) {
    const v = 7 * Math.sqrt(Math.min(p.area, 600_000) / 10_000) * vary(p.id, 'metals', 0.6);
    if (v >= 1) inc.metals = clamp(Math.round(v), 1, 60);
  }
  // Électronique : PIB de la province pondéré par le niveau de vie.
  const tech = clamp(p.gdpPerCap / 40_000, 0.05, 1.2);
  const el = 0.12 * Math.sqrt(p.gdp) * tech * vary(p.id, 'elec', 0.3);
  if (el >= 1) inc.electronics = clamp(Math.round(el), 1, 60);
  // Nourriture : population et superficie, moins aux très hautes latitudes.
  const cold = Math.abs(p.lat) > 60 ? 0.3 : Math.abs(p.lat) > 50 ? 0.7 : 1;
  const fd =
    (4 * Math.sqrt(p.pop / 100_000) + 3 * Math.sqrt(Math.min(p.area, 300_000) / 20_000) * cold) *
    vary(p.id, 'food', 0.3);
  if (fd >= 1) inc.food = clamp(Math.round(fd), 1, 80);
  return inc;
}

/** Bâtiments génériques. Rang = rang de PIB de la province dans sa nation (0 = premier). */
export function buildings(
  p: EcoInput,
  inc: Income,
  rank: number,
  nationSize: number,
): BuildingType[] {
  const b = new Set<BuildingType>();
  if (p.isCapital) {
    b.add('military_base');
    b.add('air_base');
    b.add('research_center');
    b.add('power_plant');
  }
  if (p.coastal && p.hasCity) b.add('port');
  if ((inc.oil ?? 0) >= 20) b.add('refinery');
  const topShare = rank / Math.max(1, nationSize);
  if (topShare < 0.2 || (rank < 2 && nationSize >= 3)) b.add('power_plant');
  if (
    (rank < Math.max(1, Math.round(nationSize * 0.1)) && nationSize >= 3) ||
    (rank === 0 && p.gdp > 20_000)
  )
    b.add('arms_factory');
  if (p.gdpPerCap > 20_000 && rank > 0 && rank < Math.max(1, Math.round(nationSize * 0.05)))
    b.add('research_center');
  if (p.borderForeign && hash01(`${p.id}:mil`) < 0.35) b.add('military_base');
  if (hash01(`${p.id}:air`) < 0.12 + Math.min(0.2, p.area / 2_000_000)) b.add('air_base');
  const order: BuildingType[] = [
    'refinery',
    'power_plant',
    'port',
    'air_base',
    'military_base',
    'arms_factory',
    'research_center',
  ];
  return order.filter((t) => b.has(t));
}

// ---------------------------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return round(h, 1);
}

/**
 * Coloration du graphe de voisinage des nations (DSatur) : deux voisins n'ont jamais la même
 * couleur ; parmi les couleurs permises, on prend la moins utilisée (égalité → hachage de l'id).
 */
export function colorNations(
  ids: string[],
  neighbors: Map<string, Set<string>>,
): Map<string, string> {
  const color = new Map<string, number>();
  const usage = new Array(PALETTE.length).fill(0) as number[];
  const sorted = [...ids].sort();
  while (color.size < sorted.length) {
    // nœud de saturation maximale, puis de degré maximal, puis id
    let best: string | undefined;
    let bs = -1,
      bd = -1;
    for (const id of sorted) {
      if (color.has(id)) continue;
      const nb = neighbors.get(id) ?? new Set();
      const sat = new Set([...nb].map((n) => color.get(n)).filter((c) => c !== undefined)).size;
      if (sat > bs || (sat === bs && nb.size > bd)) {
        best = id;
        bs = sat;
        bd = nb.size;
      }
    }
    const id = best!;
    const forbidden = new Set([...(neighbors.get(id) ?? [])].map((n) => color.get(n)));
    let pick = -1;
    let pickKey = Infinity;
    for (let c = 0; c < PALETTE.length; c++) {
      if (forbidden.has(c)) continue;
      const key = usage[c]! + hash01(`${id}:${c}`) * 0.9;
      if (key < pickKey) {
        pickKey = key;
        pick = c;
      }
    }
    if (pick < 0) throw new Error(`palette insuffisante pour ${id}`);
    color.set(id, pick);
    usage[pick]!++;
  }
  return new Map([...color].map(([id, c]) => [id, PALETTE[c]!]));
}
