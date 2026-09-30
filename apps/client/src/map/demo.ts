/**
 * Scène de démonstration de la carte (diagnostic seulement : `window.__rlMap.demo()` en mode
 * ?mock=1 ou rl.debug=1). Enrichit la vue courante pour la vérification visuelle et les mesures de
 * performance : relations diplomatiques, navires et sous-marins, missiles en vol, patrouilles,
 * leurre, ravitaillement coupé, radars, provinces disputées / en révolte / sous blocus / en zone
 * d'exclusion aérienne, fortifications, bâtiments endommagés et de niveau, renseignement progressif,
 * passage de satellite, et N unités supplémentaires réparties sur le théâtre.
 * N'est jamais appelé par le jeu lui-même.
 */
import {
  BUILDING_TYPES,
  HOUR,
  MINUTE,
  destination,
  distanceKm,
  bearing,
  type BuildingType,
  type BuildingView,
  type Category,
  type LngLat,
  type NationId,
  type ProvinceView,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { gameNow, useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Systèmes génériques ajoutés au catalogue local si la catégorie manque (démonstration). */
function demoSystems(): WeaponSystem[] {
  const base = (
    id: string,
    name: string,
    category: Category,
    movement: WeaponSystem['movement'],
    extra: Partial<WeaponSystem> = {},
  ): WeaponSystem =>
    ({
      id,
      name,
      doctrine: 'other',
      origin: 'XX',
      category,
      roles: [],
      generation: 4,
      targetClass: 'armor',
      movement,
      canCapture: false,
      cost: { money: 1, resources: {} },
      buildTimeH: 1,
      upkeepPerDay: 0,
      speedKmh: 40,
      operationalRadiusKm: null,
      weaponRangeKm: { min: 0, max: 20 },
      damage: {},
      hp: 10,
      armor: 0,
      stealth: 0,
      detectionRangeKm: 40,
      ew: { jamming: 0, jamResistance: 0 },
      payload: { slots: 0 },
      unitSize: 1,
      requires: [],
      licensable: false,
      exportable: false,
      icon: category,
      sheet: {},
      enabled: true,
      ...extra,
    }) as unknown as WeaponSystem;
  return [
    base('demo.frigate', 'Frégate multimissions', 'surface_ship', 'sea', {
      speedKmh: 55,
      weaponRangeKm: { min: 0, max: 180 },
      detectionRangeKm: 220,
      sensor: { kind: 'radar', rangeKm: 240, stealthDetect: 0 },
    }),
    base('demo.carrier', 'Porte-avions', 'surface_ship', 'sea', { icon: 'carrier', speedKmh: 55 }),
    base('demo.ssk', 'Sous-marin d’attaque', 'submarine', 'sea', {
      speedKmh: 35,
      weaponRangeKm: { min: 0, max: 50 },
      sensor: { kind: 'sonar', rangeKm: 90, stealthDetect: 0 },
      naval: { submerged: true, asw: 0.6, aircraftCapacity: 0, launchCells: 0 },
    }),
    base('demo.cruise', 'Missile de croisière', 'strike_missile', 'air', { speedKmh: 900 }),
    base('demo.radar', 'Radar de veille lointaine', 'radar' as Category, 'land', {
      detectionRangeKm: 1800,
      sensor: { kind: 'early_warning', rangeKm: 1800, stealthDetect: 0.2 },
    }),
    base('demo.bomber', 'Bombardier stratégique', 'bomber', 'air', {
      speedKmh: 850,
      operationalRadiusKm: 3500,
      weaponRangeKm: { min: 0, max: 300 },
    }),
    base('demo.awacs', 'Avion de guet aérien', 'air_support', 'air', {
      speedKmh: 700,
      sensor: { kind: 'aew', rangeKm: 400, stealthDetect: 0.1 },
    }),
  ];
}

export interface DemoOptions {
  /** Unités supplémentaires réparties sur le théâtre (mesures de performance). */
  extra?: number;
  seed?: number;
}

export function applyDemoScene(o: DemoOptions = {}) {
  const g = useGame.getState();
  const view = g.view;
  const me = g.me;
  if (!view || !me) return;
  const rnd = prng(o.seed ?? 11);
  const w = useWorld.getState();
  // Catalogue : catégories manquantes complétées par des systèmes génériques.
  const catalog = { ...w.catalog };
  for (const s of demoSystems()) if (!catalog[s.id]) catalog[s.id] = s;
  useWorld.setState({ catalog });
  const byCat = (c: string) => Object.values(catalog).filter((s) => s.category === c);
  const pick = (c: string) => {
    const l = byCat(c);
    return l[Math.floor(rnd() * l.length)];
  };
  const t = gameNow();
  const defs = w.provinces;
  const mineDefs = Object.values(defs).filter((d) => view.provinces[d.id]?.owner === me);
  const cap = mineDefs.find((d) => d.isCapital) ?? mineDefs[0];
  if (!cap) return;
  const capPt = cap.cityPoint;

  // ——— Relations : nations présentes en armes = guerre ; un voisin allié ; le reste neutre. ———
  const hostile = new Set(Object.values(view.units).filter((u) => u.owner !== me).map((u) => u.owner));
  const near = Object.values(defs)
    .filter((d) => d.nationId !== me)
    .sort((a, b) => distanceKm(a.cityPoint, capPt) - distanceKm(b.cityPoint, capPt));
  const ally = near.find((d) => !hostile.has(d.nationId))?.nationId;
  const nations = { ...view.nations };
  for (const id of Object.keys(nations)) {
    if (id === me) continue;
    nations[id] = {
      ...nations[id]!,
      relation: hostile.has(id) ? 'war' : id === ally ? 'ally' : 'peace',
    };
  }
  const enemy = [...hostile][0] ?? near[0]?.nationId ?? me;
  const enemyDefs = near.filter((d) => d.nationId === enemy);
  const enemyCity = enemyDefs[0]?.cityPoint ?? destination(capPt, 270, 600);

  // ——— Unités ———
  const units: Record<string, UnitView> = { ...view.units };
  let seq = 0;
  const add = (u: Omit<UnitView, 'id' | 'lastSeen' | 'uncertaintyKm'> & Partial<UnitView>) => {
    const id = `d${++seq}`;
    units[id] = { id, lastSeen: t, uncertaintyKm: 0, ...u } as UnitView;
    return units[id]!;
  };
  const own = (s: WeaponSystem | undefined, pos: LngLat, extra: Partial<UnitView> = {}) =>
    s &&
    add({
      owner: me,
      level: 'own',
      pos,
      systemId: s.id,
      count: s.unitSize,
      hpRatio: 0.5 + rnd() * 0.5,
      status: 'idle',
      stance: 'defend',
      ...extra,
    });
  const moveLeg = (from: LngLat, to: LngLat, speed: number, medium: 'air' | 'sea' | 'land', done = 0.35) => {
    const dur = (distanceKm(from, to) / Math.max(1, speed)) * HOUR;
    const t0 = t - dur * done;
    return { legs: [{ from, to, t0, t1: t0 + dur, medium }] };
  };
  // Mer au large de la capitale.
  const sea = (k: number): LngLat => destination(capPt, 10 + k * 25, 60 + k * 30);
  own(catalog['demo.frigate'], sea(0), { count: 2 });
  own(catalog['demo.carrier'], sea(1));
  own(catalog['demo.ssk'], sea(2));
  own(catalog['demo.frigate'], sea(3), {
    status: 'moving',
    move: moveLeg(sea(3), destination(sea(3), 60, 300), 55, 'sea'),
  });
  // Patrouille aérienne (CAP) et guet aérien.
  const f1 = pick('fighter');
  const capCenter = destination(capPt, 250, 180);
  own(f1, destination(capCenter, 0, 80), {
    count: 4,
    status: 'moving',
    mission: { kind: 'patrol', at: capCenter, radiusKm: 80, fuelH: 2.4 },
    move: moveLeg(destination(capCenter, 0, 80), destination(capCenter, 90, 80), 800, 'air', 0.5),
  });
  own(catalog['demo.awacs'], destination(capPt, 180, 150), {
    mission: { kind: 'awacs', at: destination(capPt, 180, 150), radiusKm: 60 },
  });
  // Frappe : bombardier en route, missile en vol vers une ville ennemie.
  own(catalog['demo.bomber'], destination(capPt, 200, 60), {
    count: 2,
    status: 'moving',
    mission: { kind: 'strike', target: { type: 'point', at: enemyCity } },
    move: moveLeg(destination(capPt, 200, 60), enemyCity, 850, 'air', 0.25),
  });
  const mFrom = destination(capPt, 240, 40);
  own(catalog['demo.cruise'], mFrom, {
    count: 1,
    status: 'moving',
    move: moveLeg(mFrom, enemyCity, 900, 'air', 0.55),
    missile: { target: { type: 'point', at: enemyCity }, impactAt: t + 20 * MINUTE },
  });
  // Missile ennemi détecté par un radar d'alerte.
  const eFrom = destination(enemyCity, 30, 50);
  add({
    owner: enemy,
    level: 'identified',
    pos: eFrom,
    systemId: 'demo.cruise',
    lastSeen: t,
    move: moveLeg(eFrom, capPt, 900, 'air', 0.35),
    missile: { target: { type: 'point', at: capPt }, impactAt: t + 25 * MINUTE },
  });
  // Radar de veille, leurre, ravitaillement coupé, embarqué, combat.
  own(catalog['demo.radar'], destination(capPt, 150, 40));
  const tank = pick('tank');
  const front = destination(capPt, bearing(capPt, enemyCity), Math.min(250, distanceKm(capPt, enemyCity) * 0.6));
  own(tank, destination(front, 90, 10), { decoy: true, count: 12 });
  own(tank, destination(front, 200, 25), { supply: 'cut', status: 'combat', count: 9, hpRatio: 0.28 });
  own(pick('infantry'), destination(front, 330, 30), { supply: 'limited', count: 3 });
  own(pick('infantry'), sea(1), { status: 'embarked', count: 2 });
  add({
    owner: enemy,
    level: 'precise',
    pos: destination(front, 210, 32),
    systemId: tank?.id,
    count: 14,
    hpRatio: 0.62,
    status: 'combat',
  });
  // Sous-marin ennemi détecté (contact sonar).
  add({
    owner: enemy,
    level: 'identified',
    pos: destination(sea(2), 300, 70),
    systemId: 'demo.ssk',
    lastSeen: t - 25 * MINUTE,
    uncertaintyKm: 18,
  });

  // Unités supplémentaires (performance) : réparties dans ~1 500 km autour de la capitale.
  const owners = [me, me, enemy, ally ?? enemy, ...near.slice(0, 12).map((d) => d.nationId)];
  const cats = ['tank', 'ifv', 'infantry', 'artillery', 'air_defense', 'fighter', 'helicopter', 'drone'];
  for (let i = 0; i < (o.extra ?? 0); i++) {
    const s = pick(cats[i % cats.length]!);
    if (!s) continue;
    const owner = owners[Math.floor(rnd() * owners.length)]!;
    const pos = destination(capPt, rnd() * 360, 30 + rnd() * 1500);
    const mineU = owner === me;
    const moving = rnd() < 0.35;
    const lvl = mineU ? 'own' : (['precise', 'identified', 'detected'] as const)[Math.floor(rnd() * 3)]!;
    const u = add({
      owner,
      level: lvl,
      pos,
      lastSeen: mineU ? t : t - rnd() * 3 * HOUR,
      uncertaintyKm: lvl === 'detected' ? 10 + rnd() * 30 : 0,
      ...(lvl !== 'detected' ? { systemId: s.id } : {}),
      ...(lvl === 'own' || lvl === 'precise'
        ? { count: Math.max(1, Math.round(rnd() * 20)), hpRatio: 0.3 + rnd() * 0.7, status: 'idle' as const }
        : {}),
    });
    if (moving && lvl !== 'detected') {
      const air = s.movement === 'air';
      u.move = moveLeg(pos, destination(pos, rnd() * 360, air ? 400 : 120), air ? s.speedKmh : 40, air ? 'air' : 'land', rnd() * 0.5);
      if (u.status) u.status = 'moving';
    }
  }

  // ——— Provinces ———
  const provinces: Record<string, ProvinceView> = { ...view.provinces };
  const setP = (id: string, patch: Partial<ProvinceView>) => {
    const p = provinces[id];
    if (p) provinces[id] = { ...p, ...patch };
  };
  // Capitale : fortifiée, bâtiments de niveau, dont un endommagé et un en réparation.
  const capView = provinces[cap.id];
  if (capView) {
    const extraB: BuildingType[] = ['radar_station', 'bunker', 'hospital', 'local_industry'];
    const buildings = [...new Set([...capView.buildings, ...extraB])];
    const state: BuildingView[] = buildings.map((b, i) => ({
      type: b,
      level: 1 + (i % 4),
      health: i === 1 ? 0.45 : i === 3 ? 0 : 1,
      repairUntil: i === 2 ? t + 3 * HOUR : null,
      upgradeUntil: i === 5 ? t + 5 * HOUR : null,
    }));
    setP(cap.id, {
      buildings,
      buildingState: state,
      fortification: { provinceId: cap.id, level: 3, completesAt: null },
    });
  }
  // Toutes les autres provinces du joueur : quelques nouveaux bâtiments.
  mineDefs.slice(0, 40).forEach((d, i) => {
    const p = provinces[d.id];
    if (!p || d.id === cap.id) return;
    const add1 = BUILDING_TYPES[(i * 5) % BUILDING_TYPES.length]!;
    const add2 = BUILDING_TYPES[(i * 7 + 3) % BUILDING_TYPES.length]!;
    setP(d.id, { buildings: [...new Set([...p.buildings, add1, add2])] });
  });
  // Renseignement progressif sur les provinces étrangères (proches = mieux connues).
  for (const d of near) {
    const p = provinces[d.id];
    if (!p) continue;
    const km = distanceKm(d.cityPoint, capPt);
    const level = (km < 500 ? 3 : km < 900 ? 2 : km < 1500 ? 1 : 0) as 0 | 1 | 2 | 3;
    const all = p.buildings;
    const shown = level === 0 ? [] : level === 1 ? all.slice(0, Math.ceil(all.length / 3)) : all;
    setP(d.id, {
      buildings: shown,
      intel: {
        level,
        economic: level >= 1,
        military: level >= 2,
        updatedAt: km > 700 && km < 900 ? t - 36 * HOUR : t - 2 * HOUR,
      },
    });
  }
  // Territoires disputés, révolte, blocus, zone d'exclusion aérienne.
  const enemyNear = enemyDefs.slice(0, 6);
  enemyNear.slice(0, 2).forEach((d) => setP(d.id, { disputedId: 'demo-zone' }));
  if (mineDefs[3]) setP(mineDefs[3].id, { disputedId: 'demo-zone', unrest: 35 });
  if (enemyNear[2]) setP(enemyNear[2].id, { unrest: 80 });
  const coastal = enemyDefs.find((d) => d.coastal);
  if (coastal) setP(coastal.id, { blockaded: true });
  if (enemyNear[3]) setP(enemyNear[3].id, { noFlyZone: true });
  if (enemyNear[4]) setP(enemyNear[4].id, { noFlyZone: true });

  // Passage de satellite au-dessus du territoire ennemi.
  const sc = destination(enemyCity, 0, 60);
  const footprint: LngLat[] = [
    destination(sc, 300, 260),
    destination(sc, 330, 330),
    destination(sc, 120, 260),
    destination(sc, 150, 330),
  ];
  const satellites = [{ unitId: 'sat-demo', nextPassAt: t + 40 * MINUTE, footprint: [footprint[0]!, footprint[1]!, footprint[2]!, footprint[3]!] }];
  // Ordre de passage cohérent (quadrilatère convexe).
  satellites[0]!.footprint = [footprint[0]!, footprint[1]!, footprint[3]!, footprint[2]!];

  useGame.setState((s) => ({
    view: s.view ? { ...s.view, nations, units, provinces, satellites } : s.view,
    viewVersion: s.viewVersion + 1,
  }));

  // Révélation différée d'un bâtiment ennemi (animation de découverte).
  const target = near.find((d) => provinces[d.id]?.intel && (provinces[d.id]!.intel!.level ?? 0) >= 2);
  if (target)
    setTimeout(() => {
      const v = useGame.getState().view;
      const p = v?.provinces[target.id];
      if (!v || !p) return;
      const nb = [...new Set([...p.buildings, 'missile_silo' as BuildingType, 'air_defense_site' as BuildingType])];
      useGame.setState((s) => ({
        view: s.view
          ? { ...s.view, provinces: { ...s.view.provinces, [target.id]: { ...p, buildings: nb } } }
          : s.view,
        viewVersion: s.viewVersion + 1,
      }));
    }, 2500);
  return { me, enemy, ally, units: Object.keys(units).length, revealAt: target?.cityPoint ?? null };
}

/** Nations utiles pour des captures (diagnostic). */
export function demoNations(): NationId[] {
  return Object.keys(useGame.getState().view?.nations ?? {});
}
