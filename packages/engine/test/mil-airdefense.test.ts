// Défense antiaérienne sur les VRAIES données (carte, catalogue, équilibrage, scénario « world-today ») :
// enveloppes par catégorie de menace (avions, hélicoptères, drones, missiles de croisière, balistiques,
// hypersoniques), engagement automatique par priorité, saturation, magasin et rechargement, ordres
// manuels et refus, déterminisme et reprise, anciennes sauvegardes, IA. Voir docs/defense-aerienne.md.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AIR_THREATS,
  HOUR,
  MINUTE,
  airDefenseTable,
  bearing,
  destination,
  distanceKm,
  type LngLat,
  type NationId,
  type Order,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  battleReportFor,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { atWar, sightLevel } from '../src/state/access.js';
import { declareWar } from '../src/state/war.js';
import { wi } from '../src/state/world.js';
import { mil } from '../src/modules/mil/state.js';
import { loadRealData, type RealData } from '../bench/load.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
}, 120_000);

const capital = (n: NationId): LngLat => {
  const W = wi(world);
  return W.provById.get(W.nationById.get(n)!.capitalProvinceId)!.cityPoint;
};

interface Spec {
  owner: NationId;
  systemId: string;
  pos: LngLat;
  count: number;
}

/** Partie Russie / Ukraine en guerre (déclarée), unités de test seulement. */
function game(units: Spec[], opts: { seed?: number; ai?: NationId[] } = {}): EngineState {
  const s = createGame(world, {
    seed: opts.seed ?? 1,
    players: [
      { nationId: 'rus', isAi: opts.ai?.includes('rus') ?? false, aiLevel: 'hard' },
      { nationId: 'ukr', isAi: opts.ai?.includes('ukr') ?? false, aiLevel: 'hard' },
    ],
    scenario: data.scenario,
    units,
  }) as EngineState;
  declareWar(s, 'rus', 'ukr');
  return s;
}

function run(s: EngineState, ms: number, step = 5 * MINUTE): void {
  const end = s.time + ms;
  while (s.time < end) advanceTo(s, Math.min(end, s.time + step));
}

const order = (s: EngineState, n: NationId, o: Order) => applyOrder(s, n, o);
const salvos = (s: EngineState, owner: NationId) =>
  Object.values(s.units).filter((u: Unit) => u.owner === owner && u.role === 'missile');
const intercepted = (s: EngineState, n: NationId) => mil(s).stats[n]?.intercepted ?? 0;
const ammo = (s: EngineState, n: NationId, id: string) => viewFor(s, n).units[id]?.airDefense;

/** Menaces abattues par catégorie, cumulées sur tous les rapports de bataille du camp `n`. */
function interceptsOf(s: EngineState, n: NationId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(mil(s).battles)) {
    const side = battleReportFor(s, n, id)?.aar?.sides.find((x) => x.own);
    for (const [c, v] of Object.entries(side?.intercepts ?? {})) out[c] = (out[c] ?? 0) + v;
  }
  return out;
}

/** Intercepteurs tirés (tous camps, tous rapports). */
function fired(s: EngineState): number {
  let n = 0;
  for (const b of Object.values(mil(s).battles)) n += (b.x?.a.ifd ?? 0) + (b.x?.d.ifd ?? 0);
  return n;
}

/** Point à `km` de `at` (dans la direction donnée). */
const from = (at: LngLat, km: number, dir = 270): LngLat => destination(at, dir, km);

interface Front {
  a: LngLat;
  b: LngLat;
}
/** Ville russe la plus proche de Kyiv (a) et ville ukrainienne en face (b). */
function frontier(): Front {
  const W = wi(world);
  const near = (n: NationId, p: LngLat): LngLat => {
    let best: LngLat = p;
    let bd = Infinity;
    for (const pid of W.provsByNation.get(n) ?? []) {
      const c = W.provById.get(pid)!.cityPoint;
      const d = distanceKm(c, p);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  const a = near('rus', capital('ukr'));
  return { a, b: near('ukr', a) };
}
/** Point en Russie à `km` de la ville frontalière, à l'opposé de l'Ukraine. */
const inward = (F: Front, km: number): LngLat => destination(F.a, bearing(F.b, F.a), km);
/** Point vers l'Ukraine à `km` de la ville frontalière russe. */
const outward = (F: Front, km: number): LngLat => destination(F.a, bearing(F.a, F.b), km);
const strikeAt = (id: string, at: LngLat): Order => ({
  kind: 'strike',
  unitIds: [id],
  target: { type: 'point', at },
});

describe('catalogue : enveloppes de la défense antiaérienne', () => {
  it('chaque système à fiche interceptor a des enveloppes cohérentes avec sa portée d’arme', () => {
    const ad = data.catalog.filter((s) => s.category === 'air_defense' && s.interceptor);
    expect(ad.length).toBeGreaterThan(30);
    for (const s of ad) {
      const t = airDefenseTable(s)!;
      expect(t.explicit, s.id).toBe(true);
      expect(t.lines.length, s.id).toBeGreaterThan(0);
      for (const l of t.lines) {
        expect(l.maxKm, `${s.id} ${l.threat}`).toBeLessThanOrEqual(s.weaponRangeKm.max);
        expect(l.minKm, `${s.id} ${l.threat}`).toBeGreaterThanOrEqual(s.weaponRangeKm.min);
        expect(l.minKm).toBeLessThan(l.maxKm);
      }
    }
    const cats = (id: string) =>
      airDefenseTable(data.catalog.find((s) => s.id === id)!)!.lines.map((l) => l.threat);
    // Hypersoniques : seulement les systèmes qui en sont réellement capables.
    const hyper = ad.filter((s) => cats(s.id).includes('hypersonic')).map((s) => s.id);
    expect(hyper.sort()).toEqual(['ru.s-500', 'us.patriot']);
    expect(cats('ru.s-400')).toEqual([
      'aircraft',
      'helicopter',
      'drone',
      'cruise_missile',
      'ballistic_missile',
    ]);
    expect(cats('ru.pantsir-s1')).not.toContain('ballistic_missile');
    expect(cats('ru.tor-m2')).not.toContain('ballistic_missile');
    expect(cats('eu.iris-t-slm')).not.toContain('ballistic_missile');
    expect(cats('us.thaad')).toEqual(['ballistic_missile']);
    expect(cats('other.iron-dome')).toEqual(['drone', 'cruise_missile']);
    // S-400 : 40N6 très longue portée contre avions, portée réduite contre balistiques.
    const s400 = airDefenseTable(data.catalog.find((s) => s.id === 'ru.s-400')!)!;
    const by = Object.fromEntries(s400.lines.map((l) => [l.threat, l]));
    expect(by.aircraft!.maxKm).toBe(380);
    expect(by.ballistic_missile!.maxKm).toBeLessThan(100);
    expect(by.ballistic_missile!.shots).toBe(2);
    expect(AIR_THREATS).toHaveLength(6);
  });
});

describe('engagement automatique', () => {
  it('S-400 : abat un avion entré dans sa bulle et intercepte une salve de missiles de croisière', () => {
    const F = frontier();
    const at = inward(F, 20);
    const s = game([
      { owner: 'rus', systemId: 'ru.s-400', pos: at, count: 2 }, // u1
      { owner: 'ukr', systemId: 'ru.su-27', pos: F.b, count: 4 }, // u2
      { owner: 'ukr', systemId: 'us.tomahawk', pos: outward(F, 300), count: 8 }, // u3
    ]);
    const max0 = ammo(s, 'rus', 'u1')!.max;
    expect(ammo(s, 'rus', 'u1')).toEqual({ ammo: max0, max: max0, fullAt: null });
    // Patrouille ukrainienne à ~60 km de la batterie (dans l'enveloppe « avions » : 3–380 km).
    const cap = destination(at, bearing(at, F.b), 60);
    expect(order(s, 'ukr', { kind: 'patrol', unitIds: ['u2'], at: cap, radiusKm: 15 }).ok).toBe(
      true,
    );
    const hp0 = s.units.u2!.hp;
    run(s, 40 * MINUTE);
    const su = s.units.u2;
    expect(!su || su.hp < hp0).toBe(true);
    expect(interceptsOf(s, 'rus').aircraft ?? 0).toBeGreaterThan(0);
    // Magasin entamé : les intercepteurs tirés sont décomptés, rechargement en cours.
    const a = ammo(s, 'rus', 'u1')!;
    expect(a.ammo).toBeLessThan(a.max);
    expect(a.fullAt).toBeGreaterThan(s.time);
    // Salve de 8 Tomahawk visant la zone de la batterie : enveloppe « croisière » (3–40 km).
    expect(order(s, 'ukr', strikeAt('u3', inward(F, 26))).ok).toBe(true);
    const before = intercepted(s, 'rus');
    run(s, 60 * MINUTE, MINUTE);
    expect(salvos(s, 'ukr')).toHaveLength(0);
    expect(intercepted(s, 'rus')).toBeGreaterThan(before);
    expect(interceptsOf(s, 'rus').cruise_missile ?? 0).toBeGreaterThan(0);
    // Effets sur la carte : tirs d'interception enregistrés (traceurs, explosions).
    const shots = Object.values(mil(s).battles).flatMap((b) => b.shots);
    expect(shots.some((x) => x.cls === 'missile' && x.hit)).toBe(true);
    expect(shots.some((x) => x.cls === 'aircraft')).toBe(true);
  });

  it('Pantsir-S1 : abat des drones (munitions rôdeuses Shahed et drone armé TB2)', () => {
    const F = frontier();
    const at = inward(F, 20);
    const near = destination(F.b, 0, 8);
    const s = game([
      { owner: 'rus', systemId: 'ru.pantsir-s1', pos: at, count: 2 }, // u1
      { owner: 'ukr', systemId: 'other.shahed-136', pos: outward(F, 200), count: 6 }, // u2
      { owner: 'ukr', systemId: 'other.bayraktar-tb2', pos: F.b, count: 2 }, // u3
      { owner: 'rus', systemId: 'ru.pantsir-s1', pos: destination(near, 90, 6), count: 1 }, // u4
    ]);
    expect(order(s, 'ukr', strikeAt('u2', inward(F, 25))).ok).toBe(true);
    run(s, 3 * HOUR);
    expect(salvos(s, 'ukr')).toHaveLength(0);
    expect(intercepted(s, 'rus')).toBeGreaterThanOrEqual(3);
    // Drone armé en patrouille au-dessus d'une batterie (enveloppe « drones » : 0–20 km).
    expect(order(s, 'ukr', { kind: 'patrol', unitIds: ['u3'], at: near, radiusKm: 4 }).ok).toBe(
      true,
    );
    const hp0 = s.units.u3!.hp;
    run(s, 2 * HOUR);
    const tb = s.units.u3;
    expect(!tb || tb.hp < hp0).toBe(true);
    expect(interceptsOf(s, 'rus').drone ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('un système sans capacité balistique laisse passer un Iskander ; le Patriot l’intercepte', () => {
    const k = capital('ukr');
    const shoot = (systemId: string) => {
      const at = from(k, 30, 180);
      const s = game([
        { owner: 'ukr', systemId, pos: at, count: 2 }, // u1
        { owner: 'rus', systemId: 'ru.iskander-m', pos: from(at, 250, 90), count: 8 }, // u2
      ]);
      expect(order(s, 'rus', strikeAt('u2', from(at, 6, 0))).ok).toBe(true);
      // La salve est vue par la batterie avant l'impact (radar).
      let seen = false;
      for (let i = 0; i < 40 && salvos(s, 'rus').length; i++) {
        advanceTo(s, s.time + 5000);
        seen ||= salvos(s, 'rus').some((u) => sightLevel(s, 'ukr', u.id) > 0);
      }
      run(s, 10 * MINUTE, MINUTE);
      expect(salvos(s, 'rus')).toHaveLength(0);
      return { seen, killed: intercepted(s, 'ukr'), ic: interceptsOf(s, 'ukr') };
    };
    const iris = shoot('eu.iris-t-slm');
    expect(iris.seen).toBe(true);
    expect(iris.killed).toBe(0);
    const pantsir = shoot('ru.pantsir-s1');
    expect(pantsir.killed).toBe(0);
    const patriot = shoot('us.patriot');
    expect(patriot.killed).toBeGreaterThan(0);
    expect(patriot.ic.ballistic_missile).toBe(patriot.killed);
  });

  it('hypersonique : le S-400 laisse passer un Kinzhal, le Patriot (PAC-3) peut l’engager', () => {
    const k = capital('ukr');
    const shoot = (systemId: string) => {
      const at = from(k, 30, 180);
      const s = game([
        { owner: 'ukr', systemId, pos: at, count: 3 }, // u1
        { owner: 'rus', systemId: 'ru.kinzhal', pos: from(at, 400, 90), count: 12 }, // u2
      ]);
      expect(order(s, 'rus', strikeAt('u2', from(at, 6, 0))).ok).toBe(true);
      run(s, 20 * MINUTE, MINUTE);
      return { fired: fired(s), killed: intercepted(s, 'ukr') };
    };
    const s400 = shoot('ru.s-400');
    expect(s400.fired).toBe(0);
    expect(s400.killed).toBe(0);
    const patriot = shoot('us.patriot');
    expect(patriot.fired).toBeGreaterThan(0);
  });
});

describe('saturation, magasin et rechargement', () => {
  it('trop de menaces pour une batterie : certaines passent ; plus de batteries ⇒ plus d’interceptions', () => {
    const F = frontier();
    const at = inward(F, 20);
    const salvo = (batteries: number) => {
      const units: Spec[] = [
        { owner: 'ukr', systemId: 'other.shahed-136', pos: outward(F, 150), count: 24 },
      ];
      for (let i = 0; i < batteries; i++)
        units.push({ owner: 'rus', systemId: 'ru.pantsir-s1', pos: from(at, 2 * i, 0), count: 1 });
      const s = game(units);
      expect(order(s, 'ukr', strikeAt('u1', inward(F, 26))).ok).toBe(true);
      run(s, 3 * HOUR, MINUTE);
      expect(salvos(s, 'ukr')).toHaveLength(0);
      return { s, killed: intercepted(s, 'rus') };
    };
    const one = salvo(1);
    // Un Pantsir : 12 missiles, 4 canaux par fenêtre de 3 min ⇒ saturation, des drones passent.
    expect(one.killed).toBeGreaterThan(0);
    expect(one.killed).toBeLessThan(24);
    let saturation = 0;
    for (const id of Object.keys(mil(one.s).battles)) {
      for (const c of battleReportFor(one.s, 'rus', id)!.countermeasures)
        if (c.kind === 'saturation') saturation += c.count;
    }
    expect(saturation).toBeGreaterThan(0);
    const three = salvo(3);
    expect(three.killed).toBeGreaterThan(one.killed);
  });

  it('magasin épuisé : refus d’ordre « plus d’intercepteurs », puis rechargement progressif', () => {
    const F = frontier();
    const at = inward(F, 20);
    const s = game([
      { owner: 'rus', systemId: 'ru.pantsir-s1', pos: at, count: 1 }, // u1
      { owner: 'ukr', systemId: 'other.shahed-136', pos: outward(F, 150), count: 30 }, // u2
      { owner: 'ukr', systemId: 'other.shahed-136', pos: outward(F, 150), count: 6 }, // u3
    ]);
    expect(order(s, 'ukr', strikeAt('u2', inward(F, 26))).ok).toBe(true);
    let empty = false;
    let refused = false;
    for (let i = 0; i < 240 && salvos(s, 'ukr').length; i++) {
      advanceTo(s, s.time + MINUTE);
      const a = ammo(s, 'rus', 'u1')!;
      if (a.ammo !== 0) continue;
      empty = true;
      expect(a.fullAt).toBeGreaterThan(s.time);
      const m = salvos(s, 'ukr').find((u) => sightLevel(s, 'rus', u.id) > 0);
      if (m && !refused) {
        const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: m.id });
        if (r.reason === 'ad_no_ammo') {
          refused = true;
          expect(r).toMatchObject({ ok: false, error: 'insufficient_resources' });
          expect(r.message).toMatch(/plus d’intercepteurs/);
        }
      }
    }
    expect(empty).toBe(true);
    expect(refused).toBe(true);
    // Rechargement complet en 2 h (fiche : reloadH), progressif.
    run(s, 2 * HOUR + 10 * MINUTE);
    const a = ammo(s, 'rus', 'u1')!;
    expect(a.ammo).toBe(a.max);
    expect(a.fullAt).toBeNull();
    // La batterie rechargée intercepte de nouveau.
    const before = intercepted(s, 'rus');
    expect(order(s, 'ukr', strikeAt('u3', inward(F, 26))).ok).toBe(true);
    run(s, 3 * HOUR, MINUTE);
    expect(intercepted(s, 'rus')).toBeGreaterThan(before);
  });
});

describe('ordres manuels : acceptés ou refusés avec une raison claire', () => {
  it('refus traduits : catégorie non interceptée, hors de l’enveloppe ; acceptés sinon', () => {
    const F = frontier();
    const at = destination(F.b, 0, 8);
    const s = game([
      { owner: 'rus', systemId: 'ru.pantsir-s1', pos: at, count: 1 }, // u1
      { owner: 'rus', systemId: 'us.thaad', pos: from(at, 5, 0), count: 1 }, // u2
      { owner: 'ukr', systemId: 'other.bayraktar-tb2', pos: F.b, count: 2 }, // u3
      { owner: 'ukr', systemId: 'ru.iskander-m', pos: from(at, 12, 180), count: 2 }, // u4
      { owner: 'rus', systemId: 'ru.s-400', pos: from(at, 3, 270), count: 1 }, // u5
    ]);
    // Toutes les batteries « tiennent » : feu seulement sur ordre (aéronefs).
    expect(
      order(s, 'rus', { kind: 'stance', unitIds: ['u1', 'u2', 'u5'], stance: 'hold' }).ok,
    ).toBe(true);
    // Drone en patrouille à ~32 km du Pantsir : vu (radar du S-400), hors de l'enveloppe « drones ».
    expect(
      order(s, 'ukr', { kind: 'patrol', unitIds: ['u3'], at: from(at, 32, 0), radiusKm: 2 }).ok,
    ).toBe(true);
    run(s, 40 * MINUTE);
    expect(sightLevel(s, 'rus', 'u3')).toBeGreaterThan(0);
    const out = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u3' });
    expect(out).toMatchObject({ ok: false, error: 'out_of_range', reason: 'ad_out_of_range' });
    expect(out.params).toMatchObject({ cat: 'drone', min: 0, max: 20 });
    expect(out.message).toMatch(/hors de portée : \d+ km, portée 0–20 km contre les drones/);
    // THAAD : balistiques seulement.
    const thaad = order(s, 'rus', { kind: 'attack', unitIds: ['u2'], targetId: 'u3' });
    expect(thaad).toMatchObject({
      ok: false,
      reason: 'ad_cannot_engage',
      params: { cat: 'drone' },
    });
    expect(thaad.message).toMatch(/n’intercepte pas les drones/);
    // S-400 sur ordre : accepté, tir immédiat.
    const hp0 = s.units.u3!.hp;
    expect(order(s, 'rus', { kind: 'attack', unitIds: ['u5'], targetId: 'u3' })).toMatchObject({
      ok: true,
    });
    run(s, 10 * MINUTE, MINUTE);
    expect((s.units.u3?.hp ?? 0) < hp0).toBe(true);
    // Salve balistique en vol : le Pantsir refuse (catégorie), sélection mixte = exécution partielle.
    expect(order(s, 'ukr', strikeAt('u4', inward(F, 30))).ok).toBe(true);
    advanceTo(s, s.time + 2000);
    const isk = salvos(s, 'ukr')[0]!;
    expect(sightLevel(s, 'rus', isk.id)).toBeGreaterThan(0);
    const p = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: isk.id });
    expect(p).toMatchObject({
      ok: false,
      reason: 'ad_cannot_engage',
      params: { cat: 'ballistic_missile' },
    });
    expect(p.message).toMatch(/n’intercepte pas les missiles balistiques/);
    const mixed = order(s, 'rus', { kind: 'attack', unitIds: ['u1', 'u5'], targetId: isk.id });
    expect(mixed).toMatchObject({ ok: true, reason: 'partial' });
    expect(mil(s).adf?.[`u5>${isk.id}`]).toBe(1);
  });
});

describe('déterminisme, reprise et anciennes sauvegardes', () => {
  const scenario = (seed: number) => {
    const F = frontier();
    const at = inward(F, 20);
    const s = game(
      [
        { owner: 'rus', systemId: 'ru.s-400', pos: at, count: 1 }, // u1
        { owner: 'rus', systemId: 'ru.pantsir-s1', pos: from(at, 4, 0), count: 1 }, // u2
        { owner: 'ukr', systemId: 'other.shahed-136', pos: outward(F, 150), count: 16 }, // u3
        { owner: 'ukr', systemId: 'us.tomahawk', pos: outward(F, 250), count: 6 }, // u4
        { owner: 'ukr', systemId: 'ru.su-27', pos: F.b, count: 4 }, // u5
      ],
      { seed },
    );
    order(s, 'ukr', strikeAt('u3', inward(F, 26)));
    order(s, 'ukr', strikeAt('u4', inward(F, 24)));
    order(s, 'ukr', {
      kind: 'patrol',
      unitIds: ['u5'],
      at: destination(at, bearing(at, F.b), 70),
      radiusKm: 15,
    });
    return s;
  };

  it('même graine ⇒ même empreinte ; reprise après sérialisation en pleine interception', () => {
    const ref = scenario(5);
    advanceTo(ref, 3 * HOUR);
    const b = scenario(5);
    advanceTo(b, 3 * HOUR);
    expect(stateHash(b)).toBe(stateHash(ref));
    expect(intercepted(ref, 'rus')).toBeGreaterThan(0);
    let s = scenario(5);
    for (const cut of [20 * MINUTE + 7, 50 * MINUTE, 71 * MINUTE + 3, 100 * MINUTE]) {
      advanceTo(s, cut);
      const r = deserializeState(world, serializeState(s)) as EngineState;
      expect(stateHash(r)).toBe(stateHash(s));
      expect(viewFor(r, 'rus')).toEqual(viewFor(s, 'rus'));
      s = r;
    }
    advanceTo(s, 3 * HOUR);
    expect(stateHash(s)).toBe(stateHash(ref));
  });

  it('ancienne sauvegarde (sans champs de défense antiaérienne) : reprise sans erreur', () => {
    const s = scenario(6);
    advanceTo(s, 70 * MINUTE);
    const m = mil(s);
    // Champs optionnels absents (instantané d'avant la défense détaillée).
    delete m.adf;
    for (const bt of Object.values(m.battles)) {
      if (!bt.x) continue;
      delete bt.x.a.ic;
      delete bt.x.a.ifd;
      delete bt.x.d.ic;
      delete bt.x.d.ifd;
    }
    const r = deserializeState(world, serializeState(s)) as EngineState;
    expect(() => advanceTo(r, 3 * HOUR)).not.toThrow();
    for (const id of Object.keys(mil(r).battles))
      expect(battleReportFor(r, 'rus', id)).toBeTruthy();
    expect(viewFor(r, 'rus').units.u1?.airDefense?.max).toBeGreaterThan(0);
    expect(atWar(r, 'rus', 'ukr')).toBe(true);
  });
});

describe('IA : placement de la défense antiaérienne', () => {
  it('en guerre, l’IA envoie ses batteries couvrir sa capitale, ses bases et son front', () => {
    const kc = capital('rus');
    const far = destination(kc, 120, 450);
    const s = game(
      [
        { owner: 'rus', systemId: 'ru.s-400', pos: far, count: 1 }, // u1
        { owner: 'rus', systemId: 'ru.pantsir-s1', pos: far, count: 2 }, // u2
        { owner: 'ukr', systemId: 'ru.t-72', pos: capital('ukr'), count: 4 }, // u3
      ],
      { ai: ['rus'] },
    );
    run(s, 2 * HOUR, 30 * MINUTE);
    const dest = (id: string): LngLat | null => {
      const u = s.units[id];
      if (!u) return null;
      const legs = u.move?.legs;
      return legs?.length ? legs[legs.length - 1]!.to : u.pos;
    };
    const ds = [dest('u1'), dest('u2')];
    expect(ds.every((d) => !!d)).toBe(true);
    // Au moins une batterie redéployée vers un point à protéger.
    expect(ds.filter((d) => distanceKm(d!, far) > 50).length).toBeGreaterThan(0);
  });
});
