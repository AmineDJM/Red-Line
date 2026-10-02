/**
 * Balayage de la conquête sur les VRAIES données (carte, réseau de routes, catalogue) : pour chaque
 * province d'un échantillon de pays (toutes avec CONQUEST_ALL=1), une pile d'infanterie partie de la
 * ville d'une province voisine reliée par la route (sinon d'une ville portuaire d'une autre masse
 * continentale : traversée de port à port) reçoit l'ordre de déplacement vers la ville de la province ;
 * on vérifie que l'ordre est accepté, que la pile arrive au point de capture et que la province change
 * de propriétaire après balance.time.captureMinutes. Aucune province ne doit rester inconquérable.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { HOUR, MINUTE, distanceKm, type ProvinceDef } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { CAPTURE_RADIUS_KM, wi } from '../src/state/world.js';
import { loadRealData, type RealData } from '../bench/load.js';

const INF = 'eu.infantry-light';
/** Nations attaquantes : n'importe quelle nation de la partie (la guerre est déclarée en entrant). */
const A1 = 'nzl';
const A2 = 'aus';
/** Échantillon : continents, îles, archipels, enclaves, grands pays. */
const SAMPLE = [
  'fra',
  'deu',
  'bel',
  'che',
  'ita',
  'esp',
  'prt',
  'gbr',
  'irl',
  'grc',
  'nor',
  'dnk',
  'pol',
  'ukr',
  'tur',
  'egy',
  'mar',
  'dza',
  'nga',
  'zaf',
  'mdg',
  'ind',
  'lka',
  'jpn',
  'phl',
  'idn',
  'twn',
  'kor',
  'cub',
  'mex',
  'bra',
  'chl',
  'can',
  'isl',
  'nzl',
  'aus',
  'mlt',
  'cyp',
  'sgp',
  'lux',
  'and',
  'vat',
];
const CHUNK = 150;

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, { research: data.research });
}, 120_000);

interface Outcome {
  taken: string[];
  /** Cause → provinces non prises. */
  fails: Record<string, string[]>;
}

/** Lance un balayage sur `targets` (une partie par tranche) ; renvoie les provinces prises et les échecs. */
function sweep(targets: ProvinceDef[]): Outcome {
  const W = wi(world);
  const roads = W.roads!;
  const byId = new Map(data.map.provinces.map((p) => [p.id, p]));
  const node = (pid: string) => roads.nodePoint(roads.nodeIndex(`c:${pid}`)!);
  const out: Outcome = { taken: [], fails: {} };
  const failed = (why: string, pid: string) => (out.fails[why] ??= []).push(pid);
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const specs: { owner: string; systemId: string; pos: [number, number]; count: number }[] = [];
    const goal: string[] = [];
    for (const p of chunk) {
      const att = p.nationId === A1 ? A2 : A1;
      const tn = node(p.id);
      const near = p.neighbors
        .map((q) => byId.get(q))
        .filter((q): q is ProvinceDef => !!q && roads.compOf(node(q.id)) === roads.compOf(tn))
        .sort(
          (a, b) =>
            distanceKm(a.cityPoint, p.cityPoint) - distanceKm(b.cityPoint, p.cityPoint) ||
            (a.id < b.id ? -1 : 1),
        );
      let src = near[0];
      if (!src) {
        // Île (ou masse sans voisine reliée) : ville portuaire la plus proche d'une autre masse.
        let bd = Infinity;
        for (const q of data.map.provinces) {
          if (roads.compOf(node(q.id)) === roads.compOf(tn)) continue;
          const d = distanceKm(q.cityPoint, p.cityPoint);
          if (d < bd && roads.portDistance(node(q.id)) < 300) {
            bd = d;
            src = q;
          }
        }
      }
      if (!src) {
        failed('no_source', p.id);
        continue;
      }
      specs.push({ owner: att, systemId: INF, pos: src.cityPoint, count: 3 });
      goal.push(p.id);
    }
    const s = createGame(world, {
      seed: 1,
      players: W.nationIds.map((n) => ({ nationId: n, isAi: false })),
      victory: { provinceShare: 2, allEnemyCapitals: false },
      units: specs,
    }) as EngineState;
    const ids = Object.keys(s.units).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    let end = 0;
    ids.forEach((id, k) => {
      const pid = goal[k]!;
      const u = s.units[id]!;
      const r = applyOrder(s, u.owner, {
        kind: 'move',
        unitIds: [id],
        to: byId.get(pid)!.cityPoint,
      });
      if (!r.ok) failed(`order:${r.error}`, pid);
      else if (u.move) end = Math.max(end, u.move.legs[u.move.legs.length - 1]!.t1);
    });
    const stop = end + (data.balance.time.captureMinutes + 10) * MINUTE;
    for (let t = 6 * HOUR; t < stop + 6 * HOUR; t += 6 * HOUR) advanceTo(s, Math.min(t, stop));
    ids.forEach((id, k) => {
      const pid = goal[k]!;
      const owner = s.provinces[pid]!.owner;
      if (owner === A1 || owner === A2) {
        out.taken.push(pid);
        return;
      }
      if (Object.values(out.fails).some((l) => l.includes(pid))) return;
      const u = s.units[id];
      const city = byId.get(pid)!.cityPoint;
      const why = !u
        ? 'unit_lost'
        : u.move
          ? 'still_moving'
          : distanceKm(u.pos, city) > CAPTURE_RADIUS_KM
            ? 'stopped_short'
            : 'at_city_no_capture';
      failed(why, pid);
    });
  }
  return out;
}

describe('conquête : balayage des provinces (vraies données)', () => {
  it(
    'chaque province de l’échantillon est conquise par une pile d’infanterie venue d’une voisine',
    { timeout: 1_800_000 },
    () => {
      const all = process.env.CONQUEST_ALL === '1';
      const targets = data.map.provinces
        .filter((p) => all || SAMPLE.includes(p.nationId))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const res = sweep(targets);
      const failures = Object.entries(res.fails).map(([k, v]) => `${k}: ${v.join(' ')}`);
      if (all || failures.length) {
        console.log(
          `conquête : ${res.taken.length}/${targets.length} provinces prises`,
          failures.join('\n'),
        );
      }
      expect(failures).toEqual([]);
      expect(res.taken.length).toBe(targets.length);
    },
  );
});
