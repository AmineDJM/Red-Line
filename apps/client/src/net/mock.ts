/**
 * Connexion simulée (?mock=1) : fabrique une PlayerView plausible à partir des données de carte
 * et du catalogue, fait avancer l'horloge, et répond aux ordres de façon crédible (sans combat réel).
 * Sert aux tests visuels et au développement de l'interface sans serveur ni moteur.
 */
import {
  distanceKm,
  destination,
  bearing,
  gameTimeAt,
  movementDestination,
  movementEnd,
  positionAt,
  DAY,
  HOUR,
  MINUTE,
  type ClockState,
  type GameMeta,
  type GameNotification,
  type GameTime,
  type LngLat,
  type NationDef,
  type NationId,
  type NationView,
  type Order,
  type PlayerView,
  type ProvinceDef,
  type ProvinceView,
  type UnitView,
  type ViewDiff,
  type WeaponSystem,
} from '@redline/shared';
import type { FeatureCollection } from 'geojson';
import { Emitter, type GameConnection, type OrderOutcome } from './connection.js';

export interface MockData {
  nations: NationDef[];
  provinces: ProvinceDef[];
  catalog: WeaponSystem[];
  geo?: FeatureCollection | null;
}

export interface MockOptions {
  me: NationId;
  meta?: Partial<GameMeta>;
  seed?: number;
  /** Heure de jeu de départ. */
  startTime?: GameTime;
  tickMs?: number;
  /** Génère des événements aléatoires périodiques. */
  liveEvents?: boolean;
}

/** PRNG déterministe (mulberry32) : même vue simulée à chaque chargement. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ring = number[][];
function pointInRing(p: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function onLand(p: LngLat, geo: FeatureCollection | null | undefined): boolean {
  if (!geo) return true;
  for (const f of geo.features) {
    const g = f.geometry;
    const polys =
      g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      if (poly[0] && pointInRing(p, poly[0] as Ring)) return true;
    }
  }
  return false;
}

export class MockGameConnection extends Emitter implements GameConnection {
  readonly kind = 'mock' as const;
  private clock: ClockState;
  private view: PlayerView;
  private readonly meta: GameMeta;
  private readonly catalog: Map<string, WeaponSystem>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly rnd: () => number;

  constructor(
    private readonly data: MockData,
    private readonly opts: MockOptions,
  ) {
    super();
    this.rnd = prng(opts.seed ?? 7);
    this.catalog = new Map(data.catalog.map((s) => [s.id, s]));
    const start = opts.startTime ?? 3 * DAY + 7 * HOUR + 41 * MINUTE;
    this.clock = { anchorGame: start, anchorReal: Date.now(), speed: 1, paused: false };
    this.meta = {
      id: 'demo',
      name: 'Démonstration',
      mode: 'solo',
      scenarioId: 'world-today',
      status: 'running',
      speeds: [1, 2, 4, 8, 16],
      ...opts.meta,
    };
    const { view, notes } = this.build(start);
    this.view = view;
    this.initialNotes = notes;
  }

  private initialNotes: GameNotification[];

  start() {
    if (this.timer) return;
    this.clock = { ...this.clock, anchorReal: Date.now() };
    this.emit('status', 'open');
    this.emit('welcome', { game: this.meta, me: this.opts.me, clock: this.clock, view: this.view });
    this.emit('notify', this.initialNotes);
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    if (this.opts.liveEvents !== false)
      this.eventTimer = setInterval(() => this.randomEvent(), 14_000);
  }

  // ——— Construction de la vue initiale ———

  private sys(id: string): WeaponSystem | undefined {
    return this.catalog.get(id);
  }

  private pickSystem(
    cat: WeaponSystem['category'],
    prefer?: WeaponSystem['doctrine'],
  ): WeaponSystem | undefined {
    const all = this.data.catalog.filter((s) => s.category === cat);
    return all.find((s) => s.doctrine === prefer) ?? all[0];
  }

  private build(now: GameTime): { view: PlayerView; notes: GameNotification[] } {
    const { me } = this.opts;
    const rnd = this.rnd;
    const provinces = this.data.provinces;
    const byNation = new Map<NationId, ProvinceDef[]>();
    for (const p of provinces) {
      const l = byNation.get(p.nationId) ?? [];
      l.push(p);
      byNation.set(p.nationId, l);
    }
    const mine = byNation.get(me) ?? [];
    const myCap = mine.find((p) => p.isCapital) ?? mine[0];
    const capPt: LngLat = myCap?.cityPoint ?? [0, 30];

    // Nations hostiles : les voisines les plus proches (hors entités).
    const others = this.data.nations
      .filter((n) => n.id !== me && n.kind === 'state' && (byNation.get(n.id)?.length ?? 0) > 0)
      .map((n) => {
        const ps = byNation.get(n.id) ?? [];
        const d = Math.min(...ps.map((p) => distanceKm(p.cityPoint, capPt)));
        return { n, d };
      })
      .sort((a, b) => a.d - b.d);
    const hostiles = others.slice(0, 2).map((o) => o.n.id);

    const provViews: Record<string, ProvinceView> = {};
    for (const p of provinces)
      provViews[p.id] = { id: p.id, owner: p.nationId, capture: null, buildings: [...p.buildings] };

    // Une province ennemie en cours de capture par le joueur, une province du joueur menacée.
    const enemyFront = hostiles
      .flatMap((h) => byNation.get(h) ?? [])
      .sort((a, b) => distanceKm(a.cityPoint, capPt) - distanceKm(b.cityPoint, capPt));
    const myFront = [...mine].sort(
      (a, b) =>
        Math.min(...enemyFront.slice(0, 3).map((e) => distanceKm(a.cityPoint, e.cityPoint))) -
        Math.min(...enemyFront.slice(0, 3).map((e) => distanceKm(b.cityPoint, e.cityPoint))),
    );
    const captureTarget = enemyFront[0];
    if (captureTarget) {
      provViews[captureTarget.id]!.capture = {
        by: me,
        startedAt: now - 2 * HOUR,
        completesAt: now + 5 * HOUR,
      };
    }
    const threatened = myFront[0];
    const hostile0 = hostiles[0];
    if (threatened && hostile0 && threatened.id !== myCap?.id) {
      provViews[threatened.id]!.capture = {
        by: hostile0,
        startedAt: now - 30 * MINUTE,
        completesAt: now + 9 * HOUR,
      };
    }

    const units: Record<string, UnitView> = {};
    const add = (u: Omit<UnitView, 'id'>) => {
      const id = `u${++this.seq}`;
      units[id] = { id, ...u };
      return units[id]!;
    };
    const jitter = (p: LngLat, km: number): LngLat => destination(p, rnd() * 360, rnd() * km);

    // ——— Forces du joueur ———
    const front = myFront.slice(0, 4);
    const rear = mine.filter((p) => !front.includes(p));
    const place = (list: ProvinceDef[], i: number): LngLat =>
      list.length ? list[i % list.length]!.cityPoint : capPt;
    const ownPlan: [WeaponSystem['category'], number, 'front' | 'rear' | 'sea' | 'air'][] = [
      ['tank', 3, 'front'],
      ['ifv', 2, 'front'],
      ['infantry', 3, 'front'],
      ['artillery', 2, 'front'],
      ['air_defense', 2, 'rear'],
      ['strike_missile', 1, 'rear'],
      ['helicopter', 1, 'front'],
      ['fighter', 3, 'air'],
      ['drone', 2, 'air'],
      ['surface_ship', 1, 'sea'],
      ['submarine', 1, 'sea'],
    ];
    const seaSpot = (k: number): LngLat => {
      for (let r = 80; r <= 900; r += 40) {
        for (let a = 0; a < 360; a += 15) {
          const p = destination(capPt, a + k * 37, r + k * 25);
          if (!onLand(p, this.data.geo)) return p;
        }
      }
      return destination(capPt, 0, 200);
    };
    let k = 0;
    for (const [cat, n, where] of ownPlan) {
      const s = this.pickSystem(cat, 'ru');
      if (!s) continue;
      for (let i = 0; i < n; i++, k++) {
        const base =
          where === 'front'
            ? place(front, k)
            : where === 'rear'
              ? place(rear.length ? rear : front, k)
              : where === 'sea'
                ? seaSpot(k)
                : place(mine, k * 3);
        const pos = where === 'sea' ? base : jitter(base, where === 'air' ? 120 : 35);
        const u = add({
          owner: me,
          level: 'own',
          pos,
          lastSeen: now,
          uncertaintyKm: 0,
          systemId: s.id,
          count: s.unitSize,
          hpRatio: 0.55 + rnd() * 0.45,
          status: 'idle',
          stance: 'defend',
          xp: Math.round(rnd() * 400),
          targetId: null,
        });
        // Quelques unités en mouvement vers le front ennemi.
        if ((where === 'front' && i === 0) || (where === 'air' && i < 2)) {
          const tgt = enemyFront[(k + i) % Math.max(1, enemyFront.length)]?.cityPoint;
          if (tgt) {
            const dest: LngLat = where === 'air' ? tgt : interpolatePt(pos, tgt, 0.7);
            const d = distanceKm(pos, dest);
            const dur = (d / Math.max(1, s.speedKmh)) * HOUR;
            const t0 = now - dur * 0.3;
            const from = where === 'air' ? pos : pos;
            u.move = {
              legs: [
                { from, to: dest, t0, t1: t0 + dur, medium: where === 'air' ? 'air' : 'land' },
              ],
            };
            u.status = 'moving';
          }
        }
      }
    }

    // ——— Forces hostiles, à différents niveaux d'information ———
    const enemyPlan: [WeaponSystem['category'], InfoLevelMock][] = [
      ['tank', 'precise'],
      ['tank', 'identified'],
      ['ifv', 'identified'],
      ['infantry', 'precise'],
      ['artillery', 'detected'],
      ['air_defense', 'identified'],
      ['fighter', 'identified'],
      ['fighter', 'detected'],
      ['bomber', 'detected'],
      ['helicopter', 'precise'],
      ['tank', 'detected'],
      ['infantry', 'identified'],
    ];
    enemyPlan.forEach(([cat, level], i) => {
      const owner = hostiles[i % hostiles.length] ?? hostiles[0];
      if (!owner) return;
      const s = this.pickSystem(cat, 'eu') ?? this.pickSystem(cat);
      if (!s) return;
      const ps = byNation.get(owner) ?? [];
      const near = [...ps].sort(
        (a, b) => distanceKm(a.cityPoint, capPt) - distanceKm(b.cityPoint, capPt),
      );
      const base = near[i % Math.min(3, near.length)]?.cityPoint ?? capPt;
      const pos = jitter(base, 60);
      const stale = level === 'detected' ? 20 * MINUTE + rnd() * 90 * MINUTE : 0;
      const u = add({
        owner,
        level,
        pos,
        lastSeen: now - stale,
        uncertaintyKm: level === 'detected' ? 25 + rnd() * 50 : 0,
        ...(level !== 'detected' ? { systemId: s.id } : {}),
        ...(level === 'precise'
          ? { count: s.unitSize, hpRatio: 0.4 + rnd() * 0.6, status: 'idle' as const }
          : {}),
      });
      if (s.movement === 'air' && level !== 'detected') {
        const dest = jitter(capPt, 150);
        const d = distanceKm(pos, dest);
        const dur = (d / Math.max(1, s.speedKmh)) * HOUR;
        const t0 = now - dur * 0.2;
        u.move = { legs: [{ from: pos, to: dest, t0, t1: t0 + dur, medium: 'air' }] };
        if (level === 'precise') u.status = 'moving';
      }
    });

    const nations: Record<string, NationView> = {};
    for (const n of this.data.nations) {
      nations[n.id] = {
        id: n.id,
        name: n.name,
        color: n.color,
        isAi: n.id !== me,
        isPlayer: n.id === me,
        alive: true,
        provinceCount: byNation.get(n.id)?.length ?? 0,
      };
    }

    const cheap = this.data.catalog.slice().sort((a, b) => a.cost.money - b.cost.money);
    const view: PlayerView = {
      time: now,
      me,
      nations,
      provinces: provViews,
      units,
      economy: {
        money: 24_850,
        resources: { oil: 1_240, metals: 860, electronics: 432, food: 2_115 },
        incomePerDay: { money: 3_420, oil: 180, metals: 95, electronics: 40, food: 260 },
        production: [
          ...(cheap[0] && myCap
            ? [
                {
                  id: 'p1',
                  provinceId: myCap.id,
                  systemId: cheap[0].id,
                  startedAt: now - 3 * HOUR,
                  completesAt: now + 5 * HOUR,
                },
              ]
            : []),
          ...(cheap[3] && myCap
            ? [
                {
                  id: 'p2',
                  provinceId: myCap.id,
                  systemId: cheap[3].id,
                  startedAt: now - 10 * HOUR,
                  completesAt: now + 2 * HOUR,
                },
              ]
            : []),
        ],
      },
      victory: { provinceShareTarget: 0.6, leader: me, winner: null },
    };

    const notes: GameNotification[] = [];
    const firstEnemy = Object.values(units).find((u) => u.owner !== me);
    if (firstEnemy)
      notes.push({
        kind: 'unit_detected',
        time: now - 50 * MINUTE,
        at: firstEnemy.pos,
        unitId: firstEnemy.id,
      });
    if (captureTarget) {
      notes.push({
        kind: 'province_capture_started',
        time: now - 2 * HOUR,
        at: captureTarget.cityPoint,
        provinceId: captureTarget.id,
        by: me,
      });
    }
    const ownFront = Object.values(units).find((u) => u.owner === me && u.status === 'moving');
    if (ownFront && firstEnemy) {
      notes.push({
        kind: 'combat_started',
        time: now - 25 * MINUTE,
        at: ownFront.pos,
        unitIds: [ownFront.id, firstEnemy.id],
      });
    }
    if (threatened && hostile0) {
      notes.push({
        kind: 'province_capture_started',
        time: now - 30 * MINUTE,
        at: threatened.cityPoint,
        provinceId: threatened.id,
        by: hostile0,
      });
    }
    notes.sort((a, b) => a.time - b.time);
    return { view, notes };
  }

  // ——— Simulation minimale ———

  private now(): GameTime {
    return gameTimeAt(this.clock, Date.now());
  }

  private current(u: UnitView, t: GameTime): LngLat {
    return u.move ? positionAt(u.move, t) : u.pos;
  }

  private push(diff: Omit<ViewDiff, 'time'>) {
    const d: ViewDiff = { time: this.now(), ...diff };
    this.view = {
      ...this.view,
      time: d.time,
      ...(d.economy ? { economy: d.economy } : {}),
      ...(d.provinces ? { provinces: { ...this.view.provinces, ...d.provinces } } : {}),
    };
    if (d.units) {
      const units = { ...this.view.units };
      d.units.remove.forEach((id) => delete units[id]);
      d.units.upsert.forEach((u) => (units[u.id] = u));
      this.view.units = units;
    }
    this.emit('diff', d);
  }

  private tick() {
    if (this.clock.paused) return;
    const t = this.now();
    const upsert: UnitView[] = [];
    const notes: GameNotification[] = [];
    for (const u of Object.values(this.view.units)) {
      if (!u.move || movementEnd(u.move) > t) continue;
      const dest = movementDestination(u.move) ?? u.pos;
      const done: UnitView = {
        ...u,
        pos: dest,
        status: u.status === undefined ? undefined : 'idle',
      };
      delete done.move;
      if (u.owner === this.opts.me) {
        done.lastSeen = t;
        notes.push({ kind: 'arrived', time: t, at: dest, unitId: u.id });
      }
      upsert.push(done);
    }
    // Les unités du joueur sont « vues » à l'instant ; la production se termine.
    const eco = this.view.economy;
    const finished = eco.production.filter((p) => p.completesAt <= t);
    let economy = eco;
    if (finished.length) {
      economy = { ...eco, production: eco.production.filter((p) => p.completesAt > t) };
      for (const p of finished) {
        const s = this.sys(p.systemId);
        const at = this.data.provinces.find((x) => x.id === p.provinceId)?.cityPoint ?? [0, 0];
        const id = `u${++this.seq}`;
        upsert.push({
          id,
          owner: this.opts.me,
          level: 'own',
          pos: at,
          lastSeen: t,
          uncertaintyKm: 0,
          systemId: p.systemId,
          count: s?.unitSize ?? 1,
          hpRatio: 1,
          status: 'idle',
          stance: 'defend',
          xp: 0,
          targetId: null,
        });
        notes.push({ kind: 'production_complete', time: t, at, unitId: id, systemId: p.systemId });
      }
    }
    if (upsert.length || finished.length) {
      this.push({ units: { upsert, remove: [] }, ...(finished.length ? { economy } : {}) });
    } else {
      this.push({});
    }
    if (notes.length) this.emit('notify', notes);
  }

  private randomEvent() {
    if (this.clock.paused) return;
    const t = this.now();
    const enemies = Object.values(this.view.units).filter((u) => u.owner !== this.opts.me);
    const u = enemies[Math.floor(this.rnd() * enemies.length)];
    if (!u) return;
    this.emit('notify', [{ kind: 'unit_detected', time: t, at: this.current(u, t), unitId: u.id }]);
  }

  // ——— GameConnection ———

  async sendOrder(order: Order): Promise<OrderOutcome> {
    const t = this.now();
    const me = this.opts.me;
    if (order.kind === 'produce') {
      const s = this.sys(order.systemId);
      const prov = this.view.provinces[order.provinceId];
      if (!s || !prov) return { ok: false, error: 'invalid_target' };
      if (prov.owner !== me) return { ok: false, error: 'not_owner' };
      const eco = this.view.economy;
      if (eco.money < s.cost.money) return { ok: false, error: 'insufficient_funds' };
      this.push({
        economy: {
          ...eco,
          money: eco.money - s.cost.money,
          production: [
            ...eco.production,
            {
              id: `p${++this.seq}`,
              provinceId: order.provinceId,
              systemId: s.id,
              startedAt: t,
              completesAt: t + s.buildTimeH * HOUR,
            },
          ],
        },
      });
      return { ok: true };
    }
    const units = order.unitIds.map((id) => this.view.units[id]);
    if (units.some((u) => !u)) return { ok: false, error: 'unknown_unit' };
    if (units.some((u) => u!.owner !== me)) return { ok: false, error: 'not_owner' };
    const upsert: UnitView[] = [];
    for (const u of units as UnitView[]) {
      const pos = this.current(u, t);
      const s = u.systemId ? this.sys(u.systemId) : undefined;
      const base: UnitView = { ...u, pos, lastSeen: t };
      delete base.move;
      switch (order.kind) {
        case 'stop':
          upsert.push({ ...base, status: 'idle', targetId: null });
          break;
        case 'stance':
          upsert.push({ ...u, stance: order.stance });
          break;
        case 'move':
        case 'attack': {
          if (s?.movement === 'static') return { ok: false, error: 'not_allowed' };
          let to: LngLat;
          let targetId: string | null = null;
          if (order.kind === 'move') to = order.to;
          else {
            const tgt = this.view.units[order.targetId];
            if (!tgt || tgt.owner === me) return { ok: false, error: 'invalid_target' };
            targetId = tgt.id;
            const tp = this.current(tgt, t);
            const range = s?.weaponRangeKm.max ?? 0;
            const d = distanceKm(pos, tp);
            // S'approche jusqu'à portée de tir.
            to = d > range ? destination(pos, bearing(pos, tp), d - range * 0.8) : pos;
          }
          const d = distanceKm(pos, to);
          const speed = Math.max(1, s?.speedKmh ?? 40);
          const medium = s?.movement === 'sea' ? 'sea' : s?.movement === 'air' ? 'air' : 'land';
          const next: UnitView = { ...base, status: d > 0.5 ? 'moving' : 'combat', targetId };
          if (d > 0.5)
            next.move = { legs: [{ from: pos, to, t0: t, t1: t + (d / speed) * HOUR, medium }] };
          upsert.push(next);
          break;
        }
      }
    }
    this.push({ units: { upsert, remove: [] } });
    if (order.kind === 'attack') {
      const tgt = this.view.units[order.targetId];
      if (tgt)
        this.emit('notify', [
          {
            kind: 'combat_started',
            time: t,
            at: this.current(tgt, t),
            unitIds: [...order.unitIds, tgt.id],
          },
        ]);
    }
    return { ok: true };
  }

  private reanchor(patch: Partial<ClockState>) {
    const now = Date.now();
    this.clock = {
      ...this.clock,
      anchorGame: gameTimeAt(this.clock, now),
      anchorReal: now,
      ...patch,
    };
    this.emit('clock', this.clock);
  }

  setSpeed(speed: number) {
    this.reanchor({ speed });
  }

  setPaused(paused: boolean) {
    this.reanchor({ paused });
  }

  serverNow() {
    return Date.now();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.timer = this.eventTimer = null;
    this.emit('status', 'closed');
  }
}

type InfoLevelMock = 'precise' | 'identified' | 'detected';

function interpolatePt(a: LngLat, b: LngLat, f: number): LngLat {
  const d = distanceKm(a, b);
  return destination(a, bearing(a, b), d * f);
}
