/**
 * Mode démonstration : sections des phases 2 à 6 de la PlayerView (recherche, marché, logistique,
 * opérations, rapports de bataille, généraux, renseignement, diplomatie, Conseil, stabilité,
 * actualité, bâtiments, connaissance des provinces) et historique de messagerie. Données
 * plausibles et cohérentes avec la carte ; aucune règle de jeu réelle.
 */
import {
  DAY,
  HOUR,
  MINUTE,
  destination,
  distanceKm,
  type AgentView,
  type AllianceView,
  type BattleReportSummary,
  type BuildingType,
  type BuildingView,
  type ChatMessage,
  type CouncilView,
  type DepartmentView,
  type DiplomacyView,
  type GameNotification,
  type GameTime,
  type GeneralView,
  type IntelOpView,
  type IntelReport,
  type LngLat,
  type MarketOffer,
  type NationDef,
  type NationId,
  type NewsItem,
  type OperationView,
  type PlayerView,
  type ProvinceDef,
  type ResearchView,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import type { EconomyDetails } from '../lib/economy.js';

export interface WorldCtx {
  me: NationId;
  now: GameTime;
  rnd: () => number;
  nations: NationDef[];
  provinces: ProvinceDef[];
  byNation: Map<NationId, ProvinceDef[]>;
  catalog: WeaponSystem[];
  hostiles: NationId[];
  capPt: LngLat;
  captureTarget?: ProvinceDef;
  threatened?: ProvinceDef;
}

export interface WorldExtras {
  chat: ChatMessage[];
  notes: GameNotification[];
}

/** Portes de recherche maîtrisées au départ (démonstration, niveau technologique moyen-haut). */
const DONE = [
  'research.aero.gen2',
  'research.aero.gen3',
  'research.aero.gen4',
  'research.aero.gen4plus',
  'research.aero.helo1',
  'research.aero.helo2',
  'research.aero.drones1',
  'research.aero.drones2',
  'research.aero.bomber1',
  'research.aero.transport',
  'research.land.gen1',
  'research.land.gen2',
  'research.land.gen3',
  'research.land.gen4',
  'research.land.mlrs',
  'research.naval.gen1',
  'research.naval.gen2',
  'research.naval.gen3',
  'research.naval.sub1',
  'research.naval.sub2',
  'research.missiles.sam1',
  'research.missiles.sam2',
  'research.missiles.sam3',
  'research.missiles.sam4',
  'research.missiles.cruise1',
  'research.missiles.antiship',
  'research.missiles.ballistic1',
  'research.sensors.radar1',
  'research.sensors.radar2',
  'research.sensors.space1',
  'research.cyber.l1',
  'research.intel.interior1',
  'research.intel.interior2',
  'research.intel.exterior1',
  'research.intel.military1',
  'research.industry.l1',
  'research.industry.l2',
];

const PLAYER_NAMES = ['Kestrel', 'Atlas_7', 'N0madSahel', 'VektorPrime', 'Mistral', 'Orca', 'Tariq'];

function sortedNear(ctx: WorldCtx, pts: ProvinceDef[]): ProvinceDef[] {
  return [...pts].sort(
    (a, b) => distanceKm(a.cityPoint, ctx.capPt) - distanceKm(b.cityPoint, ctx.capPt),
  );
}

function pick<T>(rnd: () => number, list: T[]): T | undefined {
  return list[Math.floor(rnd() * list.length)];
}

function sys(ctx: WorldCtx, cat: WeaponSystem['category'], pref: string[] = ['ru', 'cn', 'other']) {
  const all = ctx.catalog.filter((s) => s.category === cat);
  for (const d of pref) {
    const s = all.find((x) => x.doctrine === d);
    if (s) return s;
  }
  return all[0];
}

/** Ajoute les sections des phases 2+ à la vue (mutation) et renvoie messagerie et notifications. */
export function enrichView(view: PlayerView, ctx: WorldCtx): WorldExtras {
  const { me, now, rnd } = ctx;
  const mine = ctx.byNation.get(me) ?? [];
  const cap = mine.find((p) => p.isCapital) ?? mine[0];
  const [h0, h1] = ctx.hostiles;
  const others = ctx.nations
    .filter((n) => n.id !== me && n.kind === 'state' && (ctx.byNation.get(n.id)?.length ?? 0) > 0)
    .map((n) => ({ n, d: Math.min(...(ctx.byNation.get(n.id) ?? []).map((p) => distanceKm(p.cityPoint, ctx.capPt))) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.n.id);
  const allies = others.filter((id) => !ctx.hostiles.includes(id)).slice(0, 2);
  const neutralNear = others.filter((id) => !ctx.hostiles.includes(id) && !allies.includes(id)).slice(0, 6);
  const has = (id: string) => ctx.nations.some((n) => n.id === id);
  const bigFive = ['usa', 'rus', 'chn', 'gbr', 'fra'].filter(has);
  const ownUnits = Object.values(view.units).filter((u) => u.owner === me);

  // ——— Unités du joueur : ravitaillement, missions, vétérance ———
  ownUnits.forEach((u, i) => {
    u.veterancy = Math.min(3, Math.floor((u.xp ?? 0) / 120));
    u.supply = i % 7 === 3 ? 'limited' : i % 11 === 5 ? 'cut' : 'supplied';
    const s = ctx.catalog.find((x) => x.id === u.systemId);
    if (s?.movement === 'air')
      u.mission = {
        kind: i % 2 ? 'patrol' : 'strike',
        at: u.move?.legs[0]?.to ?? u.pos,
        radiusKm: 80,
        fuelH: 1.5 + rnd() * 3,
        baseProvinceId: cap?.id ?? null,
      };
  });

  // Inventaire réel au départ : 14 chasseurs de 5e génération possédés mais non productibles.
  const gen5 =
    ctx.catalog.find((s) => s.id === 'ru.su-57') ??
    ctx.catalog.find((s) => s.category === 'fighter' && s.generation === 5 && s.doctrine === 'ru') ??
    ctx.catalog.find((s) => s.category === 'fighter' && s.generation === 5);
  const airBase = mine.find((p) => p.buildings.includes('air_base')) ?? cap;
  if (gen5 && airBase) {
    const id = 'u-gen5';
    view.units[id] = {
      id,
      owner: me,
      level: 'own',
      pos: destination(airBase.cityPoint, 40, 12),
      lastSeen: now,
      uncertaintyKm: 0,
      systemId: gen5.id,
      count: 14,
      hpRatio: 1,
      status: 'idle',
      stance: 'defend',
      xp: 60,
      targetId: null,
      veterancy: 0,
      supply: 'supplied',
      mission: { kind: 'none', fuelH: 3.5, baseProvinceId: airBase.id },
    };
  }

  // ——— Généraux ———
  const own = Object.values(view.units).filter((u) => u.owner === me);
  const land = own.filter((u) => ['tank', 'ifv', 'infantry', 'artillery'].includes(ctx.catalog.find((s) => s.id === u.systemId)?.category ?? ''));
  const air = own.filter((u) => ctx.catalog.find((s) => s.id === u.systemId)?.movement === 'air');
  const generals: GeneralView[] = [
    { id: 'g1', name: 'Gén. Rachid Benali', traits: ['offensive', 'logistician'], unitIds: land.slice(0, 5).map((u) => u.id), directive: null, area: null },
    { id: 'g2', name: 'Gén. Samia Haddad', traits: ['aviator'], unitIds: air.slice(0, 4).map((u) => u.id), directive: 'harass', area: ctx.captureTarget?.cityPoint ?? null },
    { id: 'g3', name: 'Gén. Karim Ouali', traits: ['defender'], unitIds: land.slice(5, 9).map((u) => u.id), directive: 'defend', area: ctx.threatened?.cityPoint ?? null },
  ];
  for (const g of generals) for (const id of g.unitIds) if (view.units[id]) view.units[id]!.generalId = g.id;
  view.generals = generals;

  // ——— Recherche et licences ———
  const research: ResearchView = {
    current: { id: 'research.aero.gen5', startedAt: now - 30 * HOUR, completesAt: now + 94 * HOUR },
    queue: ['research.missiles.sam5', 'research.intel.exterior2', 'research.cyber.l2'],
    done: DONE,
    modifiers: { 'production.speed': 1.21, 'production.cost': 0.95, 'sensors.radarRange': 1.15, 'intel.interior.level': 1 },
  };
  view.research = research;
  const lic = ctx.catalog.filter((s) => s.doctrine === 'ru' && s.licensable).slice(0, 2);
  view.licences = lic.map((s, i) => ({ systemId: s.id, acquiredAt: now - (40 + i * 30) * HOUR }));

  // ——— Économie (dollars) ———
  const budget = 21.8e9;
  const perDay = budget / 365;
  const cheap = ctx.catalog.filter((s) => s.doctrine === 'ru').sort((a, b) => a.cost.money - b.cost.money);
  if (cap) {
    view.economy.production = [
      { id: 'p1', provinceId: cap.id, systemId: cheap[2]?.id ?? cheap[0]!.id, startedAt: now - 3 * HOUR, completesAt: now + 5 * HOUR },
      { id: 'p2', provinceId: (mine[1] ?? cap).id, systemId: cheap[6]?.id ?? cheap[0]!.id, startedAt: now - 10 * HOUR, completesAt: now + 2 * HOUR },
      { id: 'p3', provinceId: (airBase ?? cap).id, systemId: sys(ctx, 'fighter')?.id ?? cheap[0]!.id, startedAt: now - 20 * HOUR, completesAt: now + 70 * HOUR },
    ];
  }
  const hist = (base: number, drift: number, n = 21) =>
    Array.from({ length: n }, (_, i) => Math.round(base * (1 - drift * (n - 1 - i) / n + (rnd() - 0.5) * 0.04)));
  const details: EconomyDetails = {
    annualBudget: budget,
    income: { budget: perDay * 0.5, provinces: perDay * 0.46, trade: 3.1e6, licences: 0.4e6, alliance: 0.9e6 },
    expenses: { upkeep: 21.5e6, production: 14.2e6, research: 6.8e6, intel: 5.5e6, construction: 3.9e6, imports: 2.1e6, mobilization: 0 },
    resources: {
      oil: { stock: 12_400, production: 1_820, consumption: 1_360, history: hist(12_400, -0.3, 14) },
      metals: { stock: 8_600, production: 950, consumption: 1_010, history: hist(8_600, 0.08, 14) },
      electronics: { stock: 1_320, production: 240, consumption: 410, shortage: true, history: hist(1_320, 0.45, 14) },
      food: { stock: 21_150, production: 2_600, consumption: 2_380, history: hist(21_150, -0.05, 14) },
    },
    history: hist(3.42e9, -0.18),
    construction: cap
      ? [
          { id: 'c1', provinceId: cap.id, building: 'air_defense_site', level: 3, startedAt: now - 6 * HOUR, completesAt: now + 18 * HOUR, kind: 'upgrade' },
          { id: 'c2', provinceId: (ctx.threatened ?? cap).id, building: 'bunker', level: 2, startedAt: now - 2 * HOUR, completesAt: now + 10 * HOUR, kind: 'build' },
          { id: 'c3', provinceId: (mine[2] ?? cap).id, building: 'refinery', level: 2, startedAt: now - 1 * HOUR, completesAt: now + 22 * HOUR, kind: 'repair' },
        ]
      : [],
  };
  view.economy = {
    ...view.economy,
    money: 3.42e9,
    resources: { oil: 12_400, metals: 8_600, electronics: 1_320, food: 21_150 },
    incomePerDay: { money: perDay, oil: 1_820, metals: 950, electronics: 240, food: 2_600 },
  };
  (view.economy as typeof view.economy & { details: EconomyDetails }).details = details;

  // ——— Bâtiments des provinces du joueur (niveaux 1-5) ———
  const extra: BuildingType[] = ['oil_field', 'farm', 'local_industry', 'recruiting_office', 'bunker', 'air_defense_site', 'radar_station', 'hospital', 'mine'];
  mine.forEach((p, i) => {
    const pv = view.provinces[p.id];
    if (!pv) return;
    const types = new Set<BuildingType>(p.buildings);
    if (p.id === cap?.id) ['bunker', 'air_defense_site', 'radar_station', 'hospital', 'secret_lab', 'local_industry'].forEach((b) => types.add(b as BuildingType));
    else if (i % 2 === 0) types.add(extra[i % extra.length]!);
    if (p.coastal && i % 3 === 0) types.add('naval_base');
    const state: BuildingView[] = [...types].map((type, k) => ({
      type,
      level: p.id === cap?.id ? 2 + ((k + 1) % 3) : 1 + ((i + k) % 3),
      health: (i + k) % 9 === 4 ? 0.35 : (i + k) % 7 === 2 ? 0.72 : 1,
      repairUntil: (i + k) % 9 === 4 ? now + 20 * HOUR : null,
      upgradeUntil: p.id === cap?.id && type === 'air_defense_site' ? now + 18 * HOUR : null,
    }));
    pv.buildings = [...types];
    pv.buildingState = state;
    if (p.id === ctx.threatened?.id) pv.fortification = { provinceId: p.id, level: 2, completesAt: null };
  });
  for (const p of sortedNear(ctx, mine).slice(0, 3)) {
    const pv = view.provinces[p.id];
    if (pv && !pv.fortification) pv.fortification = { provinceId: p.id, level: 1, completesAt: now + 12 * HOUR };
  }

  // ——— Connaissance des provinces étrangères ———
  for (const p of ctx.provinces) {
    if (p.nationId === me || allies.includes(p.nationId)) continue;
    const pv = view.provinces[p.id];
    if (!pv) continue;
    const d = distanceKm(p.cityPoint, ctx.capPt);
    const level = p.id === ctx.captureTarget?.id ? 3 : ctx.hostiles.includes(p.nationId) ? (d < 900 ? 2 : 1) : d < 1500 ? 1 : 0;
    const known = level === 0 ? [] : level === 1 ? p.buildings.slice(0, 1) : level === 2 ? p.buildings.slice(0, Math.ceil(p.buildings.length * 0.7)) : p.buildings;
    pv.buildings = known;
    pv.buildingState = level >= 2 ? known.map((type, k) => ({ type, level: 1 + (k % 3), health: k === 0 && level === 3 ? 0.6 : 1 })) : undefined;
    pv.intel = { level: level as 0 | 1 | 2 | 3, economic: level >= 2, military: level >= 1 && ctx.hostiles.includes(p.nationId), updatedAt: now - (level === 3 ? 2 : 20 + (p.id.length % 5) * 9) * HOUR };
  }

  // ——— Marché, livraisons, logistique ———
  const offersFrom = [bigFive[1] ?? others[3], bigFive[2] ?? others[4], others[5], bigFive[0] ?? others[6], allies[0]].filter(Boolean) as NationId[];
  const unitSys = [sys(ctx, 'air_defense', ['ru']), sys(ctx, 'drone', ['cn', 'other']), sys(ctx, 'helicopter', ['ru']), sys(ctx, 'tank', ['cn'])].filter(Boolean) as WeaponSystem[];
  const offers: MarketOffer[] = [
    { id: 'o1', seller: offersFrom[0]!, item: { type: 'units', systemId: unitSys[0]!.id, count: 2 }, price: unitSys[0]!.cost.money * 2.1, to: null, createdAt: now - 6 * HOUR, expiresAt: now + 42 * HOUR },
    { id: 'o2', seller: offersFrom[1]!, item: { type: 'units', systemId: unitSys[1]!.id, count: 6 }, price: unitSys[1]!.cost.money * 5.4, to: me, createdAt: now - 3 * HOUR, expiresAt: now + 21 * HOUR },
    { id: 'o3', seller: offersFrom[2]!, item: { type: 'resource', resource: 'electronics', qty: 800 }, price: 240e6, to: null, createdAt: now - 12 * HOUR, expiresAt: now + 36 * HOUR },
    { id: 'o4', seller: offersFrom[3]!, item: { type: 'resource', resource: 'metals', qty: 1500 }, price: 95e6, to: null, createdAt: now - 1 * HOUR, expiresAt: now + 60 * HOUR },
    { id: 'o5', seller: offersFrom[0]!, item: { type: 'licence', systemId: unitSys[2]?.id ?? unitSys[0]!.id }, price: (unitSys[2] ?? unitSys[0]!).cost.money * 20, to: null, createdAt: now - 20 * HOUR, expiresAt: now + 100 * HOUR },
    { id: 'o6', seller: me, item: { type: 'resource', resource: 'oil', qty: 2000 }, price: 130e6, to: null, createdAt: now - 4 * HOUR, expiresAt: now + 44 * HOUR },
    { id: 'o7', seller: offersFrom[4] ?? offersFrom[1]!, item: { type: 'units', systemId: unitSys[3]?.id ?? unitSys[0]!.id, count: 12 }, price: (unitSys[3] ?? unitSys[0]!).cost.money * 10.5, to: null, createdAt: now - 9 * HOUR, expiresAt: now + 30 * HOUR },
  ];
  view.market = {
    offers,
    deliveries: [
      { id: 'd1', from: offersFrom[0]!, to: me, item: { type: 'units', systemId: unitSys[0]!.id, count: 1 }, carrierUnitId: null, eta: now + 14 * HOUR, covert: false },
      { id: 'd2', from: offersFrom[1]!, to: me, item: { type: 'resource', resource: 'electronics', qty: 400 }, carrierUnitId: null, eta: now + 31 * HOUR, covert: false },
      { id: 'd3', from: others[7] ?? offersFrom[2]!, to: me, item: { type: 'units', systemId: unitSys[1]!.id, count: 4 }, carrierUnitId: null, eta: now + 52 * HOUR, covert: true },
    ],
    embargoed: [has('prk') ? 'prk' : others[9]!, ...(h1 ? [h1] : [])],
  };
  view.logistics = {
    depots: sortedNear(ctx, mine)
      .slice(0, 3)
      .map((p, i) => ({ id: `dep${i}`, provinceId: p.id, at: p.cityPoint, rangeKm: 300 })),
    mobilized: false,
    mobilizedSince: null,
  };

  // ——— Militaire ———
  view.alertLevel = 3;
  const hH = now + 6 * HOUR;
  const operations: OperationView[] = [
    {
      id: 'op1',
      name: 'Opération Sirocco',
      hHour: hH,
      status: 'planned',
      steps: [
        { offsetMin: -180, label: 'Frappe des radars (missiles de croisière)', status: 'pending' },
        { offsetMin: -90, label: 'Brouillage de la zone', status: 'pending' },
        { offsetMin: -30, label: 'Mise en place des blindés', status: 'pending' },
        { offsetMin: 0, label: 'Assaut sur l’objectif', status: 'pending' },
        { offsetMin: 120, label: 'Exploitation et patrouille aérienne', status: 'pending' },
      ],
    },
    {
      id: 'op2',
      name: 'Bouclier du Sud',
      hHour: now - 2 * HOUR,
      status: 'running',
      steps: [
        { offsetMin: -60, label: 'Déploiement de la défense aérienne', status: 'done' },
        { offsetMin: 0, label: 'Patrouille de chasse', status: 'done' },
        { offsetMin: 180, label: 'Relève des patrouilles', status: 'pending' },
      ],
    },
    {
      id: 'op3',
      name: 'Opération Harmattan',
      hHour: now - 30 * HOUR,
      status: 'failed',
      steps: [
        { offsetMin: -30, label: 'Raid des forces spéciales', status: 'done' },
        { offsetMin: 0, label: 'Frappe sur le dépôt', status: 'failed', error: 'Cible hors de portée' },
      ],
    },
  ];
  view.operations = operations;

  const eng = (cat: WeaponSystem['category'], pref: string[], n: number) => {
    const s = sys(ctx, cat, pref);
    return s ? { systemId: s.id, count: n } : null;
  };
  const side = (nations: NationId[], engaged: ({ systemId: string; count: number } | null)[], lossFrac: number[]) => {
    const e = engaged.filter(Boolean) as { systemId: string; count: number }[];
    return { nations, engaged: e, losses: e.map((x, i) => ({ systemId: x.systemId, count: Math.round(x.count * (lossFrac[i] ?? 0)) })).filter((x) => x.count > 0) };
  };
  const at0 = ctx.captureTarget?.cityPoint ?? destination(ctx.capPt, 80, 250);
  const at1 = ctx.threatened?.cityPoint ?? destination(ctx.capPt, 200, 200);
  const reports: BattleReportSummary[] = [
    {
      id: 'b1',
      at: destination(at0, 200, 18),
      provinceId: ctx.captureTarget?.id ?? null,
      startedAt: now - 5 * HOUR,
      endedAt: now - 2 * HOUR,
      title: `Bataille de ${ctx.captureTarget?.cityName ?? ctx.captureTarget?.name ?? 'la frontière'}`,
      attacker: side([me], [eng('tank', ['ru'], 12), eng('ifv', ['ru'], 8), eng('artillery', ['ru'], 6)], [0.17, 0.25, 0]),
      defender: side([h0 ?? others[0]!], [eng('tank', ['us', 'eu'], 9), eng('infantry', ['us', 'eu'], 3), eng('air_defense', ['us', 'eu'], 2)], [0.66, 0.67, 0.5]),
      outcome: 'attacker',
    },
    {
      id: 'b2',
      at: destination(at1, 30, 25),
      provinceId: ctx.threatened?.id ?? null,
      startedAt: now - 70 * MINUTE,
      endedAt: null,
      title: `Combats autour de ${ctx.threatened?.cityName ?? ctx.threatened?.name ?? 'la frontière'}`,
      attacker: side([h0 ?? others[0]!], [eng('tank', ['us', 'eu'], 10), eng('helicopter', ['us', 'eu'], 4)], [0.2, 0.25]),
      defender: side([me], [eng('infantry', ['ru'], 3), eng('air_defense', ['ru'], 2), eng('ifv', ['ru'], 6)], [0.33, 0, 0.16]),
      outcome: 'ongoing',
    },
    {
      id: 'b3',
      at: destination(ctx.capPt, 20, 160),
      provinceId: null,
      startedAt: now - 20 * HOUR,
      endedAt: now - 19 * HOUR,
      title: 'Engagement aérien au-dessus de la côte',
      attacker: side([h1 ?? h0 ?? others[1]!], [eng('fighter', ['us', 'eu'], 6), eng('bomber', ['us', 'eu'], 2)], [0.5, 1]),
      defender: side([me], [eng('fighter', ['ru'], 8), eng('air_defense', ['ru'], 3)], [0.125, 0]),
      outcome: 'defender',
    },
    {
      id: 'b4',
      at: destination(at0, 120, 60),
      provinceId: null,
      startedAt: now - 44 * HOUR,
      endedAt: now - 42 * HOUR,
      title: 'Raid sur un convoi de ravitaillement',
      attacker: side([h0 ?? others[0]!], [eng('drone', ['us', 'other'], 4), eng('helicopter', ['us', 'eu'], 2)], [0.25, 0]),
      defender: side([me], [eng('logistics', ['other', 'ru'], 3), eng('ifv', ['ru'], 2)], [0.67, 0.5]),
      outcome: 'attacker',
    },
  ];
  view.battleReports = reports;
  view.blockades = h1 && cap?.coastal ? [{ id: 'bl1', by: h1, target: { provinceId: cap.id }, since: now - 8 * HOUR }] : [];
  view.satellites = [];

  // ——— Renseignement ———
  const departments: DepartmentView[] = [
    { id: 'interior', level: 2, budgetPerDay: 1.2e6, capacity: 3, running: 1 },
    { id: 'exterior', level: 1, budgetPerDay: 2.6e6, capacity: 2, running: 2 },
    { id: 'military', level: 1, budgetPerDay: 1.7e6, capacity: 3, running: 1 },
  ];
  const hn = (id?: NationId) => ctx.nations.find((n) => n.id === id)?.name ?? '—';
  const hp = ctx.captureTarget;
  const enemyUnits = Object.values(view.units).filter((u) => u.owner !== me);
  const report = (r: Partial<IntelReport> & Pick<IntelReport, 'id' | 'dept' | 'source' | 'kind' | 'title' | 'body'>): IntelReport => ({
    time: now - (1 + rnd() * 30) * HOUR,
    reliability: 'B',
    credibility: 2,
    at: null,
    radiusKm: 60,
    actions: [],
    ...r,
  });
  const reportsList: IntelReport[] = [
    report({ id: 'r1', dept: 'military', source: 'sigint', kind: 'flash', time: now - 25 * MINUTE, reliability: 'A', credibility: 1, title: `FLASH — Colonne blindée en mouvement vers ${ctx.threatened?.cityName ?? ctx.threatened?.name ?? 'la frontière'}`, body: `Interception radio confirmée. Une colonne d’environ 40 véhicules (${hn(h0)}) progresse vers le nord-est à 35 km/h. Arrivée estimée sur nos positions : moins de 3 h.\n\nAvis : renforcer la défense antichar du secteur.`, at: at1, radiusKm: 40, subject: { nationId: h0, unitIds: enemyUnits.slice(0, 2).map((u) => u.id) }, actions: [{ kind: 'plan_strike', at: at1 }, { kind: 'send_recon', at: at1 }, { kind: 'share', reportId: 'r1' }] }),
    report({ id: 'r2', dept: 'military', source: 'sigint', kind: 'order_of_battle', reliability: 'B', credibility: 2, title: `Ordre de bataille — Région militaire frontalière (${hn(h0)})`, body: 'Imagerie satellite du matin : 2 bataillons de chars, 1 batterie de défense aérienne longue portée, dépôt de carburant actif. Activité en hausse de 30 % en 48 h.', at: hp?.cityPoint ?? at0, radiusKm: 90, subject: { nationId: h0, provinceId: hp?.id }, actions: [{ kind: 'open_province', provinceId: hp?.id ?? '' }, { kind: 'plan_strike', at: hp?.cityPoint ?? at0 }] }),
    report({ id: 'r3', dept: 'military', source: 'humint', kind: 'intentions', reliability: 'D', credibility: 4, title: 'Rumeur d’offensive aéroportée', body: 'Une source non confirmée évoque une opération aéroportée dans les 72 h. Aucun recoupement technique à ce stade.', at: destination(ctx.capPt, 150, 220), radiusKm: 150, subject: { nationId: h1 ?? h0 }, actions: [{ kind: 'send_recon', at: destination(ctx.capPt, 150, 220) }] }),
    report({ id: 'r4', dept: 'military', source: 'sigint', kind: 'daily', time: now - 4 * HOUR, reliability: 'B', credibility: 2, title: 'Note quotidienne — Situation militaire', body: '1. Front nord : pression constante, pertes adverses élevées.\n2. Aviation : 12 sorties adverses détectées, 3 interceptions.\n3. Mer : un sous-marin non identifié signalé au large.', actions: [] }),
    report({ id: 'r5', dept: 'exterior', source: 'humint', kind: 'intentions', reliability: 'B', credibility: 3, title: `${hn(h1 ?? h0)} prête à un cessez-le-feu`, body: 'Notre agent au ministère des Affaires étrangères rapporte des discussions internes favorables à un cessez-le-feu, sous condition de retrait de la province disputée.', subject: { nationId: h1 ?? h0 }, actions: [{ kind: 'share', reportId: 'r5' }] }),
    report({ id: 'r6', dept: 'exterior', source: 'humint', kind: 'result', reliability: 'A', credibility: 1, title: 'Opération « Mirage » réussie : plans de recherche obtenus', body: 'Les plans d’un radar de nouvelle génération ont été exfiltrés. Gain de recherche estimé : 20 % sur la branche Capteurs.', actions: [] }),
    report({ id: 'r7', dept: 'exterior', source: 'sigint', kind: 'leak', reliability: 'E', credibility: 5, title: 'Fuite : achats d’armes secrets', body: 'Documents diffusés sur un canal anonyme : livraison clandestine de drones armés à une nation voisine. Authenticité douteuse — possible intoxication.', actions: [] }),
    report({ id: 'r8', dept: 'exterior', source: 'sigint', kind: 'daily', time: now - 6 * HOUR, reliability: 'C', credibility: 3, title: 'Note quotidienne — Diplomatie et économie', body: `Le Conseil de sécurité se réunit dans 2 jours. ${hn(bigFive[0])} soutiendrait une résolution de cessez-le-feu.`, actions: [] }),
    report({ id: 'r9', dept: 'interior', source: 'humint', kind: 'counterintel', time: now - 3 * HOUR, reliability: 'A', credibility: 1, title: 'Agent étranger démasqué à la capitale', body: `Un officier de liaison travaillant pour ${hn(h0)} a été arrêté au ministère de la Défense. Retournement possible en agent double.`, at: cap?.cityPoint ?? null, radiusKm: 15, actions: [{ kind: 'open_province', provinceId: cap?.id ?? '' }] }),
    report({ id: 'r10', dept: 'interior', source: 'sigint', kind: 'cyber', reliability: 'B', credibility: 2, title: 'Intrusion détectée sur le réseau radar', body: 'Tentative d’intrusion bloquée sur le réseau de défense aérienne. Signature compatible avec un service adverse.', actions: [] }),
    report({ id: 'r11', dept: 'interior', source: 'humint', kind: 'daily', time: now - 7 * HOUR, reliability: 'B', credibility: 2, title: 'Note quotidienne — Sécurité intérieure', body: 'Stabilité en légère baisse (–0,8/j). Désinformation étrangère active sur les réseaux sociaux. Aucun risque de coup d’État à court terme.', actions: [] }),
    report({ id: 'r12', dept: 'interior', source: 'sigint', kind: 'flash', time: now - 50 * MINUTE, reliability: 'F', credibility: 6, title: 'Sabotage possible d’une raffinerie', body: 'Incendie inexpliqué sur un site pétrolier. Origine indéterminée, enquête en cours.', at: mine[2]?.cityPoint ?? null, radiusKm: 25, actions: [{ kind: 'open_province', provinceId: mine[2]?.id ?? '' }] }),
  ];
  const ops: IntelOpView[] = [
    { id: 'io1', kind: 'infiltrate_spy', dept: 'exterior', target: { nationId: h0, provinceId: hp?.id }, startedAt: now - 20 * HOUR, completesAt: now + 28 * HOUR, status: 'running', estimate: 0.62 },
    { id: 'io2', kind: 'listen_area', dept: 'military', target: { at: at1, radiusKm: 120 }, startedAt: now - 2 * HOUR, completesAt: now + 10 * HOUR, status: 'running', estimate: 0.85 },
    { id: 'io3', kind: 'steal_research', dept: 'exterior', target: { nationId: bigFive[2] ?? h1 }, startedAt: now - 40 * HOUR, completesAt: now + 8 * HOUR, status: 'running', estimate: 0.34 },
    { id: 'io4', kind: 'counterintel_sweep', dept: 'interior', target: { nationId: me }, startedAt: now - 10 * HOUR, completesAt: now + 14 * HOUR, status: 'running', estimate: 0.7 },
    { id: 'io5', kind: 'cyber_radar', dept: 'military', target: { nationId: h0 }, startedAt: now - 60 * HOUR, completesAt: now - 40 * HOUR, status: 'compromised', estimate: 0.4 },
  ];
  const agents: AgentView[] = [
    { id: 'a1', codename: 'FAUCON', nationId: h0 ?? others[0]!, status: 'active', since: now - 30 * DAY },
    { id: 'a2', codename: 'SIRÈNE', nationId: bigFive[1] ?? others[2]!, status: 'active', since: now - 12 * DAY },
    { id: 'a3', codename: 'ORYX', nationId: h1 ?? others[1]!, status: 'burned', since: now - 5 * DAY },
    { id: 'a4', codename: 'MISTRAL', nationId: h0 ?? others[0]!, status: 'double', since: now - 2 * DAY },
    { id: 'a5', codename: 'GAZELLE', nationId: allies[0] ?? others[3]!, status: 'exfiltrated', since: now - 40 * DAY },
  ];
  view.intel = {
    departments,
    reports: reportsList.sort((a, b) => b.time - a.time),
    operations: ops,
    agents,
    caughtAgents: [
      { id: 'c1', nationId: h0 ?? others[0]!, caughtAt: now - 3 * HOUR, turned: false },
      { id: 'c2', nationId: bigFive[0] ?? others[4]!, caughtAt: now - 9 * DAY, turned: true },
    ],
  };

  // ——— Diplomatie ———
  const alliance: AllianceView = {
    id: 'al-maghreb',
    name: 'Pacte du Sahel',
    flag: 'PS',
    leader: me,
    members: [me, ...allies],
    charter: { mutualDefense: true, intelSharing: true, passage: false },
    treasury: 1.84e9,
    createdAt: now - 2 * DAY,
    votes: allies[0]
      ? [{ id: 'v1', kind: 'skip_mutual_defense', subject: allies[0], endsAt: now + 9 * HOUR, yes: [allies[0]], no: [] }]
      : [],
    invites: neutralNear.slice(0, 1),
  };
  const west = ['usa', 'gbr', 'fra', 'deu', 'ita', 'pol', 'can'].filter((x) => has(x) && x !== me);
  const alliances: AllianceView[] = [
    alliance,
    { id: 'al-atl', name: 'Coalition atlantique', flag: 'CA', leader: west[0] ?? others[5]!, members: west.slice(0, 5), charter: { mutualDefense: true, intelSharing: true, passage: true }, treasury: 12.5e9, createdAt: now - 3 * DAY, votes: [], invites: [] },
    { id: 'al-east', name: 'Axe continental', flag: 'AC', leader: bigFive[1] ?? others[6]!, members: ['rus', 'blr', 'prk'].filter(has), charter: { mutualDefense: true, intelSharing: false, passage: true }, treasury: 4.1e9, createdAt: now - 1 * DAY, votes: [], invites: [] },
  ];
  const relations: DiplomacyView['relations'] = [
    ...(h0 ? [{ nationId: h0, relation: 'war' as const, since: now - 30 * HOUR, pending: null }] : []),
    ...(h1 ? [{ nationId: h1, relation: 'war' as const, since: now - 26 * HOUR, pending: { from: h1, kind: 'ceasefire' as const, at: now - 1 * HOUR } }] : []),
    ...allies.map((id) => ({ nationId: id, relation: 'ally' as const, since: now - 2 * DAY, pending: null })),
    ...neutralNear.map((id, i) => ({ nationId: id, relation: (i === 4 ? 'ceasefire' : 'peace') as 'peace' | 'ceasefire', since: now - 3 * DAY, pending: null })),
  ];
  const disputed = [
    ...(ctx.captureTarget
      ? [{ id: 'dz-front', name: `Marches de ${ctx.captureTarget.cityName ?? ctx.captureTarget.name}`, provinceIds: [ctx.captureTarget.id], holder: ctx.captureTarget.nationId, claimants: [me, ctx.captureTarget.nationId], tension: 82 }]
      : []),
    { id: 'sahara-occidental', name: 'Sahara occidental', provinceIds: ['esh-1'], holder: 'mar', claimants: ['mar', 'esh'], tension: 55 },
    { id: 'cachemire', name: 'Cachemire', provinceIds: ['ind-5', 'pak-5'], holder: 'ind', claimants: ['ind', 'pak'], tension: 75 },
    { id: 'taiwan', name: 'Taïwan', provinceIds: ['twn-1'], holder: 'twn', claimants: ['twn', 'chn'], tension: 60 },
  ];
  view.diplomacy = {
    relations,
    alliances,
    myAllianceId: alliance.id,
    invitations: ['al-east'],
    reputation: 62,
    disputed,
    neutrals: neutralNear.slice(0, 5).map((id, i) => ({ nationId: id, leaning: { [alliance.id]: [0.62, 0.35, 0.18, 0.51, 0.44][i]!, 'al-atl': [0.2, 0.48, 0.66, 0.3, 0.28][i]!, 'al-east': [0.1, 0.12, 0.08, 0.15, 0.22][i]! } })),
  };
  for (const r of relations) {
    const nv = view.nations[r.nationId];
    if (nv) nv.relation = r.relation;
  }
  for (const a of alliances) for (const m of a.members) if (view.nations[m]) view.nations[m]!.allianceId = a.id;
  for (const nv of Object.values(view.nations)) {
    nv.stability = 40 + Math.round(rnd() * 55);
    nv.doctrine = ['us', 'ru', 'cn', 'eu', 'other'][Math.floor(rnd() * 5)];
  }
  if (view.nations[me]) view.nations[me]!.stability = 64;
  if (h1 && view.nations[h1]) view.nations[h1]!.sanctioned = true;

  // ——— Conseil de sécurité ———
  const council: CouncilView = {
    members: bigFive,
    rotatingSeats: [me, has('bra') ? 'bra' : others[8]!, has('ind') ? 'ind' : others[9]!],
    rule: { majority: 'simple', veto: true },
    nextSessionAt: now + 2 * DAY,
    session: {
      phase: 'voting',
      opensAt: now - 4 * HOUR,
      votingEndsAt: now + 7 * HOUR + 20 * MINUTE,
      resolutions: [
        { id: 'res1', type: 'ceasefire', proposer: bigFive[4] ?? bigFive[0]!, target: { nationId: h0 }, text: `Le Conseil exige un cessez-le-feu immédiat entre ${hn(me)} et ${hn(h0)}, le retrait des forces sur les lignes du J+0 et l’ouverture de couloirs humanitaires.`, votes: { [bigFive[4] ?? 'fra']: 'yes', [bigFive[3] ?? 'gbr']: 'yes', [bigFive[2] ?? 'chn']: 'abstain' }, status: 'voting', durationDays: 14 },
        { id: 'res2', type: 'arms_embargo', proposer: me, target: { nationId: h0 }, text: `Embargo sur les livraisons d’armes à ${hn(h0)} pour une durée de 30 jours.`, votes: { [me]: 'yes', [bigFive[1] ?? 'rus']: 'yes', [bigFive[0] ?? 'usa']: 'no' }, status: 'voting', durationDays: 30 },
        { id: 'res3', type: 'no_fly_zone', proposer: bigFive[0] ?? others[0]!, target: { at: at1, radiusKm: 250 }, text: 'Zone d’exclusion aérienne de 250 km autour de la zone des combats.', votes: { [bigFive[0] ?? 'usa']: 'yes', [bigFive[1] ?? 'rus']: 'no' }, status: 'voting', durationDays: 10 },
      ],
    },
    inForce: [
      { id: 'res0', type: 'economic_sanctions', proposer: bigFive[0] ?? others[0]!, target: { nationId: h1 ?? others[1] }, text: `Sanctions économiques contre ${hn(h1 ?? others[1])}.`, votes: {}, status: 'passed', durationDays: 30, until: now + 21 * DAY },
    ],
  };
  view.council = council;

  view.stability = {
    value: 64,
    trend: -0.8,
    factors: [
      { label: 'Guerre en cours', delta: -1.4 },
      { label: 'Victoires récentes', delta: 0.9 },
      { label: 'Désinformation étrangère', delta: -0.5 },
      { label: 'Pénurie d’électronique', delta: -0.2 },
      { label: 'Soutien de l’alliance', delta: 0.4 },
    ],
    coupRisk: 0.04,
  };

  // ——— Actualité mondiale ———
  const news = (i: number, category: NewsItem['category'], headline: string, body: string, ago: number, at: LngLat | null, nations: NationId[]): NewsItem => ({ id: `n${i}`, time: now - ago, category, headline, body, at, nations });
  view.news = [
    news(1, 'war', `${hn(h0)} lance une offensive blindée`, `Des colonnes de chars franchissent la frontière. ${hn(me)} annonce une riposte « proportionnée ».`, 40 * MINUTE, at1, [me, h0 ?? '']),
    news(2, 'strike', 'Frappes de missiles sur une base aérienne', 'Plusieurs missiles de croisière ont touché une base aérienne ; les dégâts seraient importants.', 3 * HOUR, destination(ctx.capPt, 100, 400), [h0 ?? '']),
    news(3, 'council', 'Le Conseil de sécurité vote sur un cessez-le-feu', 'Trois projets de résolution sont soumis au vote. Le résultat est attendu dans la journée.', 4 * HOUR, null, bigFive),
    news(4, 'capture', `${ctx.captureTarget?.cityName ?? ctx.captureTarget?.name ?? 'Une ville frontalière'} encerclée`, 'Les forces assiégeantes contrôlent les principaux axes d’accès.', 6 * HOUR, at0, [me]),
    news(5, 'alliance', 'Naissance du Pacte du Sahel', `${hn(me)} et ses voisins signent une charte de défense mutuelle et de partage du renseignement.`, 2 * DAY, ctx.capPt, [me, ...allies]),
    news(6, 'economy', 'Le baril s’envole après des frappes sur des raffineries', 'Le prix du pétrole gagne 14 % en une séance.', 9 * HOUR, null, []),
    news(7, 'leak', 'Fuite de plans militaires', 'Des documents présentés comme des plans d’invasion circulent en ligne. Leur authenticité est contestée.', 11 * HOUR, null, [h1 ?? '']),
    news(8, 'refugees', 'Afflux de réfugiés aux frontières', 'Les agences humanitaires signalent des dizaines de milliers de déplacés.', 14 * HOUR, at1, [me, h0 ?? '']),
    news(9, 'revolt', 'Émeutes dans une province disputée', 'Des affrontements opposent manifestants et forces de l’ordre.', 20 * HOUR, null, []),
    news(10, 'nuclear', 'Exercice nucléaire annoncé', `${hn(bigFive[1])} met ses forces stratégiques en alerte pour un exercice de 48 h.`, 26 * HOUR, null, bigFive.slice(1, 2)),
    news(11, 'peace', 'Cessez-le-feu signé dans le Caucase', 'Les deux parties s’engagent à geler les lignes de front.', 30 * HOUR, null, []),
    news(12, 'coup', 'Tentative de coup d’État déjouée', 'Des officiers ont été arrêtés après une tentative de prise du pouvoir.', 36 * HOUR, null, [others[12] ?? '']),
    news(13, 'event', 'Salon international de l’armement', 'Les industriels présentent drones, radars et missiles de nouvelle génération.', 44 * HOUR, null, []),
  ].map((n) => ({ ...n, nations: n.nations.filter(Boolean) }));

  // ——— Messagerie ———
  const iso = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString();
  let mid = 0;
  const msg = (channel: string, nationId: NationId | null, name: string, text: string, ago: number): ChatMessage => ({ id: ++mid, gameId: 'demo', channel, from: { userId: `u-${name}`, nationId, name }, text, sentAt: iso(ago) });
  const allianceCh = `alliance:${alliance.id}`;
  const priv = (other: NationId) => `private:${[me, other].sort().join('|')}`;
  const chat: ChatMessage[] = [
    msg('game', others[4] ?? null, PLAYER_NAMES[0]!, 'Bonne chance à tous. Pas de frappe nucléaire avant J+10, d’accord ?', 180),
    msg('game', others[6] ?? null, PLAYER_NAMES[1]!, 'Accord. Le Conseil votera sur le cessez-le-feu ce soir.', 150),
    msg('game', others[2] ?? null, PLAYER_NAMES[3]!, 'Quelqu’un vend de l’électronique ? J’achète au prix du marché.', 90),
    msg('game', me, 'Vous', 'Offre publique au marché : 2 000 unités de pétrole.', 60),
    msg('game', others[4] ?? null, PLAYER_NAMES[0]!, 'Vu, je regarde.', 55),
    msg(allianceCh, allies[0] ?? null, PLAYER_NAMES[2]!, 'Je couvre le flanc sud avec deux bataillons.', 120),
    msg(allianceCh, me, 'Vous', 'Parfait. Opération Sirocco à H+6, je partage le plan.', 110),
    msg(allianceCh, allies[1] ?? null, 'IA · Commandement', 'Défense aérienne déployée sur la frontière commune.', 70),
    msg(allianceCh, allies[0] ?? null, PLAYER_NAMES[2]!, 'Rapport partagé : colonne blindée vers le nord-est.', 22),
    ...(h1 ? [msg(priv(h1), h1, PLAYER_NAMES[4]!, 'Nous proposons un cessez-le-feu. Nos conditions sont dans la proposition diplomatique.', 65), msg(priv(h1), me, 'Vous', 'Nous l’étudions. Retirez d’abord vos chars de la frontière.', 40)] : []),
    ...(others[3] ? [msg(priv(others[3]), others[3], PLAYER_NAMES[5]!, 'Intéressé par une licence de production ? Prix à discuter.', 300)] : []),
  ];

  const notes: GameNotification[] = [
    { kind: 'intel_report', time: now - 25 * MINUTE, reportId: 'r1', flash: true, at: at1 },
    { kind: 'battle_report', time: now - 2 * HOUR, reportId: 'b1', at: at0 },
    { kind: 'research_complete', time: now - 5 * HOUR, nodeId: 'research.industry.l2' },
    { kind: 'council', time: now - 4 * HOUR, text: 'Séance du Conseil de sécurité ouverte : 3 résolutions au vote.' },
    { kind: 'alert_level', time: now - 7 * HOUR, level: 3 },
    { kind: 'generic', time: now - 3 * HOUR, at: cap?.cityPoint ?? null, category: 'intel', title: 'Contre-espionnage', text: 'Agent étranger démasqué à la capitale.', severity: 'warn' },
  ];
  return { chat, notes };
}

/** Réponse crédible d'un autre joueur (messagerie de démonstration). */
export function demoReply(rnd: () => number): string {
  return pick(rnd, [
    'Reçu.',
    'On en parle après la séance du Conseil.',
    'Je transmets à l’état-major.',
    'Négatif, pas avant J+8.',
    'D’accord, je prépare l’offre au marché.',
  ])!;
}
