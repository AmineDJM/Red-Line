/**
 * Reprise d'instantané sur les VRAIES données : une partie reprise (serializeState → deserializeState)
 * doit suivre exactement la même trajectoire que la partie vécue, pas seulement avoir la même empreinte
 * au moment de la reprise. Tout état qui influence la simulation sans être sérialisé (cache, mémo, ordre
 * d'itération reconstruit autrement, compteur) fait diverger les empreintes quelques heures plus tard ;
 * on compare donc heure par heure et, en cas d'écart, on nomme les sous-états fautifs (module, clé).
 *
 * - mémo des trajets de surface : une pile mixte (fiche synthétique : identifiant du matériel principal,
 *   vitesse du plus lent) ne partage pas d'entrée avec une unité du matériel principal seul ;
 * - Europe de l'Est en guerre : IA actives (opérations, frappes, escortes, interceptions), un joueur ;
 *   reprise normale et reprise avec l'ordre des clés des objets inversé (aucune itération non triée) ;
 * - Méditerranée : transport de troupes, escorte navale, patrouille aérienne contre une IA en guerre,
 *   reprises à plusieurs instants (embarquement, traversée, débarquement).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { HOUR, MINUTE, type LngLat, type NationId, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  deserializeState,
  serializeState,
  stateHash,
  type GameSetup,
  type World,
} from '../src/index.js';
import type { EngineState, Unit } from '../src/state/types.js';
import { fnv1a64 } from '../src/state/serialize.js';
import { sysOf, unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { planUnitMove } from '../src/movement/plan-unit.js';
import { setAiTracer } from '../src/ai/trace.js';
import { PLACES, provinceAt } from './real-places.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';
import { loadRealData, type RealData } from '../bench/load.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData('eastern-europe');
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
}, 120_000);

/* ——— Localisation d'un écart ——— */

const digest = (v: unknown): string =>
  fnv1a64(encode(v, { sortKeys: true, ignoreUndefined: true }));

/** Sous-états de la partie : clés de premier niveau, et `mods.<module>.<clé>` pour les modules. */
function subStates(s: EngineState): Map<string, unknown> {
  const d = decode(serializeState(s)) as Record<string, unknown>;
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(d)) {
    if (k !== 'mods' || !v || typeof v !== 'object') {
      out.set(k, v);
      continue;
    }
    for (const [m, mv] of Object.entries(v as Record<string, unknown>)) {
      if (!mv || typeof mv !== 'object' || Array.isArray(mv)) out.set(`mods.${m}`, mv);
      else for (const [k2, v2] of Object.entries(mv)) out.set(`mods.${m}.${k2}`, v2);
    }
  }
  return out;
}

/** Sous-états qui diffèrent, avec jusqu'à 4 sous-clés fautives chacun (ex. « mods.ai.mem : rus »). */
function divergence(a: EngineState, b: EngineState): string[] {
  const A = subStates(a);
  const B = subStates(b);
  const out: string[] = [];
  for (const k of [...new Set([...A.keys(), ...B.keys()])].sort()) {
    const x = A.get(k);
    const y = B.get(k);
    if (digest(x) === digest(y)) continue;
    let detail = '';
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(xo), ...Object.keys(yo)])].sort();
      detail = keys
        .filter((c) => digest(xo[c]) !== digest(yo[c]))
        .slice(0, 4)
        .join(', ');
    }
    out.push(detail ? `${k} : ${detail}` : k);
  }
  return out;
}

/** Copie reprise, l'ordre des clés de tous les objets inversé (l'ordre d'insertion ne doit pas compter). */
function reversedCopy(s: EngineState): EngineState {
  const rev = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(rev);
    if (x && typeof x === 'object' && !(x instanceof Uint8Array)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).reverse()) o[k] = rev((x as Record<string, unknown>)[k]);
      return o;
    }
    return x;
  };
  const bytes = encode(rev(decode(serializeState(s))), { ignoreUndefined: true });
  return deserializeState(world, bytes) as EngineState;
}

const resume = (s: EngineState): EngineState =>
  deserializeState(world, serializeState(s)) as EngineState;

/**
 * Avance la partie vécue et ses copies reprises par pas de `step`, jusqu'à `end` ; s'arrête au premier
 * écart d'empreinte et rend alors l'instant et les sous-états fautifs (rien sinon).
 */
function compare(
  live: EngineState,
  copies: Record<string, EngineState>,
  end: number,
  step: number,
): string | null {
  for (let t = live.time + step; t <= end; t += step) {
    advanceTo(live, t);
    const h = stateHash(live);
    for (const [name, c] of Object.entries(copies)) {
      advanceTo(c, t);
      if (stateHash(c) !== h) {
        return `${name} : écart à t = ${t / MINUTE} min — ${divergence(live, c).join(' | ')}`;
      }
    }
  }
  return null;
}

describe(
  'reprise d’instantané : trajectoire identique à la partie vécue',
  { timeout: 600_000 },
  () => {
    it('mémo des trajets : une pile mixte et une unité de son matériel principal ne partagent pas d’entrée', () => {
      const s = createGame(world, {
        seed: 5,
        players: [{ nationId: 'pol', isAi: false }],
        nationIds: data.scenario.nationIds,
        scenario: data.scenario,
      }) as EngineState;
      // Piles terrestres mixtes plus lentes que leur matériel principal.
      const stacks = Object.keys(s.units)
        .sort()
        .map((id) => s.units[id]!)
        .filter((u) => {
          if (!u.mix || u.move) return false;
          const sys = sysOf(s, u);
          return (
            sys.movement === 'land' && sys.speedKmh < world.catalog.get(u.sys)!.speedKmh && !u.off
          );
        });
      expect(stacks.length).toBeGreaterThan(0);
      const memo = s.rt.planMemo;
      let checked = 0;
      for (const u of stacks.slice(0, 6)) {
        // Destination : une autre ville de la nation, sur le réseau de routes.
        const here = unitPosAt(s, u, s.time);
        const to = Object.keys(s.provinces)
          .sort()
          .filter((p) => s.provinces[p]!.owner === u.owner)
          .map((p) => wi(world).provById.get(p)!.cityPoint)
          .find((c) => c[0] !== here[0] || c[1] !== here[1]);
        if (!to) continue;
        // Même position, même matériel principal, sans les autres éléments de la pile.
        const solo: Unit = { ...u, id: `${u.id}-solo`, mix: undefined };
        memo.clear();
        const fresh = planUnitMove(s, u, to);
        memo.clear();
        const freshSolo = planUnitMove(s, solo, to);
        if ('error' in fresh) continue;
        memo.clear();
        planUnitMove(s, solo, to);
        expect(planUnitMove(s, u, to)).toEqual(fresh);
        memo.clear();
        planUnitMove(s, u, to);
        expect(planUnitMove(s, solo, to)).toEqual(freshSolo);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('Europe de l’Est en guerre, IA actives : reprise à H+6 puis 18 h comparées heure par heure', () => {
      const s = createGame(world, {
        seed: 2025,
        players: [{ nationId: 'pol', isAi: false }],
        nationIds: data.scenario.nationIds,
        scenario: data.scenario,
        aiLevel: 'normal',
        speed: 1,
      }) as EngineState;
      const WARS: [NationId, NationId][] = [
        ['rus', 'ukr'],
        ['blr', 'pol'],
        ['aze', 'arm'],
        ['srb', 'hun'],
      ];
      for (const [a, b] of WARS)
        expect(applyOrder(s, a, { kind: 'declareWar', nationId: b }).ok).toBe(true);
      // Ordres variés des belligérants (mêmes règles que le banc real.ts) : mouvements, frappes, patrouilles.
      const rng = seedRng(17);
      const cities = (n: NationId): LngLat[] =>
        Object.keys(s.provinces)
          .sort()
          .filter((p) => s.provinces[p]!.owner === n)
          .map((p) => wi(world).provById.get(p)!.cityPoint);
      let accepted = 0;
      for (let round = 0; round < 20 && accepted < 80; round++) {
        for (const [a, b] of WARS) {
          const targets = cities(b);
          const mine = [...(s.rt.byNation.get(a) ?? [])].sort();
          if (targets.length === 0 || mine.length === 0) continue;
          for (let k = 0; k < 2; k++) {
            const u = s.units[mine[Math.floor(nextFloat(rng) * mine.length)]!];
            if (!u || u.off || u.move) continue;
            const sys = sysOf(s, u);
            const target = targets[Math.floor(nextFloat(rng) * targets.length)]!;
            let o: Order;
            if (sys.missile || u.role === 'missile')
              o = {
                kind: 'strike',
                unitIds: [u.id],
                target: { type: 'point', at: target },
                count: 1,
              };
            else if (sys.movement === 'air')
              o = { kind: 'patrol', unitIds: [u.id], at: target, radiusKm: 120 };
            else if (sys.movement === 'land' && sys.speedKmh > 0)
              o = { kind: 'move', unitIds: [u.id], to: target };
            else continue;
            if (applyOrder(s, a, o).ok) accepted++;
          }
        }
      }
      expect(accepted).toBeGreaterThan(20);
      advanceTo(s, 6 * HOUR);

      const copies = { reprise: resume(s), 'reprise (clés inversées)': reversedCopy(s) };
      for (const c of Object.values(copies)) expect(stateHash(c)).toBe(stateHash(s));
      // Couverture : ordres donnés par les IA pendant la période comparée (partie vécue).
      const kinds = new Set<string>();
      setAiTracer((st, _n, o, r) => {
        if (st === s && r.ok) kinds.add(o.kind);
      });
      try {
        expect(compare(s, copies, 24 * HOUR, HOUR)).toBeNull();
      } finally {
        setAiTracer(null);
      }
      expect(Object.keys(s.wars).length).toBeGreaterThanOrEqual(WARS.length);
      expect([...kinds]).toEqual(expect.arrayContaining(['move', 'strike']));
    });

    it('Méditerranée : transport, escorte et patrouille contre une IA en guerre, reprises à 3 instants', () => {
      const NATIONS = ['fra', 'ita', 'mco', 'mlt', 'esp'];
      const prov = (id: string) => wi(world).provById.get(id)!;
      const sea = (pid: string): LngLat => wi(world).seaSpawn.get(pid)!;
      // Provinces désignées par leur ville (identifiants propres à chaque version de la carte).
      const TOULON = provinceAt(world.map, PLACES.toulon).id;
      const CAGLIARI = provinceAt(world.map, PLACES.cagliari).id;
      const units: GameSetup['units'] = [
        { owner: 'fra', systemId: 'eu.mistral-class', pos: sea(TOULON), count: 1 }, // u1
        { owner: 'fra', systemId: 'eu.infantry-light', pos: prov(TOULON).cityPoint, count: 2 }, // u2
        { owner: 'fra', systemId: 'eu.fremm', pos: sea(TOULON), count: 1 }, // u3
        { owner: 'fra', systemId: 'eu.rafale', pos: prov(TOULON).cityPoint, count: 4 }, // u4
        { owner: 'ita', systemId: 'eu.infantry-light', pos: prov(CAGLIARI).cityPoint, count: 2 },
        { owner: 'ita', systemId: 'eu.fremm', pos: sea(CAGLIARI), count: 1 },
        { owner: 'ita', systemId: 'eu.typhoon', pos: prov(CAGLIARI).cityPoint, count: 4 },
      ];
      const END = 30 * HOUR;
      /** Partie complète ; `snapAt` : reprise d'instantané à cet instant. Empreintes heure par heure. */
      const play = (snapAt: number | null): string[] => {
        let s = createGame(world, {
          seed: 3,
          players: [
            { nationId: 'fra', isAi: false },
            { nationId: 'ita', isAi: true },
          ],
          nationIds: NATIONS,
          units,
        }) as EngineState;
        const order = (o: Order) => expect(applyOrder(s, 'fra', o)).toMatchObject({ ok: true });
        const hashes: string[] = [];
        const step = (to: number) => {
          while (s.time < to) {
            const t = Math.min(to, s.time + HOUR);
            if (snapAt !== null && s.time < snapAt && t >= snapAt) {
              advanceTo(s, snapAt);
              s = resume(s);
            }
            advanceTo(s, t);
            hashes.push(stateHash(s));
          }
        };
        order({ kind: 'declareWar', nationId: 'ita' });
        order({ kind: 'embark', unitIds: ['u2'], transportId: 'u1' });
        order({ kind: 'escort', unitIds: ['u3'], targetId: 'u1' });
        order({ kind: 'patrol', unitIds: ['u4'], at: prov(CAGLIARI).cityPoint, radiusKm: 120 });
        step(2 * HOUR);
        order({ kind: 'disembark', transportId: 'u1', to: prov(CAGLIARI).cityPoint });
        step(END);
        return hashes;
      };
      const live = play(null);
      expect(play(null)).toEqual(live);
      for (const at of [HOUR + 30 * MINUTE, 5 * HOUR, 11 * HOUR]) expect(play(at)).toEqual(live);
    });
  },
);
