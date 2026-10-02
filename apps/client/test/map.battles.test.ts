import { describe, expect, it } from 'vitest';
import {
  HOUR,
  MINUTE,
  type BattleReportSummary,
  type BattleShotView,
  type NationView,
  type PlayerView,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { battleFeatures, battleHeat, battleMarkers, ShotScheduler } from '../src/map/battles.js';
import { unitInfos } from '../src/map/features.js';
import { FxSystem, queueBlast, queueIntercept, queueShot } from '../src/map/fx.js';

const shot = (t: number, hit = true, cls: BattleShotView['cls'] = 'armor'): BattleShotView => ({
  t,
  from: [2, 48],
  to: [2.05, 48.02],
  cls,
  hit,
});

const battle = (over: Partial<BattleReportSummary> = {}): BattleReportSummary => ({
  id: 'bt1',
  at: [2, 48],
  provinceId: 'p1',
  startedAt: 0,
  endedAt: null,
  title: 'Bataille de Test',
  attacker: {
    nations: ['fra'],
    engaged: [{ systemId: 'tank', count: 10 }],
    losses: [{ systemId: 'tank', count: 2 }],
  },
  defender: {
    nations: ['rus'],
    engaged: [{ systemId: 'tank', count: 12 }],
    losses: [{ systemId: 'tank', count: 5 }],
  },
  outcome: 'ongoing',
  ...over,
});

const nation = (id: string, relation?: NationView['relation']): NationView => ({
  id,
  name: id.toUpperCase(),
  color: '#336699',
  isAi: true,
  isPlayer: false,
  alive: true,
  provinceCount: 1,
  ...(relation ? { relation } : {}),
});
const nations = { fra: nation('fra'), rus: nation('rus', 'war') };
const catalog = {
  tank: { id: 'tank', name: 'Char', category: 'tank', movement: 'land' } as unknown as WeaponSystem,
};
const unit = (id: string, over: Partial<UnitView> = {}): UnitView => ({
  id,
  owner: 'fra',
  level: 'own',
  pos: [2, 48],
  lastSeen: 0,
  uncertaintyKm: 0,
  systemId: 'tank',
  count: 10,
  hpRatio: 0.8,
  status: 'idle',
  ...over,
});
const view = (reports: BattleReportSummary[], units: UnitView[] = []): PlayerView =>
  ({
    time: HOUR,
    me: 'fra',
    nations,
    provinces: {},
    units: Object.fromEntries(units.map((u) => [u.id, u])),
    battleReports: reports,
  }) as unknown as PlayerView;
const infosOf = (units: UnitView[]) =>
  unitInfos(units, {
    me: 'fra',
    nations,
    catalog,
    selection: new Set(),
    target: null,
    t: HOUR,
  });

describe('marqueurs de bataille', () => {
  it('batailles en cours seulement, camp du joueur et pertes de chaque côté', () => {
    const b = battle({ live: { lastAt: HOUR - MINUTE, shots: [shot(HOUR - MINUTE)] } });
    const ended = battle({ id: 'bt0', outcome: 'attacker', endedAt: HOUR / 2 });
    const m = battleMarkers(view([b, ended]), 'fra', HOUR, []);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      id: 'b:bt1',
      side: 'att',
      lossOwn: 2,
      lossFoe: 5,
      reportId: 'bt1',
    });
    expect(m[0]!.heat).toBeGreaterThan(0.6);
    const f = battleFeatures(m).features[0]!;
    expect(f.properties).toMatchObject({ id: 'b:bt1', side: 'att', label: '-2 / -5' });
  });

  it('activité : forte juste après un tir, retombée quand le combat se tait', () => {
    const hot = battle({ live: { lastAt: HOUR, shots: [shot(HOUR), shot(HOUR - MINUTE)] } });
    const cold = battle({ live: { lastAt: HOUR - 3 * HOUR, shots: [] } });
    expect(battleHeat(hot, HOUR)).toBeGreaterThan(battleHeat(cold, HOUR));
    expect(battleHeat(battle({ outcome: 'draw' }), HOUR)).toBe(0);
  });

  it('accrochage : unités au combat hors des batailles connues, regroupées par proximité', () => {
    const units = [
      unit('a', { status: 'combat', pos: [10, 50] }),
      unit('b', { owner: 'rus', level: 'precise', status: 'combat', pos: [10.1, 50] }),
      unit('c', { status: 'combat', pos: [2.01, 48] }), // près de la bataille connue
      unit('d', { status: 'idle', pos: [20, 50] }),
    ];
    const m = battleMarkers(view([battle()], units), 'fra', HOUR, infosOf(units));
    expect(m.map((x) => x.id).sort()).toEqual(['b:bt1', 's:a']);
    expect(m.find((x) => x.id === 's:a')!.unitIds).toEqual(['a', 'b']);
  });
});

describe('ordonnancement des tirs récents', () => {
  it('première vue : tirs récents seulement ; ensuite, les nouveaux uniquement', () => {
    const s = new ShotScheduler({ windowMs: 1000, maxPerBattle: 8, firstLookMs: 3 * MINUTE });
    const b1 = battle({
      live: { lastAt: HOUR, shots: [shot(HOUR - 10 * MINUTE), shot(HOUR - MINUTE), shot(HOUR)] },
    });
    const first = s.next([b1], HOUR);
    expect(first.map((x) => x.shot.t)).toEqual([HOUR - MINUTE, HOUR]);
    expect(first[0]!.delay).toBe(0);
    expect(first[1]!.delay).toBe(1000);
    // Même vue : rien de neuf.
    expect(s.next([b1], HOUR)).toEqual([]);
    const b2 = battle({
      live: { lastAt: HOUR + MINUTE, shots: [...b1.live!.shots, shot(HOUR + MINUTE, false)] },
    });
    const next = s.next([b2], HOUR + MINUTE);
    expect(next).toHaveLength(1);
    expect(next[0]!.shot.hit).toBe(false);
  });

  it('borné par bataille (les plus récents), délais croissants dans la fenêtre', () => {
    const s = new ShotScheduler({ windowMs: 1600, maxPerBattle: 4, firstLookMs: HOUR });
    const shots = Array.from({ length: 10 }, (_, i) => shot(HOUR - (10 - i) * 1000));
    const out = s.next([battle({ live: { lastAt: HOUR, shots } })], HOUR);
    expect(out).toHaveLength(4);
    expect(out.map((x) => x.shot.t)).toEqual(shots.slice(-4).map((x) => x.t));
    for (let i = 1; i < out.length; i++) expect(out[i]!.delay).toBeGreaterThan(out[i - 1]!.delay);
    expect(out[out.length - 1]!.delay).toBeLessThanOrEqual(1600);
  });

  it('camp du tireur fourni par l’appelant ; bataille close oubliée', () => {
    const s = new ShotScheduler();
    const b = battle({ live: { lastAt: HOUR, shots: [shot(HOUR)] } });
    expect(s.next([b], HOUR, () => true)[0]!.own).toBe(true);
    s.next([battle({ outcome: 'attacker', endedAt: HOUR })], HOUR + MINUTE);
    // Rouverte (même identifiant) : considérée comme une première vue.
    expect(s.next([b], HOUR + MINUTE)).toHaveLength(1);
  });
});

describe('effets de combat (budget, différés, composition)', () => {
  it('effets différés démarrés à l’heure, retirés à expiration', () => {
    const fx = new FxSystem(10);
    fx.add('blast', 0, 500, [0, 0], [0, 0], '#fff', 200);
    fx.update(100);
    expect(fx.list).toHaveLength(0);
    expect(fx.busy).toBe(true);
    fx.update(250);
    expect(fx.list).toHaveLength(1);
    fx.update(800);
    expect(fx.list).toHaveLength(0);
    expect(fx.busy).toBe(false);
  });

  it('budget : refuse au-delà, une explosion remplace un effet mineur en attente', () => {
    const fx = new FxSystem(3);
    expect(fx.add('tracer', 0, 300, [0, 0], [1, 1], '#fff', 50)).toBe(true);
    expect(fx.add('smoke', 0, 300, [0, 0], [0, 0], '#fff', 50)).toBe(true);
    expect(fx.add('tracer', 0, 300, [0, 0], [1, 1], '#fff')).toBe(true);
    // Plein : un traceur remplace la fumée en attente (moins prioritaire)…
    expect(fx.add('tracer', 0, 300, [0, 0], [1, 1], '#fff')).toBe(true);
    expect(fx.all().map((x) => x.kind)).not.toContain('smoke');
    // … mais pas un autre traceur (priorité égale) : refusé.
    expect(fx.add('tracer', 0, 300, [0, 0], [1, 1], '#fff')).toBe(false);
    expect(fx.dropped).toBe(1);
    expect(fx.add('bigblast', 0, 900, [0, 0], [0, 0], '#fff')).toBe(true);
    expect(fx.size).toBe(3);
  });

  it('composition : interception, tir antiaérien, artillerie à distance, rafale au contact', () => {
    const kinds = (f: (fx: FxSystem) => void) => {
      const fx = new FxSystem(100);
      f(fx);
      return fx.all().map((x) => x.kind);
    };
    const near = { from: [2, 48] as [number, number], to: [2.05, 48] as [number, number] };
    expect(kinds((fx) => queueShot(fx, 0, { ...near, cls: 'missile', hit: true }, true))).toEqual([
      'flash',
      'streak',
      'intercept',
    ]);
    expect(
      kinds((fx) => queueShot(fx, 0, { ...near, cls: 'missile', hit: false }, true)),
    ).toContain('fizz');
    expect(kinds((fx) => queueShot(fx, 0, { ...near, cls: 'aircraft', hit: true }, false))).toEqual(
      ['streak', 'blast'],
    );
    const far = { from: [2, 48] as [number, number], to: [2.6, 48] as [number, number] };
    expect(kinds((fx) => queueShot(fx, 0, { ...far, cls: 'armor', hit: true }, true))).toEqual([
      'flash',
      'shell',
      'blast',
      'smoke',
    ]);
    const burst = kinds((fx) => queueShot(fx, 0, { ...near, cls: 'infantry', hit: true }, true));
    expect(burst.filter((k) => k === 'tracer')).toHaveLength(3);
    expect(burst).toContain('blast');
    expect(kinds((fx) => queueBlast(fx, 0, [2, 48], true))).toEqual(['bigblast', 'smoke']);
    expect(kinds((fx) => queueIntercept(fx, 0, [2, 48]))).toEqual(['intercept', 'smoke']);
  });
});
