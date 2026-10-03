/**
 * IA et transport naval sur les VRAIES données : pour prendre une île (Malte), l'IA italienne fait venir
 * son navire de transport au port de rassemblement, y embarque ses troupes, traverse, les débarque et
 * prend la province ; les escortes et frappes aériennes utilisent l'ordre « escorter ». Aucun ordre refusé.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, type Order } from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, type World } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { wi } from '../src/state/world.js';
import { setAiTracer } from '../src/ai/trace.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, { research: data.research });
}, 60_000);

afterEach(() => setAiTracer(null));

function record(n: string) {
  const log: { t: number; o: Order; ok: boolean; reason?: string }[] = [];
  setAiTracer((st, who, o, r) => {
    if (who === n) log.push({ t: st.time, o: o as Order, ok: r.ok, reason: r.reason ?? r.error });
  });
  return log;
}

describe('IA : débarquement par navire de transport', () => {
  it(
    'l’Italie embarque ses troupes à Syracuse, traverse et prend Malte',
    { timeout: 300_000 },
    () => {
      const city = (id: string) => data.map.provinces.find((p) => p.id === id)!.cityPoint;
      const sea = (id: string) => wi(world).seaSpawn.get(id)!;
      // Provinces de Syracuse (Sicile) et de La Valette, désignées par leur ville.
      const SICILE = provinceAt(data.map, PLACES.syracuse).id;
      const MALTE = provinceAt(data.map, PLACES.laValette).id;
      const rome = data.map.provinces.find((p) => p.nationId === 'ita' && p.isCapital)!.cityPoint;
      const s = createGame(world, {
        seed: 4,
        players: [
          { nationId: 'ita', isAi: true, aiLevel: 'hard' },
          { nationId: 'mlt', isAi: false },
        ],
        nationIds: ['ita', 'mlt'],
        units: [
          { owner: 'ita', systemId: 'eu.mistral-class', pos: sea(SICILE), count: 1 },
          { owner: 'ita', systemId: 'eu.fremm', pos: sea(SICILE), count: 1 },
          // Garnison de la capitale, et troupes de l'offensive en Sicile.
          ...[1, 2, 3].map(() => ({
            owner: 'ita',
            systemId: 'eu.infantry-light',
            pos: rome,
            count: 1,
          })),
          // Forces estimées de Malte (données publiques) : il faut une force conséquente.
          ...[1, 2, 3, 4, 5, 6].map(() => ({
            owner: 'ita',
            systemId: 'eu.infantry-light',
            pos: city(SICILE),
            count: 12,
          })),
          { owner: 'mlt', systemId: 'eu.infantry-light', pos: city(MALTE), count: 1 },
        ],
      }) as EngineState;
      const log = record('ita');
      expect(applyOrder(s, 'ita', { kind: 'declareWar', nationId: 'mlt' }).ok).toBe(true);
      let took = -1;
      for (let t = 2 * HOUR; t <= 8 * DAY && took < 0; t += 2 * HOUR) {
        advanceTo(s, t);
        if (s.provinces[MALTE]!.owner === 'ita') took = t;
      }
      const kinds = log.filter((x) => x.ok).map((x) => x.o.kind);
      expect(kinds).toContain('embark');
      expect(kinds).toContain('disembark');
      expect(took).toBeGreaterThan(0);
      expect(log.filter((x) => !x.ok)).toEqual([]);
    },
  );
});
