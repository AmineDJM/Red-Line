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
import {
  VIEW_SECTIONS,
  type BattleReport,
  type ChatMessage,
  type IntelOpView,
  type OperationView,
} from '@redline/shared';
import { demoBattleReport } from '../api/mockRest.js';
import { Emitter, type ChatChannel, type GameConnection, type OrderOutcome } from './connection.js';
import { demoReply, enrichView } from './mockWorld.js';
import { useWorld } from '../store/world.js';

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
  /** Sections des phases 2 à 6 (recherche, renseignement, diplomatie…). Défaut : vrai. */
  rich?: boolean;
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
  private chatLog: ChatMessage[] = [];

  start() {
    if (this.timer) return;
    this.clock = { ...this.clock, anchorReal: Date.now() };
    this.emit('status', 'open');
    this.emit('welcome', { game: this.meta, me: this.opts.me, clock: this.clock, view: this.view });
    this.emit('notify', this.initialNotes);
    if (this.chatLog.length) this.emit('chatHistory', this.chatLog);
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
    if (this.opts.rich !== false) {
      const extras = enrichView(view, {
        me,
        now,
        rnd,
        nations: this.data.nations,
        provinces,
        byNation,
        catalog: this.data.catalog,
        hostiles,
        capPt,
        captureTarget,
        threatened,
      });
      this.chatLog = extras.chat;
      notes.push(...extras.notes);
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
    const next: PlayerView = { ...this.view, time: d.time };
    const target = next as unknown as Record<string, unknown>;
    for (const k of VIEW_SECTIONS) {
      const v = (d as unknown as Record<string, unknown>)[k];
      if (v === undefined) continue;
      target[k] =
        k === 'provinces' || k === 'nations'
          ? { ...(this.view[k] as object), ...(v as object) }
          : v;
    }
    this.view = next;
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
    const meta = this.applyPhase2(order, t);
    if (meta) return meta;
    if (!('unitIds' in order)) return { ok: false, error: 'unknown' };
    const units = order.unitIds.map((id: string) => this.view.units[id]);
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

  /** Ordres des phases 2 à 6 : réponse plausible et mise à jour des sections de la vue. */
  private applyPhase2(order: Order, t: GameTime): OrderOutcome | null {
    const v = this.view;
    const me = this.opts.me;
    const ok = { ok: true } as const;
    switch (order.kind) {
      case 'research': {
        const r = v.research;
        if (!r) return ok;
        if (r.done.includes(order.nodeId) || r.queue.includes(order.nodeId)) return ok;
        if (r.current?.id === order.nodeId) return ok;
        if (!r.current)
          this.push({
            research: {
              ...r,
              current: { id: order.nodeId, startedAt: t, completesAt: t + 72 * HOUR },
            },
          });
        else this.push({ research: { ...r, queue: [...r.queue, order.nodeId] } });
        return ok;
      }
      case 'cancelResearch': {
        const r = v.research;
        if (!r) return ok;
        if (r.current?.id === order.nodeId) {
          const [next, ...rest] = r.queue;
          this.push({
            research: {
              ...r,
              current: next ? { id: next, startedAt: t, completesAt: t + 72 * HOUR } : null,
              queue: rest,
            },
          });
        } else this.push({ research: { ...r, queue: r.queue.filter((q) => q !== order.nodeId) } });
        return ok;
      }
      case 'buyLicence': {
        const s = this.sys(order.systemId);
        const price = (s?.cost.money ?? 0) * 20;
        if (v.economy.money < price) return { ok: false, error: 'insufficient_funds' };
        this.push({
          licences: [...(v.licences ?? []), { systemId: order.systemId, acquiredAt: t }],
          economy: { ...v.economy, money: v.economy.money - price },
        });
        return ok;
      }
      case 'cancelProduction':
        this.push({
          economy: {
            ...v.economy,
            production: v.economy.production.filter((p) => p.id !== order.productionId),
          },
        });
        return ok;
      case 'build':
      case 'repair': {
        const p = v.provinces[order.provinceId];
        if (!p) return { ok: false, error: 'invalid_target' };
        if (p.owner !== me) return { ok: false, error: 'not_owner' };
        const b = order.building === 'fortification' ? null : order.building;
        const state = [...(p.buildingState ?? [])];
        if (b) {
          const i = state.findIndex((x) => x.type === b);
          if (order.kind === 'repair' && i >= 0)
            state[i] = { ...state[i]!, repairUntil: t + 24 * HOUR };
          else if (i >= 0) state[i] = { ...state[i]!, upgradeUntil: t + 24 * HOUR };
          else state.push({ type: b, level: 1, health: 1, upgradeUntil: t + 18 * HOUR });
        }
        this.push({
          provinces: {
            [p.id]: {
              ...p,
              buildings: b && !p.buildings.includes(b) ? [...p.buildings, b] : p.buildings,
              buildingState: state,
              ...(order.building === 'fortification'
                ? {
                    fortification: {
                      provinceId: p.id,
                      level: (p.fortification?.level ?? 0) + 1,
                      completesAt: t + 12 * HOUR,
                    },
                  }
                : {}),
            },
          },
        });
        return ok;
      }
      case 'acceptOffer': {
        const m = v.market;
        const o = m?.offers.find((x) => x.id === order.offerId);
        if (!m || !o) return { ok: false, error: 'invalid_target' };
        if (v.economy.money < o.price) return { ok: false, error: 'insufficient_funds' };
        this.push({
          market: {
            ...m,
            offers: m.offers.filter((x) => x.id !== o.id),
            deliveries: [
              ...m.deliveries,
              {
                id: `d${++this.seq}`,
                from: o.seller,
                to: me,
                item: o.item,
                carrierUnitId: null,
                eta: t + 36 * HOUR,
                covert: false,
              },
            ],
          },
          economy: { ...v.economy, money: v.economy.money - o.price },
        });
        return ok;
      }
      case 'cancelOffer': {
        const m = v.market;
        if (m)
          this.push({ market: { ...m, offers: m.offers.filter((x) => x.id !== order.offerId) } });
        return ok;
      }
      case 'sellOffer': {
        const m = v.market;
        if (m)
          this.push({
            market: {
              ...m,
              offers: [
                ...m.offers,
                {
                  id: `o${++this.seq}`,
                  seller: me,
                  item: order.item,
                  price: order.price,
                  to: order.to ?? null,
                  createdAt: t,
                  expiresAt: t + 72 * HOUR,
                },
              ],
            },
          });
        return ok;
      }
      case 'blackMarket': {
        const m = v.market;
        const s = this.sys(order.systemId);
        const price = (s?.cost.money ?? 0) * 2.5 * order.count;
        if (v.economy.money < price) return { ok: false, error: 'insufficient_funds' };
        if (m)
          this.push({
            market: {
              ...m,
              deliveries: [
                ...m.deliveries,
                {
                  id: `d${++this.seq}`,
                  from: 'xxx',
                  to: me,
                  item: { type: 'units', systemId: order.systemId, count: order.count },
                  carrierUnitId: null,
                  eta: t + 60 * HOUR,
                  covert: true,
                },
              ],
            },
            economy: { ...v.economy, money: v.economy.money - price },
          });
        return ok;
      }
      case 'mobilize':
        if (v.logistics)
          this.push({
            logistics: { ...v.logistics, mobilized: order.on, mobilizedSince: order.on ? t : null },
          });
        return ok;
      case 'intelOp': {
        const i = v.intel;
        if (!i) return ok;
        const dept =
          order.op === 'counterintel_sweep'
            ? 'interior'
            : [
                  'listen_area',
                  'intercept_army',
                  'jam_area',
                  'cyber_radar',
                  'cyber_orders',
                  'deploy_decoys',
                  'fake_radio_traffic',
                  'recon_military',
                ].includes(order.op)
              ? 'military'
              : 'exterior';
        const d = i.departments.find((x) => x.id === dept);
        if (d && d.running >= d.capacity) return { ok: false, error: 'capacity' };
        // Reconnaissance d'un pays entier : durée et phases de data/balance (intel.reconNation).
        const rn =
          (order.op === 'recon_military' || order.op === 'recon_economic') &&
          !order.target.provinceId
            ? useWorld.getState().balance?.intel?.reconNation
            : undefined;
        const op: IntelOpView = {
          id: `io${++this.seq}`,
          kind: order.op,
          dept,
          target: order.target,
          startedAt: t,
          completesAt: t + (rn?.ops[order.op]?.durationH ?? 24) * HOUR,
          status: 'running',
          estimate: 0.55,
        };
        if (rn) op.recon = { waves: rn.waves, done: 0, ok: 0, provinces: 0 };
        this.push({
          intel: {
            ...i,
            operations: [op, ...i.operations],
            departments: i.departments.map((x) =>
              x.id === dept ? { ...x, running: x.running + 1 } : x,
            ),
          },
        });
        return ok;
      }
      case 'cancelIntelOp': {
        const i = v.intel;
        const op = i?.operations.find((x) => x.id === order.opId);
        if (i && op)
          this.push({
            intel: {
              ...i,
              operations: i.operations.filter((x) => x.id !== op.id),
              departments: i.departments.map((x) =>
                x.id === op.dept ? { ...x, running: Math.max(0, x.running - 1) } : x,
              ),
            },
          });
        return ok;
      }
      case 'intelBudget': {
        const i = v.intel;
        if (i)
          this.push({
            intel: {
              ...i,
              departments: i.departments.map((x) =>
                x.id === order.dept ? { ...x, budgetPerDay: order.budgetPerDay } : x,
              ),
            },
          });
        return ok;
      }
      case 'turnAgent': {
        const i = v.intel;
        if (i)
          this.push({
            intel: {
              ...i,
              caughtAgents: i.caughtAgents.map((a) =>
                a.id === order.agentId ? { ...a, turned: true } : a,
              ),
            },
          });
        return ok;
      }
      case 'declareWar':
      case 'proposePeace':
      case 'answerPeace': {
        const dip = v.diplomacy;
        if (!dip) return ok;
        const rel: 'war' | 'ceasefire' | null =
          order.kind === 'declareWar'
            ? 'war'
            : order.kind === 'answerPeace'
              ? order.accept
                ? 'ceasefire'
                : 'war'
              : null;
        const pendingKind = order.kind === 'proposePeace' ? order.type : 'peace';
        const relations = dip.relations.some((r) => r.nationId === order.nationId)
          ? dip.relations.map((r) =>
              r.nationId !== order.nationId
                ? r
                : rel
                  ? { ...r, relation: rel, since: t, pending: null }
                  : { ...r, pending: { from: me, kind: pendingKind, at: t } },
            )
          : [
              ...dip.relations,
              {
                nationId: order.nationId,
                relation: rel ?? ('peace' as const),
                since: t,
                pending: null,
              },
            ];
        const nv = v.nations[order.nationId];
        this.push({
          diplomacy: { ...dip, relations },
          ...(nv && rel ? { nations: { [nv.id]: { ...nv, relation: rel } } } : {}),
        });
        return ok;
      }
      case 'voteResolution': {
        const c = v.council;
        if (!c?.session) return ok;
        this.push({
          council: {
            ...c,
            session: {
              ...c.session,
              resolutions: c.session.resolutions.map((r) =>
                r.id === order.resolutionId ? { ...r, votes: { ...r.votes, [me]: order.vote } } : r,
              ),
            },
          },
        });
        return ok;
      }
      case 'proposeResolution': {
        const c = v.council;
        if (!c?.session) return { ok: false, error: 'locked' };
        this.push({
          council: {
            ...c,
            session: {
              ...c.session,
              resolutions: [
                ...c.session.resolutions,
                {
                  id: `res${++this.seq}`,
                  type: order.type,
                  proposer: me,
                  target: order.target,
                  text: order.text,
                  votes: { [me]: 'yes' },
                  status: 'proposed',
                  durationDays: 14,
                },
              ],
            },
          },
        });
        return ok;
      }
      case 'allianceVote': {
        const dip = v.diplomacy;
        if (!dip) return ok;
        this.push({
          diplomacy: {
            ...dip,
            alliances: dip.alliances.map((a) => ({
              ...a,
              votes: a.votes.map((x) =>
                x.id === order.voteId
                  ? {
                      ...x,
                      yes: order.yes ? [...x.yes, me] : x.yes,
                      no: order.yes ? x.no : [...x.no, me],
                    }
                  : x,
              ),
            })),
          },
        });
        return ok;
      }
      case 'allianceTreasury': {
        const dip = v.diplomacy;
        if (!dip) return ok;
        this.push({
          diplomacy: {
            ...dip,
            alliances: dip.alliances.map((a) =>
              a.id === dip.myAllianceId ? { ...a, treasury: a.treasury + order.amount } : a,
            ),
          },
          economy: { ...v.economy, money: v.economy.money - order.amount },
        });
        return ok;
      }
      case 'leaveAlliance': {
        const dip = v.diplomacy;
        if (dip)
          this.push({
            diplomacy: {
              ...dip,
              myAllianceId: null,
              alliances: dip.alliances.map((a) => ({
                ...a,
                members: a.members.filter((m) => m !== me),
              })),
            },
          });
        return ok;
      }
      case 'createAlliance': {
        const dip = v.diplomacy;
        if (!dip) return ok;
        const id = `al${++this.seq}`;
        this.push({
          diplomacy: {
            ...dip,
            myAllianceId: id,
            alliances: [
              ...dip.alliances,
              {
                id,
                name: order.name,
                flag: order.flag,
                leader: me,
                members: [me],
                charter: order.charter,
                treasury: 0,
                createdAt: t,
                votes: [],
                invites: [],
              },
            ],
          },
        });
        return ok;
      }
      case 'operation': {
        const op: OperationView = {
          id: `op${++this.seq}`,
          name: order.name,
          hHour: order.hHour,
          status: 'planned',
          steps: order.steps.map((s) => ({
            offsetMin: s.offsetMin,
            label: s.label ?? s.order.kind,
            status: 'pending',
          })),
        };
        this.push({ operations: [op, ...(v.operations ?? [])] });
        return ok;
      }
      case 'cancelOperation':
        this.push({
          operations: (v.operations ?? []).map((o) =>
            o.id === order.operationId ? { ...o, status: 'cancelled' } : o,
          ),
        });
        return ok;
      case 'delegate':
        this.push({
          generals: (v.generals ?? []).map((g) =>
            g.id === order.generalId ? { ...g, directive: order.directive, area: order.area } : g,
          ),
        });
        return ok;
      case 'appointGeneral':
        this.push({
          generals: (v.generals ?? []).map((g) =>
            g.id === order.generalId ? { ...g, unitIds: order.unitIds } : g,
          ),
        });
        return ok;
      case 'shareReport':
      case 'answerInvite':
      case 'inviteToAlliance':
      case 'allianceProposeVote':
      case 'courtNeutral':
      case 'fundRebels':
      case 'hireMercenaries':
      case 'transfer':
      case 'nuclearAuth':
        return ok;
      default:
        return null;
    }
  }

  /** Rapport de bataille détaillé (REST /battle-reports/:id en mode démonstration). */
  battleReport(id: string): BattleReport | null {
    const s = this.view.battleReports?.find((r) => r.id === id);
    return s ? demoBattleReport(s, this.catalog) : null;
  }

  sendChat(channel: ChatChannel, text: string, to?: string) {
    const me = this.opts.me;
    const ch =
      channel === 'alliance'
        ? `alliance:${this.view.diplomacy?.myAllianceId ?? 'none'}`
        : channel === 'private' && to
          ? `private:${[me, to].sort().join('|')}`
          : 'game';
    const last = this.chatLog[this.chatLog.length - 1]?.id ?? 0;
    const m: ChatMessage = {
      id: last + 1,
      gameId: this.meta.id,
      channel: ch,
      from: { userId: 'me', nationId: me, name: 'Vous' },
      text,
      sentAt: new Date().toISOString(),
    };
    this.chatLog.push(m);
    this.emit('chat', m);
    // Réponse simulée d'un autre joueur.
    setTimeout(() => {
      const other =
        channel === 'private' && to
          ? to
          : (Object.keys(this.view.nations).find((n) => n !== me) ?? null);
      const r: ChatMessage = {
        id: m.id + 1,
        gameId: this.meta.id,
        channel: ch,
        from: {
          userId: 'bot',
          nationId: other,
          name: other ? (this.view.nations[other]?.name ?? other) : 'IA',
        },
        text: demoReply(this.rnd),
        sentAt: new Date().toISOString(),
      };
      this.chatLog.push(r);
      this.emit('chat', r);
    }, 2200);
  }

  markChatRead() {
    /* rien à persister en démonstration */
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
