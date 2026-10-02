import { describe, expect, it } from 'vitest';
import type { Feature } from 'geojson';
import {
  HOUR,
  type Movement,
  type NationView,
  type ProvinceDef,
  type ProvinceView,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';
import { dashSequence, pulse } from '../src/map/animations.js';
import {
  buildingFeatures,
  cityClass,
  headingOffset,
  intelFeatures,
  missileFeatures,
  pionSpecFor,
  tokenFeatures,
  unitInfos,
} from '../src/map/features.js';
import { miniProjection } from '../src/map/MiniMap.js';
import { relationOf } from '../src/map/palette.js';
import { compactCount, parsePionKey, pionKey } from '../src/map/pions.js';
import { diffFeatures } from '../src/map/sourceSync.js';

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
const nations = {
  fra: nation('fra'),
  deu: nation('deu', 'ally'),
  esp: nation('esp', 'peace'),
  rus: nation('rus', 'war'),
};
const sys = (id: string, category: string, movement = 'land'): WeaponSystem =>
  ({ id, name: id, category, movement, icon: category }) as unknown as WeaponSystem;
const catalog = {
  tank: sys('tank', 'tank'),
  f16: sys('f16', 'fighter', 'air'),
  ssk: sys('ssk', 'submarine', 'sea'),
  cm: sys('cm', 'strike_missile', 'air'),
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
const ctx = {
  me: 'fra',
  nations,
  catalog,
  selection: new Set<string>(),
  target: null,
  t: HOUR,
};

describe('relations et pions', () => {
  it('relation : ses forces, alliés, neutres, ennemis ; sans diplomatie = hostile', () => {
    expect(relationOf('fra', 'fra', nations)).toBe('own');
    expect(relationOf('deu', 'fra', nations)).toBe('ally');
    expect(relationOf('esp', 'fra', nations)).toBe('neutral');
    expect(relationOf('rus', 'fra', nations)).toBe('enemy');
    expect(relationOf('xxx', 'fra', nations)).toBe('enemy');
  });

  it("la clé d'image ne dépend ni de l'effectif ni de la barre d'état", () => {
    const [a] = unitInfos([unit('a', { count: 3, hpRatio: 0.2 })], ctx);
    const [b] = unitInfos([unit('b', { count: 40, hpRatio: 1 })], ctx);
    expect(pionKey(pionSpecFor([a!], ctx))).toBe(pionKey(pionSpecFor([b!], ctx)));
    const spec = parsePionKey(pionKey(pionSpecFor([a!], ctx)))!;
    expect(spec.nation).toBe('fra');
    expect(spec.rel).toBe('own');
    expect(spec.glyph).toBe('tank');
  });

  it('effectif compact', () => {
    expect(compactCount(7)).toBe('7');
    expect(compactCount(1250)).toBe('1,3k');
    // 1 à 4 chiffres : jamais plus de 4 signes (zone d'effectif du pion).
    expect(['1', '22', '333', '4444'].map((x) => compactCount(Number(x)))).toEqual([
      '1',
      '22',
      '333',
      '4,4k',
    ]);
    expect(compactCount(1000)).toBe('1k');
    expect(compactCount(9960)).toBe('10k');
    expect(compactCount(123_456)).toBe('123k');
    expect(compactCount(2_500_000)).toBe('2,5M');
    for (const n of [5, 99, 999, 1049, 9999, 54_321, 999_999, 12_000_000])
      expect(compactCount(n).length).toBeLessThanOrEqual(4);
    expect(compactCount(undefined)).toBe('');
  });

  it('états : combat, ravitaillement coupé, sous-marin, contact imprécis, leurre du propriétaire', () => {
    const infos = unitInfos(
      [
        unit('a', { status: 'combat', supply: 'cut' }),
        unit('b', { systemId: 'ssk' }),
        unit('c', { owner: 'rus', level: 'identified', systemId: 'ssk' }),
        unit('d', { owner: 'rus', level: 'detected', systemId: undefined }),
        unit('e', { decoy: true }),
      ],
      ctx,
    );
    const f = Object.fromEntries(infos.map((i) => [i.id, i.flags]));
    expect(f.a).toContain('c');
    expect(f.a).toContain('s');
    expect(f.b).toContain('u');
    expect(f.c).toContain('n');
    expect(f.d).toContain('x');
    expect(f.e).toContain('d');
  });

  it('aéronef en vol : cap ; missile en vol : marqueur séparé', () => {
    const move: Movement = {
      legs: [{ from: [0, 0], to: [10, 0], t0: 0, t1: 2 * HOUR, medium: 'air' }],
    };
    const infos = unitInfos(
      [
        unit('jet', { systemId: 'f16', move, status: 'moving' }),
        unit('m', {
          systemId: 'cm',
          move,
          missile: { target: { type: 'point', at: [10, 0] }, impactAt: 2 * HOUR },
        }),
      ],
      ctx,
    );
    const jet = infos.find((i) => i.id === 'jet')!;
    expect(jet.heading).not.toBeNull();
    expect(jet.heading!).toBeGreaterThan(80);
    expect(jet.heading!).toBeLessThan(100);
    const r = tokenFeatures(infos, { nations, zoom: 6, group: true });
    expect(r.missiles.map((x) => x.properties!.id)).toEqual(['m']);
    expect(r.headings).toHaveLength(1);
    const m = missileFeatures(
      [
        unit('m', {
          systemId: 'cm',
          move,
          missile: { target: { type: 'point', at: [10, 0] }, impactAt: 2 * HOUR },
        }),
      ],
      HOUR,
      'fra',
    );
    expect(m.trails.features).toHaveLength(1);
    expect(m.impacts.features).toHaveLength(1);
  });

  it('la sélection sort du regroupement', () => {
    const units = [unit('a'), unit('b'), unit('c')];
    const infos = unitInfos(units, { ...ctx, selection: new Set(['b']) });
    const r = tokenFeatures(infos, { nations, zoom: 8, group: true });
    expect(r.focus.map((x) => x.properties!.id)).toEqual(['b']);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]!.properties!.n).toBe(2);
    expect(r.tokens[0]!.properties!.stk).toBe('2');
    expect(r.tokens[0]!.properties!.cnt).toBe('20');
  });

  it('flèche de cap : sur le pourtour du pion, dans le repère tourné', () => {
    const up = headingOffset(0, [0, 0]);
    expect(up[0]).toBeCloseTo(0);
    expect(up[1]).toBeLessThan(0);
    const east = headingOffset(90, [0, 0]);
    // Plus loin vers l'est (le pion est plus large que haut).
    expect(Math.abs(east[1])).toBeGreaterThan(Math.abs(up[1]));
  });
});

describe('provinces : villes, bâtiments, renseignement', () => {
  const def = (over: Partial<ProvinceDef> = {}): ProvinceDef =>
    ({
      id: 'p1',
      name: 'Province',
      nationId: 'rus',
      centroid: [30, 50],
      cityPoint: [30, 50],
      isCapital: false,
      coastal: false,
      income: { money: 10 },
      buildings: [],
      neighbors: [],
      areaKm2: 1000,
      ...over,
    }) as ProvinceDef;

  it('classe de ville : rang des données, sinon capitale / revenu', () => {
    expect(cityClass(def({ cityRank: 1 }), [100, 10])).toBe(0);
    expect(cityClass(def({ cityRank: 4 }), [100, 10])).toBe(3);
    expect(cityClass(def({ isCapital: true }), [100, 10])).toBe(0);
    expect(cityClass(def({ income: { money: 200 } }), [100, 10])).toBe(1);
  });

  it('bâtiments : niveau, état endommagé, renseignement ancien estompé', () => {
    const p: ProvinceView = {
      id: 'p1',
      owner: 'rus',
      buildings: ['radar_station', 'bunker'],
      buildingState: [
        { type: 'radar_station', level: 3, health: 0.4 },
        { type: 'bunker', level: 1, health: 0 },
      ],
      intel: { level: 2, economic: true, military: true, updatedAt: 0 },
    };
    const f = buildingFeatures([p], { me: 'fra', nations, defs: { p1: def() }, t: 48 * HOUR });
    const props = f.features.map((x) => x.properties!);
    expect(props[0]!.img).toBe('bld|radar_station|enemy|dmg|3');
    expect(props[1]!.img).toBe('bld|bunker|enemy|down|1');
    expect(props[0]!.op).toBe(0.5);
    const intel = intelFeatures([p], { p1: def() }, 48 * HOUR);
    expect(intel.features[0]!.properties!.img).toBe('intel|2');
  });
});

describe('performances (coût JS par mise à jour des pions)', () => {
  it('1 000 unités dont un tiers en mouvement : informations, regroupement, différentiel', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const owners = ['fra', 'deu', 'esp', 'rus'];
    const units: UnitView[] = Array.from({ length: 1000 }, (_, i) => {
      const pos: [number, number] = [-5 + rnd() * 30, 35 + rnd() * 20];
      const moving = i % 3 === 0;
      return unit(`u${i}`, {
        owner: owners[i % 4]!,
        level: i % 4 === 0 ? 'own' : 'precise',
        pos,
        systemId: i % 5 === 0 ? 'f16' : 'tank',
        ...(moving
          ? {
              move: {
                legs: [
                  {
                    from: pos,
                    to: [pos[0] + 2, pos[1] + 1] as [number, number],
                    t0: 0,
                    t1: 10 * HOUR,
                    medium: i % 5 === 0 ? ('air' as const) : ('land' as const),
                  },
                ],
              },
              status: 'moving' as const,
            }
          : {}),
      });
    });
    const run = (t: number, zoom: number, prev: ReturnType<typeof diffFeatures>['state']) => {
      const infos = unitInfos(units, { ...ctx, t });
      const r = tokenFeatures(infos, { nations, zoom, group: true });
      return diffFeatures(prev, r.tokens);
    };
    let state = run(HOUR, 5, new Map()).state;
    const t0 = performance.now();
    const N = 10;
    for (let k = 1; k <= N; k++) state = run(HOUR + k * 60_000, 5, state).state;
    const ms = (performance.now() - t0) / N;
    console.log(`1 000 unités : ${ms.toFixed(1)} ms par mise à jour complète (zoom 5)`);
    // Budget large (machine partagée) : ≈ 10-15 ms mesurés hors charge.
    expect(ms).toBeLessThan(120);
  });
});

describe('outils', () => {
  it('différentiel de source : ajout, retrait, déplacement, propriété', () => {
    const pt = (id: string, x: number, extra: Record<string, unknown> = {}): Feature => ({
      type: 'Feature',
      properties: { id, ...extra },
      geometry: { type: 'Point', coordinates: [x, 0] },
    });
    const first = diffFeatures(new Map(), [pt('a', 0), pt('b', 1)]);
    expect(first.diff.add).toHaveLength(2);
    const second = diffFeatures(first.state, [pt('a', 0.5), pt('c', 2, { img: 'x' })]);
    expect(second.diff.remove).toEqual(['b']);
    expect(second.diff.add?.map((f) => f.properties!.id)).toEqual(['c']);
    expect(second.diff.update?.[0]?.newGeometry).toBeDefined();
    const third = diffFeatures(second.state, [pt('a', 0.5), pt('c', 2, { img: 'y' })]);
    expect(third.changed).toBe(1);
    expect(third.diff.update?.[0]?.addOrUpdateProperties).toEqual([{ key: 'img', value: 'y' }]);
  });

  it('tirets animés : période constante, motifs valides', () => {
    const seq = dashSequence(2, 2, 8);
    expect(seq).toHaveLength(8);
    for (const d of seq) {
      expect(d.every((v) => v >= 0)).toBe(true);
      expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(4);
    }
    expect(pulse(0, 1000, 0.2, 0.6)).toBeCloseTo(0.4);
  });

  it('mini-carte : projection centrée, rayon au bord du cadre', () => {
    const p = miniProjection([2, 48], 100, 400, 200);
    const [cx, cy] = p.project([2, 48]);
    expect(cx).toBeCloseTo(200);
    expect(cy).toBeCloseTo(100);
    // 100 km vers le nord ≈ bord supérieur (demi-hauteur = 100 px).
    const [, ny] = p.project([2, 48 + 100 / 111.2]);
    expect(ny).toBeGreaterThan(-8);
    expect(ny).toBeLessThan(8);
    const back = p.unproject(cx, cy);
    expect(back[0]).toBeCloseTo(2);
    expect(back[1]).toBeCloseTo(48);
  });
});
