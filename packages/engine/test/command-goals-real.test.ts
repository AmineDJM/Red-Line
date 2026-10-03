/**
 * Les 28 objectifs d'opération ajoutés, sur les VRAIES données : chacun se lance contre (ou pour) de
 * vrais pays, ses généraux émettent des ordres valides pendant une journée de jeu, sa progression
 * chiffrée et son estimation sont tenues, et les opérations défensives n'ouvrent aucune guerre. Les
 * situations (province perdue, occupée, conquise) sont créées par le moteur, jamais par identifiant.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { HOUR, OP_GOALS, type Order } from '@redline/shared';
import {
  advanceTo,
  applyOrder,
  buildWorld,
  createGame,
  viewFor,
  type World,
} from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { atWar } from '../src/state/access.js';
import { declareWar } from '../src/state/war.js';
import { transferProvince } from '../src/combat/capture.js';
import { setAiTracer } from '../src/ai/trace.js';
import { cmd, cmdBal, type OpSt } from '../src/modules/command/state.js';
import { loadRealData, type RealData } from '../bench/load.js';
import { PLACES, provinceAt } from './real-places.js';

let data: RealData;
let world: World;

beforeAll(() => {
  data = loadRealData();
  world = buildWorld(data.map, data.catalog, data.balance, {
    research: data.research,
    orbats: data.orbats,
  });
}, 120_000);

const KEY: Record<string, 'offense' | 'air' | 'naval' | 'defense'> = {
  land: 'offense',
  air: 'air',
  sea: 'naval',
  ad: 'defense',
};

interface Case {
  goal: string;
  me: string;
  others: string[];
  nations?: string[];
  provinces?: (s: EngineState) => string[];
  setup?: (s: EngineState) => void;
  /** Aucune guerre ne doit être ouverte contre ce pays. */
  peace?: string;
}

const lille = () => provinceAt(data.map, PLACES.lille).id;
const bruxelles = () => provinceAt(data.map, PLACES.bruxelles).id;
const namur = () => provinceAt(data.map, PLACES.namur).id;
const toulon = () => provinceAt(data.map, PLACES.toulon).id;

const CASES: Case[] = [
  {
    goal: 'counteroffensive',
    me: 'fra',
    others: ['bel'],
    nations: [],
    setup: (s) => {
      declareWar(s, 'bel', 'fra');
      transferProvince(s, lille(), 'bel');
    },
  },
  {
    goal: 'liberation',
    me: 'fra',
    others: ['bel', 'nld'],
    nations: ['bel'],
    setup: (s) => {
      declareWar(s, 'nld', 'bel');
      transferProvince(s, namur(), 'nld');
    },
  },
  { goal: 'encircle', me: 'tur', others: ['syr'], nations: ['syr'] },
  { goal: 'breakthrough', me: 'tur', others: ['syr'], nations: ['syr'] },
  { goal: 'raid', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  { goal: 'siege', me: 'fra', others: ['bel'], nations: [], provinces: () => [bruxelles()] },
  {
    goal: 'defense_depth',
    me: 'ukr',
    others: ['rus'],
    nations: [],
    setup: (s) => declareWar(s, 'rus', 'ukr'),
  },
  {
    goal: 'defend_capital',
    me: 'ukr',
    others: ['rus'],
    nations: [],
    setup: (s) => declareWar(s, 'rus', 'ukr'),
  },
  {
    goal: 'pacify',
    me: 'fra',
    others: ['bel'],
    nations: [],
    setup: (s) => transferProvince(s, namur(), 'fra'),
  },
  { goal: 'show_of_force', me: 'fra', others: ['deu'], nations: ['deu'], peace: 'deu' },
  { goal: 'interdiction', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  { goal: 'cas', me: 'tur', others: ['syr'], nations: ['syr'] },
  { goal: 'strategic_bombing', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  {
    goal: 'air_defense_territory',
    me: 'ukr',
    others: ['rus'],
    nations: [],
    setup: (s) => declareWar(s, 'rus', 'ukr'),
  },
  { goal: 'air_redeploy', me: 'fra', others: [], nations: [], provinces: () => [toulon()] },
  { goal: 'armed_recon', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  { goal: 'naval_supremacy', me: 'tur', others: ['grc'], nations: ['grc'] },
  { goal: 'antiship', me: 'tur', others: ['grc'], nations: ['grc'] },
  { goal: 'convoy_escort', me: 'ita', others: [], nations: [] },
  { goal: 'amphibious', me: 'ita', others: ['mlt'], nations: ['mlt'] },
  { goal: 'port_blockade', me: 'tur', others: ['grc'], nations: ['grc'] },
  { goal: 'naval_strikes', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  {
    goal: 'missile_shield',
    me: 'ukr',
    others: ['rus'],
    nations: [],
    setup: (s) => declareWar(s, 'rus', 'ukr'),
  },
  {
    goal: 'ad_umbrella',
    me: 'fra',
    others: ['bel'],
    nations: [],
    setup: (s) => {
      // Une offensive en cours à couvrir (conquête de la Belgique).
      const v = viewFor(s, 'fra').command!;
      const c = v.branches!.find((b) => b.id === 'land')!.candidates[5]!;
      applyOrder(s, 'fra', {
        kind: 'campaignCreate',
        goal: 'conquest',
        nations: ['bel'],
        roe: 'free',
        commanders: [{ candidateId: c.id }],
      } as Order);
    },
  },
  { goal: 'missile_campaign', me: 'rus', others: ['ukr'], nations: ['ukr'] },
  { goal: 'blitz', me: 'tur', others: ['syr'], nations: ['syr'] },
  { goal: 'combined_landing', me: 'ita', others: ['mlt'], nations: ['mlt'] },
  {
    goal: 'ally_support',
    me: 'fra',
    others: ['bel', 'nld'],
    nations: ['bel'],
    setup: (s) => declareWar(s, 'nld', 'bel'),
  },
];

describe('les 28 nouveaux objectifs (vraies données)', { timeout: 1_800_000 }, () => {
  it('tous les objectifs ajoutés sont couverts', () => {
    const added = OP_GOALS.slice(9);
    expect(CASES.map((c) => c.goal).sort()).toEqual([...added].sort());
  });

  for (const c of CASES) {
    it(`${c.goal} : lancement, ordres des généraux, progression chiffrée`, () => {
      const s = createGame(world, {
        seed: 4,
        players: [
          { nationId: c.me, isAi: false },
          ...c.others.map((n) => ({ nationId: n, isAi: true })),
        ],
        scenario: data.scenario,
      }) as EngineState;
      c.setup?.(s);
      const def = cmdBal(s).operations.goals[c.goal]!;
      const v = viewFor(s, c.me).command!;
      const used = new Set<string>();
      const commanders = def.branches.map((b) => {
        const g = v
          .branches!.find((x) => x.id === b)!
          .candidates.filter((x) => !used.has(x.id))
          .sort((x, y) => y.skills[KEY[b]!] - x.skills[KEY[b]!] || (x.id < y.id ? -1 : 1))[0]!;
        used.add(g.id);
        return { candidateId: g.id };
      });
      const r = applyOrder(s, c.me, {
        kind: 'campaignCreate',
        name: c.goal,
        goal: c.goal,
        nations: c.nations ?? [],
        ...(c.provinces ? { provinces: c.provinces(s) } : {}),
        roe: 'free',
        aggr: 'bold',
        commanders,
      } as Order);
      expect(r, r.message).toMatchObject({ ok: true });
      const ops = cmd(s).ops!;
      const op = Object.values(ops).find((o) => o.name === c.goal) as OpSt;
      const log: { kind: string; ok: boolean; why?: string }[] = [];
      setAiTracer((_s, n, o, res) => {
        if (n === c.me) log.push({ kind: (o as Order).kind, ok: res.ok, why: res.message });
      });
      const t0 = s.time;
      for (let h = 1; h <= 24; h++) advanceTo(s, t0 + h * HOUR);
      setAiTracer(null);
      const ok = log.filter((x) => x.ok);
      const view = viewFor(s, c.me).command!.ops!.find((o) => o.id === op.id)!;
      console.info(
        `${c.goal} : ${op.status} ${op.phase}, ${Math.round(op.pct * 100)} %, ${JSON.stringify(op.prog.map((p) => `${p.key} ${p.done}/${p.total}`))}, ordres ${ok.length} (${[...new Set(ok.map((x) => x.kind))].join(',')}), refusés ${log.length - ok.length}`,
      );
      if (log.length - ok.length > 5)
        console.info(
          [...new Set(log.filter((x) => !x.ok).map((x) => `${x.kind}: ${x.why}`))].slice(0, 5),
        );
      expect(op.prog.length).toBeGreaterThan(0);
      expect(view.category).toBe(def.category ?? 'land');
      // Des ordres, sauf pour une opération défensive déjà en place (tout est tenu dès le départ).
      expect(ok.length > 0 || (def.continuous && op.status === 'holding')).toBe(true);
      // Les généraux ne donnent que des ordres valides (quelques refus tolérés : trajets fermés).
      expect(log.length - ok.length).toBeLessThanOrEqual(Math.max(2, Math.ceil(log.length * 0.1)));
      if (c.peace) expect(atWar(s, c.me, c.peace)).toBe(false);
      if (!def.continuous && !def.chain) expect(op.est).not.toBeNull();
    });
  }
});
