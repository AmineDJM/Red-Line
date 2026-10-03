/**
 * Centre de commandement sur les VRAIES données (monde 2025, ORBAT en piles mixtes, réseau de
 * routes) : « Conquérir » prend une province voisine ; « Débarquement » utilise le navire de transport
 * (embarquement, traversée escortée, mise à terre, prise de l'île) ; coût de calcul mesuré. Les
 * provinces sont choisies d'après la carte (voisinage, capitale), jamais par identifiant en dur.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, distanceKm, type LngLat, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { sysOf, unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cmd } from '../src/modules/command/state.js';
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

function ok(s: EngineState, n: string, o: Order): void {
  const r = applyOrder(s, n, o);
  expect(r, `${o.kind}: ${r.message}`).toMatchObject({ ok: true });
}

/** Piles terrestres mobiles d'une nation, les plus proches d'un point. */
function landNear(s: EngineState, n: string, p: LngLat, k: number): Unit[] {
  return Object.values(s.units)
    .filter((u) => {
      if (u.owner !== n || u.off || u.role) return false;
      const sys = sysOf(s, u);
      return sys.movement === 'land' && sys.speedKmh > 0;
    })
    .map((u) => ({ u, d: distanceKm(unitPosAt(s, u, s.time), p) }))
    .sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1))
    .slice(0, k)
    .map((x) => x.u);
}

describe('centre de commandement : vraies données', { timeout: 600_000 }, () => {
  it('Conquérir : le général prend une province belge voisine de la France', () => {
    const s = createGame(world, {
      seed: 5,
      players: [
        { nationId: 'fra', isAi: false },
        { nationId: 'bel', isAi: true },
      ],
      scenario: data.scenario,
    }) as EngineState;
    // Province belge frontalière de la France, hors capitale, la plus proche des forces françaises.
    const w = wi(world);
    const cap = w.nationById.get('bel')!.capitalProvinceId;
    const border = data.map.provinces.filter(
      (p) =>
        p.nationId === 'bel' &&
        p.id !== cap &&
        p.neighbors.some((x) => s.provinces[x]?.owner === 'fra'),
    );
    expect(border.length).toBeGreaterThan(0);
    const scored = border
      .map((p) => {
        const near = landNear(s, 'fra', p.cityPoint, 4);
        const d = near.reduce((a, u) => a + distanceKm(unitPosAt(s, u, s.time), p.cityPoint), 0);
        return { p, near, d };
      })
      .filter((x) => x.near.some((u) => sysOf(s, u).canCapture))
      .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
    const { p: target, near } = scored[0]!;
    ok(s, 'fra', { kind: 'armyCreate', name: '1re Armée', unitIds: near.map((u) => u.id) });
    const army = viewFor(s, 'fra').command!.armies[0]!;
    const best = viewFor(s, 'fra')
      .command!.candidates.slice()
      .sort((a, b) => b.skills.offense - a.skills.offense)[0]!;
    ok(s, 'fra', { kind: 'generalHire', candidateId: best.id, armyId: army.id });
    ok(s, 'fra', {
      kind: 'armyMission',
      armyId: army.id,
      mission: { type: 'conquer', provinceId: target.id, roe: 'free', aggr: 'balanced' },
    });
    const refused: string[] = [];
    setAiTracer((_st, n, o, r) => {
      if (n === 'fra' && !r.ok) refused.push(`${o.kind}:${r.reason ?? r.error}`);
    });
    let t = 0;
    while (s.provinces[target.id]!.owner !== 'fra' && t < 4 * DAY) advanceTo(s, (t += HOUR));
    advanceTo(s, s.time + HOUR);
    setAiTracer(null);
    expect(s.provinces[target.id]!.owner).toBe('fra');
    const v = viewFor(s, 'fra').command!.armies[0]!;
    expect(v.status).toBe('success');
    expect(v.journal.map((e) => e.text.key)).toEqual(
      expect.arrayContaining([
        'engine.cmd.j.declaredWar',
        'engine.cmd.j.offensive',
        'engine.cmd.j.captured',
        'engine.cmd.j.success',
      ]),
    );
    expect(refused).toEqual([]);
    // Un assaut relancé à l'identique ne répète pas l'entrée du journal.
    const keys = v.journal.map((e) => JSON.stringify(e.text));
    expect(keys.filter((k, i) => i > 0 && k === keys[i - 1])).toEqual([]);
  });

  it('Débarquement : transport, escorte, traversée et prise de Malte', () => {
    const w = wi(world);
    const malta = data.map.provinces.find((p) => p.nationId === 'mlt')!;
    // Port italien le plus proche de Malte (côte, point de mer).
    const port = data.map.provinces
      .filter((p) => p.nationId === 'ita' && w.seaSpawn.get(p.id))
      .sort(
        (a, b) =>
          distanceKm(a.cityPoint, malta.cityPoint) - distanceKm(b.cityPoint, malta.cityPoint),
      )[0]!;
    const sea = w.seaSpawn.get(port.id)!;
    const s = createGame(world, {
      seed: 4,
      players: [
        { nationId: 'ita', isAi: false },
        { nationId: 'mlt', isAi: true },
      ],
      nationIds: ['ita', 'mlt'],
      units: [
        { owner: 'ita', systemId: 'eu.mistral-class', pos: sea, count: 1 },
        { owner: 'ita', systemId: 'eu.fremm', pos: sea, count: 1 },
        ...[1, 2, 3, 4, 5, 6, 7].map(() => ({
          owner: 'ita',
          systemId: 'eu.infantry-light',
          pos: port.cityPoint,
          count: 12,
        })),
        { owner: 'mlt', systemId: 'eu.infantry-light', pos: malta.cityPoint, count: 1 },
      ],
    }) as EngineState;
    const ids = Object.values(s.units)
      .filter((u) => u.owner === 'ita')
      .map((u) => u.id)
      .sort();
    ok(s, 'ita', { kind: 'armyCreate', name: 'Force amphibie', unitIds: ids });
    const army = viewFor(s, 'ita').command!.armies[0]!;
    ok(s, 'ita', {
      kind: 'generalHire',
      candidateId: viewFor(s, 'ita').command!.candidates[0]!.id,
      armyId: army.id,
    });
    const g = Object.values(cmd(s).gens)[0]!;
    // Général maîtrisé par le test (le vivier tiré au sort peut donner un général « économe » plus exigeant).
    g.skills = { ...g.skills, naval: 70, logistics: 60, experience: 90, audacity: 50 };
    g.traits = [];
    ok(s, 'ita', {
      kind: 'armyMission',
      armyId: army.id,
      mission: { type: 'landing', provinceId: malta.id, roe: 'free', aggr: 'bold' },
    });
    const log: { kind: string; ok: boolean }[] = [];
    setAiTracer((_st, n, o, r) => {
      if (n === 'ita') log.push({ kind: (o as Order).kind, ok: r.ok });
    });
    let took = -1;
    for (let t = 2 * HOUR; t <= 8 * DAY && took < 0; t += 2 * HOUR) {
      advanceTo(s, t);
      if (s.provinces[malta.id]!.owner === 'ita') took = t;
    }
    setAiTracer(null);
    const kinds = log.filter((x) => x.ok).map((x) => x.kind);
    expect(kinds).toContain('embark');
    expect(kinds).toContain('disembark');
    expect(took).toBeGreaterThan(0);
    expect(log.filter((x) => !x.ok)).toEqual([]);
    // Malte prise : l'Italie a gagné la partie (deux nations), le journal en garde la trace.
    expect(viewFor(s, 'ita').command!.armies[0]!.journal.map((e) => e.text.key)).toEqual(
      expect.arrayContaining(['engine.cmd.j.landing', 'engine.cmd.j.captured']),
    );
  });
});
