// Audit de bout en bout des ordres sur les VRAIES données (carte, catalogue, équilibrage, recherche,
// ORBAT 2025, scénario « world-today ») : pour chaque famille de matériel, l'ordre est-il accepté
// quand il doit l'être, refusé avec une raison claire sinon, et suivi d'effet (décollage, tir,
// impact, dégâts, notifications) ? Scénarios : Russie / Ukraine, France / Belgique, Algérie / Maroc.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  destination,
  distanceKm,
  type GameNotification,
  type LngLat,
  type NationId,
  type Order,
} from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { sightLevel, unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { mil } from '../src/modules/mil/state.js';
import { destroyUnit } from '../src/combat/combat.js';
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
/** Province de `n` dont la ville est la plus proche de `p`. */
function nearestProv(n: NationId, p: LngLat): string {
  const W = wi(world);
  let best = '';
  let bd = Infinity;
  for (const pid of W.provsByNation.get(n) ?? []) {
    const d = distanceKm(W.provById.get(pid)!.cityPoint, p);
    if (d < bd) {
      bd = d;
      best = pid;
    }
  }
  return best;
}
const city = (pid: string): LngLat => wi(world).provById.get(pid)!.cityPoint;
/** Ville frontalière de `n` face à `m` et ville de `m` en face. */
function frontier(n: NationId, m: NationId): { a: LngLat; b: LngLat; pa: string; pb: string } {
  const pa = nearestProv(n, capital(m));
  const pb = nearestProv(m, city(pa));
  return { a: city(pa), b: city(pb), pa, pb };
}

interface Spec {
  owner: NationId;
  systemId: string;
  pos: LngLat;
  count: number;
}
function game(units: Spec[], seed = 1): EngineState {
  return createGame(world, {
    seed,
    players: [
      { nationId: 'rus', isAi: false },
      { nationId: 'ukr', isAi: false },
      { nationId: 'fra', isAi: false },
      { nationId: 'bel', isAi: false },
      { nationId: 'dza', isAi: false },
      { nationId: 'mar', isAi: false },
    ],
    scenario: data.scenario,
    units,
  }) as EngineState;
}
const pos = (s: EngineState, id: string): LngLat => unitPosAt(s, s.units[id]!, s.time);
const ms = (s: EngineState, id: string) => mil(s).ms[id];
function run(s: EngineState, ms_: number): GameNotification[] {
  const out: GameNotification[] = [];
  const end = s.time + ms_;
  while (s.time < end) out.push(...advanceTo(s, Math.min(end, s.time + 5 * MINUTE)));
  return out;
}
const missiles = (s: EngineState, owner: NationId) =>
  Object.values(s.units).filter((u) => u.owner === owner && u.role === 'missile');
const hpOf = (s: EngineState, id: string): number => s.units[id]?.hp ?? 0;
const order = (s: EngineState, n: NationId, o: Order) => applyOrder(s, n, o);

describe('audit des ordres — missiles de frappe (Russie / Ukraine)', () => {
  it('« attaquer » avec une pile d’Iskander-M : salve dimensionnée, tir, impact', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.iskander-m', pos: f.a, count: 200 },
      { owner: 'ukr', systemId: 'eu.infantry-light', pos: f.b, count: 5 },
      // Observateur russe à côté de la cible (la cible doit être vue pour être attaquée).
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    expect(distanceKm(f.a, f.b)).toBeLessThan(500);
    expect(sightLevel(s, 'rus', 'u2')).toBeGreaterThan(0);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: true });
    // Salve dimensionnée (pas toute la pile de 200 missiles).
    const fired = missiles(s, 'rus').reduce((a, m) => a + m.count, 0);
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(200);
    expect(s.units.u1!.count).toBe(200 - fired);
    const notes = run(s, 30 * MINUTE);
    expect(notes.some((x) => x.kind === 'missile_launch')).toBe(true);
    expect(missiles(s, 'rus')).toHaveLength(0);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('missile hors de portée : refus clair avec distance et portée', () => {
    const s = game([
      { owner: 'rus', systemId: 'ru.iskander-m', pos: capital('rus'), count: 10 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: capital('ukr'), count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(capital('ukr'), 0, 20), count: 1 },
    ]);
    expect(sightLevel(s, 'rus', 'u2')).toBeGreaterThan(0);
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: false, error: 'out_of_range', reason: 'missile_out_of_range' });
    expect(r.params?.range).toBe(500);
    expect(r.message).toMatch(/portée/);
  });

  it('cible invisible : refus « hors de vue » explicite', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.iskander-m', pos: f.a, count: 10 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: capital('ukr'), count: 10 },
    ]);
    expect(sightLevel(s, 'rus', 'u2')).toBe(0);
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: false, reason: 'target_not_visible' });
  });

  it('frappe sur un point et sur une province (bâtiment) acceptées', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.iskander-m', pos: f.a, count: 20 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
    ]);
    const r = order(s, 'rus', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'point', at: f.b },
      count: 4,
    });
    expect(r.ok).toBe(true);
    expect(s.units.u1!.count).toBe(16);
    run(s, 20 * MINUTE);
    expect(hpOf(s, 'u2')).toBeLessThan(s.units.u2!.maxHp);
  });
});

describe('audit des ordres — défense antiaérienne (S-400, SAMP/T)', () => {
  it('S-400 contre un blindé : refus « cibles aériennes uniquement »', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.s-400', pos: destination(f.b, 0, 40), count: 4 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
    ]);
    expect(sightLevel(s, 'rus', 'u2')).toBeGreaterThan(0);
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: false, reason: 'air_defense_air_only' });
    expect(r.message).toMatch(/antiaérienne/);
  });

  it('S-400 contre un avion visible à portée : tire et touche', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.s-400', pos: f.a, count: 4 },
      { owner: 'ukr', systemId: 'ru.su-27', pos: f.b, count: 6 },
    ]);
    // L'avion ukrainien décolle et patrouille à 60 km du S-400.
    const at = destination(f.a, 270, 60);
    expect(order(s, 'ukr', { kind: 'patrol', unitIds: ['u2'], at, radiusKm: 20 }).ok).toBe(true);
    run(s, 15 * MINUTE);
    expect(ms(s, 'u2')!.up).toBe(true);
    expect(sightLevel(s, 'rus', 'u2')).toBeGreaterThan(0);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r.ok).toBe(true);
    run(s, 10 * MINUTE);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('S-400 contre un avion hors de portée de tir : refus clair, pas de poursuite', () => {
    const s = game([
      { owner: 'rus', systemId: 'ru.s-400', pos: capital('rus'), count: 4 },
      { owner: 'ukr', systemId: 'ru.su-27', pos: capital('ukr'), count: 6 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(capital('ukr'), 0, 30), count: 1 },
    ]);
    const at = destination(capital('ukr'), 45, 50);
    expect(order(s, 'ukr', { kind: 'patrol', unitIds: ['u2'], at, radiusKm: 20 }).ok).toBe(true);
    run(s, 10 * MINUTE);
    expect(sightLevel(s, 'rus', 'u2')).toBeGreaterThan(0);
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: false, reason: 'out_of_weapon_range' });
    expect(s.units.u1!.move).toBeNull();
  });

  it('sélection mixte (char + SAMP/T) contre un blindé : exécution partielle signalée', () => {
    const f = frontier('fra', 'bel');
    const s = game([
      { owner: 'fra', systemId: 'eu.leclerc', pos: f.a, count: 10 },
      { owner: 'fra', systemId: 'eu.samp-t', pos: f.a, count: 2 },
      { owner: 'bel', systemId: 'eu.infantry-light', pos: f.b, count: 5 },
      { owner: 'fra', systemId: 'eu.ground-master-400', pos: f.a, count: 1 },
    ]);
    expect(sightLevel(s, 'fra', 'u3')).toBeGreaterThan(0);
    const r = order(s, 'fra', { kind: 'attack', unitIds: ['u1', 'u2'], targetId: 'u3' });
    expect(r).toMatchObject({ ok: true, reason: 'partial' });
    expect(s.units.u1!.target).toBe('u3');
    expect(s.units.u2!.target).toBeNull();
  });
});

describe('audit des ordres — aviation (décollage, frappe, retour)', () => {
  it('Su-34 posé : « attaquer » un char = décollage, frappe, dégâts, retour', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.su-34', pos: f.a, count: 6 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    expect(ms(s, 'u1')!.up).toBe(false);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r).toMatchObject({ ok: true });
    expect(ms(s, 'u1')!.up).toBe(true);
    expect(ms(s, 'u1')!.mis).toBe('strike');
    expect(viewFor(s, 'rus').units.u1!.mission?.kind).toBe('strike');
    run(s, 30 * MINUTE);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
    run(s, 2 * HOUR);
    expect(ms(s, 'u1')!.up).toBe(false);
  });

  it('Rafale contre un chasseur belge en vol : interception (décollage, poursuite, tir)', () => {
    const f = frontier('fra', 'bel');
    const s = game([
      { owner: 'fra', systemId: 'eu.rafale', pos: f.a, count: 6 },
      { owner: 'bel', systemId: 'us.f-16', pos: f.b, count: 6 },
      { owner: 'fra', systemId: 'eu.ground-master-400', pos: f.a, count: 1 },
    ]);
    const at = destination(f.b, 0, 40);
    expect(order(s, 'bel', { kind: 'patrol', unitIds: ['u2'], at, radiusKm: 20 }).ok).toBe(true);
    run(s, 10 * MINUTE);
    expect(sightLevel(s, 'fra', 'u2')).toBeGreaterThan(0);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'fra', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r.ok).toBe(true);
    expect(ms(s, 'u1')!.up).toBe(true);
    expect(s.units.u1!.target).toBe('u2');
    run(s, 30 * MINUTE);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('Su-30 algérien : frappe sur un point au Maroc', () => {
    const f = frontier('dza', 'mar');
    const s = game([
      { owner: 'dza', systemId: 'ru.su-30', pos: f.a, count: 6 },
      { owner: 'mar', systemId: 'eu.infantry-light', pos: f.b, count: 6 },
    ]);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'dza', {
      kind: 'strike',
      unitIds: ['u1'],
      target: { type: 'point', at: f.b },
    });
    expect(r.ok).toBe(true);
    expect(ms(s, 'u1')!.up).toBe(true);
    run(s, HOUR);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('hélicoptère Ka-52 posé : « attaquer » un char proche', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.ka-52', pos: f.a, count: 6 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    const hp0 = hpOf(s, 'u2');
    expect(order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
    run(s, 2 * HOUR);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('chasseur en patrouille : une attaque hors de sa zone n’est pas annulée par la veille', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.su-34', pos: f.a, count: 6 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    const cap = destination(f.a, 45, 60);
    expect(order(s, 'rus', { kind: 'patrol', unitIds: ['u1'], at: cap, radiusKm: 30 }).ok).toBe(
      true,
    );
    run(s, 20 * MINUTE);
    const hp0 = hpOf(s, 'u2');
    expect(order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
    run(s, 40 * MINUTE);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('frappe aérienne dont la cible disparaît : notification « Frappe annulée »', () => {
    const f = frontier('rus', 'ukr');
    const s = game([
      { owner: 'rus', systemId: 'ru.su-34', pos: f.a, count: 6 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    expect(order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
    // La cible est détruite (par un autre moyen) avant l'arrivée des avions.
    destroyUnit(s, s.units.u2!, null);
    const notes = run(s, 3 * HOUR);
    const own = notes.filter(
      (x) => x.kind === 'generic' && x.category === 'strike' && x.title === 'Frappe annulée',
    );
    expect(own.length).toBeGreaterThan(0);
  });
});

describe('audit des ordres — terre, artillerie, marine', () => {
  it('artillerie CAESAR : tir à portée, poursuite hors de portée', () => {
    const f = frontier('fra', 'bel');
    const s = game([
      { owner: 'fra', systemId: 'eu.caesar', pos: destination(f.b, 180, 30), count: 12 },
      { owner: 'bel', systemId: 'eu.infantry-light', pos: f.b, count: 5 },
      { owner: 'fra', systemId: 'eu.ground-master-400', pos: f.a, count: 1 },
    ]);
    const hp0 = hpOf(s, 'u2');
    expect(order(s, 'fra', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' }).ok).toBe(true);
    run(s, HOUR);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('déplacement, arrêt, posture, scission, fusion, ravitaillement (retour à une ville amie)', () => {
    const f = frontier('fra', 'bel');
    const s = game([{ owner: 'fra', systemId: 'eu.leclerc', pos: f.a, count: 20 }]);
    const to = destination(f.a, 200, 60);
    expect(order(s, 'fra', { kind: 'move', unitIds: ['u1'], to }).ok).toBe(true);
    run(s, 20 * MINUTE);
    const p1 = pos(s, 'u1');
    expect(distanceKm(p1, f.a)).toBeGreaterThan(1);
    expect(order(s, 'fra', { kind: 'stop', unitIds: ['u1'] }).ok).toBe(true);
    run(s, 20 * MINUTE);
    expect(distanceKm(pos(s, 'u1'), p1)).toBeLessThan(1);
    expect(order(s, 'fra', { kind: 'stance', unitIds: ['u1'], stance: 'hold' }).ok).toBe(true);
    expect(s.units.u1!.stance).toBe('hold');
    expect(order(s, 'fra', { kind: 'split', unitId: 'u1', count: 8 }).ok).toBe(true);
    const parts = Object.values(s.units).filter((u: Unit) => u.sys === 'eu.leclerc');
    expect(parts.map((u) => u.count).sort((a, b) => a - b)).toEqual([8, 12]);
    expect(order(s, 'fra', { kind: 'merge', unitIds: parts.map((u) => u.id) }).ok).toBe(true);
    // Ravitaillement : retour vers la ville amie la plus proche (troupes au sol comprises).
    expect(order(s, 'fra', { kind: 'move', unitIds: ['u1'], to: destination(f.a, 200, 40) }).ok);
    run(s, HOUR);
    const r = order(s, 'fra', { kind: 'rtb', unitIds: ['u1'] });
    expect(r.ok).toBe(true);
    expect(s.units.u1!.move).not.toBeNull();
  });

  it('frégate Amiral Gorchkov : « attaquer » une cible à terre hors de portée = missiles de croisière', () => {
    const f = frontier('rus', 'ukr');
    const coast = [...(wi(world).provsByNation.get('rus') ?? [])]
      .map((pid) => ({ pid, sea: wi(world).seaSpawn.get(pid) }))
      .filter((x): x is { pid: string; sea: LngLat } => !!x.sea)
      .sort((a, b) => distanceKm(a.sea, f.b) - distanceKm(b.sea, f.b))[0]!;
    const s = game([
      { owner: 'rus', systemId: 'ru.admiral-gorshkov', pos: coast.sea, count: 1 },
      { owner: 'ukr', systemId: 'ru.t-72', pos: f.b, count: 10 },
      { owner: 'rus', systemId: 'ru.p-18', pos: destination(f.b, 90, 30), count: 1 },
    ]);
    const d = distanceKm(coast.sea, f.b);
    expect(d).toBeGreaterThan(150);
    const hp0 = hpOf(s, 'u2');
    const r = order(s, 'rus', { kind: 'attack', unitIds: ['u1'], targetId: 'u2' });
    expect(r.ok).toBe(true);
    expect(missiles(s, 'rus').length).toBeGreaterThan(0);
    run(s, 2 * HOUR);
    expect(hpOf(s, 'u2')).toBeLessThan(hp0);
  });

  it('navire en patrouille puis déplacé : il ne revient pas à sa zone de patrouille', () => {
    const coast = [...(wi(world).provsByNation.get('fra') ?? [])]
      .map((pid) => wi(world).seaSpawn.get(pid))
      .filter((x): x is LngLat => !!x)[0]!;
    const s = game([{ owner: 'fra', systemId: 'eu.fremm', pos: coast, count: 1 }]);
    const zone = destination(coast, 270, 40);
    expect(order(s, 'fra', { kind: 'patrol', unitIds: ['u1'], at: zone, radiusKm: 30 }).ok).toBe(
      true,
    );
    run(s, 2 * HOUR);
    const there = destination(coast, 270, 15);
    expect(order(s, 'fra', { kind: 'move', unitIds: ['u1'], to: there }).ok).toBe(true);
    run(s, 4 * HOUR);
    expect(distanceKm(pos(s, 'u1'), there)).toBeLessThan(5);
    expect(ms(s, 'u1')?.mis ?? 'none').toBe('none');
  });
});
