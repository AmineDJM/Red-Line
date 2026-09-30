/**
 * Connexion locale : le moteur (@redline/engine) tourne dans le navigateur (bac à sable).
 * Codée contre le contrat figé de packages/engine/src/api.ts ; le module est chargé à la demande
 * et sa présence est vérifiée à l'exécution (le moteur est développé en parallèle).
 */
import {
  gameTimeAt,
  type ClockState,
  type GameMeta,
  type GameNotification,
  type NationId,
  type Order,
  type PlayerView,
  type UnitView,
} from '@redline/shared';
import type {
  AdvanceTo,
  ApplyOrder,
  BuildWorld,
  CreateGame,
  DiffViews,
  GameSetup,
  GameState,
  NotificationsFor,
  ViewFor,
  World,
} from '@redline/engine';
import { Emitter, type GameConnection, type OrderOutcome } from './connection.js';

export interface EngineModule {
  buildWorld: BuildWorld;
  createGame: CreateGame;
  applyOrder: ApplyOrder;
  advanceTo: AdvanceTo;
  viewFor: ViewFor;
  diffViews: DiffViews;
  notificationsFor: NotificationsFor;
}

const REQUIRED: (keyof EngineModule)[] = [
  'buildWorld',
  'createGame',
  'applyOrder',
  'advanceTo',
  'viewFor',
  'diffViews',
  'notificationsFor',
];

/** Charge le moteur ; renvoie null (et la liste des fonctions manquantes) s'il n'est pas encore implémenté. */
export async function loadEngine(): Promise<{ engine: EngineModule | null; missing: string[] }> {
  const mod = (await import('@redline/engine')) as unknown as Partial<Record<keyof EngineModule, unknown>>;
  const missing = REQUIRED.filter((k) => typeof mod[k] !== 'function');
  return { engine: missing.length ? null : (mod as unknown as EngineModule), missing };
}

export interface LocalOptions {
  /** Nation dont on prend la vue (bandeau, économie). */
  observer: NationId;
  /** Vue omnisciente : fusionne les vues de toutes les nations engagées (bac à sable). */
  godView: boolean;
  speeds?: number[];
  tickMs?: number;
  name?: string;
}

/** Fusionne les vues de plusieurs nations : chaque unité est prise dans la vue de son propriétaire. */
export function mergeViews(base: PlayerView, others: PlayerView[]): PlayerView {
  const units: Record<string, UnitView> = { ...base.units };
  for (const v of others) {
    for (const u of Object.values(v.units)) {
      const cur = units[u.id];
      if (u.level === 'own' || !cur) units[u.id] = u;
    }
  }
  return { ...base, units };
}

export class LocalGameConnection extends Emitter implements GameConnection {
  readonly kind = 'local' as const;
  readonly state: GameState;
  private clock: ClockState;
  private view: PlayerView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly nations: NationId[];
  private readonly meta: GameMeta;

  constructor(
    private readonly engine: EngineModule,
    world: World,
    setup: GameSetup,
    private readonly opts: LocalOptions,
  ) {
    super();
    this.state = engine.createGame(world, setup);
    this.nations = [...new Set([opts.observer, ...setup.players.map((p) => p.nationId), ...(setup.units ?? []).map((u) => u.owner)])];
    this.clock = { anchorGame: this.state.time, anchorReal: Date.now(), speed: 1, paused: true };
    this.meta = {
      id: 'sandbox',
      name: opts.name ?? 'sandbox',
      mode: 'solo',
      scenarioId: 'sandbox',
      status: 'running',
      speeds: opts.speeds ?? world.balance.time.speeds,
    };
    this.view = this.computeView();
  }

  start() {
    if (this.timer) return;
    this.emit('status', 'open');
    this.emit('welcome', { game: this.meta, me: this.opts.observer, clock: this.clock, view: this.view });
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 100);
  }

  private computeView(): PlayerView {
    const base = this.engine.viewFor(this.state, this.opts.observer);
    if (!this.opts.godView) return base;
    const others = this.nations.filter((n) => n !== this.opts.observer).map((n) => this.engine.viewFor(this.state, n));
    return mergeViews(base, others);
  }

  private now() {
    return gameTimeAt(this.clock, Date.now());
  }

  private advance(): GameNotification[] {
    const t = this.now();
    if (t <= this.state.time) return [];
    return this.engine.advanceTo(this.state, t);
  }

  private publish(items: GameNotification[]) {
    const next = this.computeView();
    const diff = this.engine.diffViews(this.view, next);
    this.view = next;
    if (diff) this.emit('diff', diff);
    const visible = this.opts.godView ? items : this.engine.notificationsFor(this.state, this.opts.observer, items);
    if (visible.length) this.emit('notify', visible);
  }

  private tick() {
    if (this.clock.paused) return;
    try {
      this.publish(this.advance());
    } catch (e) {
      console.error('Moteur local :', e);
      this.setPaused(true);
      this.emit('error', { code: 'engine', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Nation qui donne l'ordre : propriétaire de la première unité (bac à sable : toutes commandables). */
  private issuer(order: Order): NationId {
    if (order.kind === 'produce') return this.view.provinces[order.provinceId]?.owner ?? this.opts.observer;
    const first = order.unitIds[0];
    return (first && this.view.units[first]?.owner) || this.opts.observer;
  }

  async sendOrder(order: Order): Promise<OrderOutcome> {
    try {
      const items = this.advance();
      const res = this.engine.applyOrder(this.state, this.opts.godView ? this.issuer(order) : this.opts.observer, order);
      this.publish(items);
      return res;
    } catch (e) {
      return { ok: false, error: 'not_allowed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private reanchor(patch: Partial<ClockState>) {
    const now = Date.now();
    this.clock = { ...this.clock, anchorGame: gameTimeAt(this.clock, now), anchorReal: now, ...patch };
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
    this.timer = null;
    this.emit('status', 'closed');
  }
}
