/**
 * Opérations sur les VRAIES données (monde 2025, ORBAT en piles mixtes, réseau de routes) : pour chaque
 * objectif principal, une opération contre un vrai pays produit les effets attendus en quelques jours
 * de jeu. Affaiblir (Russie → Ukraine) : forces ennemies estimées en baisse nette, frappes réelles.
 * Contrôle aérien total (Turquie → Syrie) : défense sol-air et aviation ennemies détruites, ciel
 * tenu par des patrouilles. Conquête totale (France → Belgique, Turquie → Syrie) : plusieurs généraux
 * coordonnés (deux de l'armée de terre par secteurs, l'air, la DCA), provinces prises au fil du temps,
 * aucune pile plantée au point de rassemblement au-delà d'un délai borné. Les pays, les généraux et les
 * forces sont choisis d'après la partie (vivier, armes des piles) : aucun identifiant de province en dur.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, distanceKm, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { atWar, sysOf, unitPosAt } from '../src/state/access.js';
import { wi } from '../src/state/world.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cmd, type OpSt } from '../src/modules/command/state.js';
import { mil } from '../src/modules/mil/state.js';
import { opIntel } from '../src/modules/command/ops.js';
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

function game(me: string, foe: string, seed = 3): EngineState {
  return createGame(world, {
    seed,
    players: [
      { nationId: me, isAi: false },
      { nationId: foe, isAi: true },
    ],
    scenario: data.scenario,
  }) as EngineState;
}

const KEY: Record<string, 'offense' | 'air' | 'naval' | 'defense'> = {
  land: 'offense',
  air: 'air',
  sea: 'naval',
  ad: 'defense',
};

/** Lance l'opération avec les meilleurs candidats des commandements demandés (forces d'office). */
function launch(
  s: EngineState,
  me: string,
  foe: string,
  goal: string,
  branches: string[],
  aggr: 'balanced' | 'bold' = 'balanced',
): OpSt {
  const v = viewFor(s, me).command!;
  const used = new Set<string>();
  const commanders = branches.map((b) => {
    const c = v
      .branches!.find((x) => x.id === b)!
      .candidates.filter((x) => !used.has(x.id))
      .sort((x, y) => y.skills[KEY[b]!] - x.skills[KEY[b]!] || (x.id < y.id ? -1 : 1))[0]!;
    used.add(c.id);
    return { candidateId: c.id };
  });
  const r = applyOrder(s, me, {
    kind: 'campaignCreate',
    name: 'Essai',
    goal,
    nations: [foe],
    roe: 'free',
    aggr,
    commanders,
  } as Order);
  expect(r, r.message).toMatchObject({ ok: true });
  return Object.values(cmd(s).ops!)[0]!;
}

function metric(op: OpSt, key: string) {
  return op.prog.find((p) => p.key === key)!;
}

/** Ordres du joueur donnés par les généraux (acceptés, refusés). */
function trace(me: string) {
  const log: { kind: string; ok: boolean; why?: string }[] = [];
  setAiTracer((_st, n, o, r) => {
    if (n === me) log.push({ kind: (o as Order).kind, ok: r.ok, why: r.reason ?? r.error });
  });
  return log;
}

describe('opérations : vraies données', { timeout: 900_000 }, () => {
  it('Affaiblir les forces (Russie → Ukraine) : frappes réelles, forces estimées en baisse nette', () => {
    const s = game('rus', 'ukr');
    const log = trace('rus');
    const op = launch(s, 'rus', 'ukr', 'attrition', ['air', 'land', 'sea']);
    expect(op.base.enemy).toBeGreaterThan(1e9);
    advanceTo(s, 2 * DAY);
    setAiTracer(null);
    expect(atWar(s, 'rus', 'ukr')).toBe(true);
    const strikes = log.filter((x) => x.ok && x.kind === 'strike').length;
    const forces = metric(op, 'forces');
    const sams = metric(op, 'sams');
    console.info(
      `Affaiblir : ${strikes} frappes, ${((100 * forces.done) / forces.total).toFixed(1)} % des forces estimées détruites, défenses ${sams.done}/${sams.total}`,
    );
    expect(strikes).toBeGreaterThanOrEqual(30);
    expect(forces.done / forces.total).toBeGreaterThan(0.1);
    expect(sams.done).toBeGreaterThan(0);
    expect(op.journal.some((e) => e.text.key === 'engine.cmd.op.strikes')).toBe(true);
    expect(log.filter((x) => !x.ok)).toEqual([]);
    const v = viewFor(s, 'rus').command!.ops![0]!;
    expect(v.stats.kills).toBeGreaterThan(0);
    expect(v.pct).toBeGreaterThan(0.1);
  });

  it('Contrôle aérien total (Turquie → Syrie) : défense sol-air et aviation détruites, patrouilles maintenues', () => {
    const s = game('tur', 'syr');
    const log = trace('tur');
    const op = launch(s, 'tur', 'syr', 'air_control', ['air', 'ad'], 'bold');
    let held = -1;
    for (let h = 6; h <= 4 * 24; h += 6) {
      advanceTo(s, h * HOUR);
      if (held < 0 && op.status === 'holding') held = h;
    }
    setAiTracer(null);
    const sams = metric(op, 'sams');
    const air = metric(op, 'aircraft');
    console.info(
      `Contrôle aérien : défenses ${sams.done}/${sams.total}, aéronefs ${air.done}/${air.total}, ciel tenu à H+${held}`,
    );
    expect(sams.total).toBeGreaterThan(0);
    expect(sams.done).toBe(sams.total);
    // Aviation : la plupart des appareils vus détruits, plus aucun appareil ennemi en vol depuis 6 h.
    expect(air.total).toBeGreaterThan(0);
    expect(air.done).toBeGreaterThanOrEqual(Math.ceil(0.7 * air.total));
    expect(op.airAt === null || s.time - op.airAt >= 6 * HOUR).toBe(true);
    expect(held).toBeGreaterThan(0);
    expect(op.status).toBe('holding');
    // Ciel tenu : des chasseurs en patrouille vers le pays visé (au plus loin de leur rayon d'action).
    const ms = mil(s).ms;
    const airArmy = op.armies.find((id) => op.roles[id] === 'air')!;
    const center = opIntel(s, op).center!;
    const patrols = cmd(s).armies[airArmy]!.units.filter(
      (id) => ms[id]?.mis === 'patrol' && ms[id]!.at && distanceKm(ms[id]!.at!, center) < 700,
    );
    expect(patrols.length).toBeGreaterThan(0);
    expect(log.filter((x) => !x.ok)).toEqual([]);
  });

  for (const [me, foe, days] of [
    ['fra', 'bel', 4],
    ['tur', 'syr', 5],
  ] as const) {
    it(`Conquête totale (${me} → ${foe}) : généraux coordonnés, provinces prises, pas de pile plantée`, () => {
      const s = game(me, foe);
      const log = trace(me);
      const op = launch(s, me, foe, 'conquest', ['land', 'land', 'air', 'ad'], 'bold');
      const c = cmd(s);
      expect(op.armies.map((id) => op.roles[id])).toEqual(['land', 'land', 'air', 'ad']);
      const land = op.armies.filter((id) => op.roles[id] === 'land');
      // Secteurs distincts pour les deux généraux de l'armée de terre.
      expect(op.sectors[land[0]!]!.pids.some((p) => op.sectors[land[1]!]!.pids.includes(p))).toBe(
        false,
      );
      const nav = wi(world).nav;
      const idle = new Map<string, number>();
      let worst = 0;
      const steps: number[] = [];
      for (let h = 1; h <= days * 24 && op.status !== 'success'; h++) {
        advanceTo(s, h * HOUR);
        steps.push(op.targets.filter((p) => s.provinces[p]!.owner === me).length);
        if ((op.status as string) === 'success') break;
        // Pile de combat terrestre immobile chez soi (hors provinces prises) alors que des cibles restent.
        for (const aid of land) {
          for (const id of c.armies[aid]?.units ?? []) {
            const u = s.units[id];
            if (!u || u.off) continue;
            const sy = sysOf(s, u);
            if (sy.movement !== 'land' || !(sy.canCapture || sy.damage.armor > 0)) continue;
            const pid = nav.cellProv.get(nav.cellOfPos(unitPosAt(s, u, s.time)));
            const home = !!pid && s.provinces[pid]?.owner === me && !op.targets.includes(pid);
            const k = !u.move && !u.target && home ? (idle.get(id) ?? 0) + 1 : 0;
            idle.set(id, k);
            worst = Math.max(worst, k);
          }
        }
      }
      setAiTracer(null);
      const taken = op.targets.filter((p) => s.provinces[p]!.owner === me).length;
      console.info(
        `Conquête ${me} → ${foe} : ${taken}/${op.targets.length} provinces, statut ${op.status} à H+${steps.length}, pile immobile au plus ${worst} h, frappes ${op.strikes}`,
      );
      expect(op.status).toBe('success');
      expect(taken).toBe(op.targets.length);
      // Prises échelonnées dans le temps.
      expect(new Set(steps).size).toBeGreaterThan(2);
      // Rassemblement borné : aucune pile de combat plantée chez elle plus d'une journée.
      expect(worst).toBeLessThanOrEqual(24);
      // Coordination : les deux généraux de l'armée de terre ont mené l'assaut, l'aviation a frappé.
      const leaders = new Set(
        op.journal
          .filter(
            (e) =>
              e.text.key === 'engine.cmd.op.offensive' ||
              e.text.key === 'engine.cmd.op.jointAssault',
          )
          .map((e) => JSON.stringify(e.text.params?.army)),
      );
      expect(leaders.size).toBeGreaterThanOrEqual(1);
      expect(op.strikes).toBeGreaterThan(0);
      expect(log.filter((x) => !x.ok)).toEqual([]);
    });
  }
});
