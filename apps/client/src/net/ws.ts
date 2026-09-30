import {
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type Order,
  type ServerMessage,
} from '@redline/shared';
import { ClockSync } from './clockSync.js';
import { Emitter, type GameConnection, type OrderOutcome } from './connection.js';

type WsCtor = new (url: string) => WebSocket;

export interface WsOptions {
  /** URL complète (défaut : même origine, /ws?gameId=…). */
  url?: string;
  /** Implémentation injectable (tests). */
  WebSocketImpl?: WsCtor;
  /** Délai max d'attente d'un orderResult, en ms. */
  orderTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Aléa du backoff (injectable pour les tests). */
  random?: () => number;
}

/** Délai de reconnexion : exponentiel plafonné à 15 s, avec ±25 % d'aléa. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * Connexion WebSocket au serveur : MessagePack, reconnexion avec backoff, synchronisation
 * d'horloge par ping/pong. Après une reconnexion, le serveur renvoie `welcome` (vue complète).
 */
export class WsGameConnection extends Emitter implements GameConnection {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (o: OrderOutcome) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly sync = new ClockSync();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<Omit<WsOptions, 'url' | 'WebSocketImpl'>> & {
    url: string;
    WebSocketImpl: WsCtor;
  };

  constructor(
    readonly gameId: string,
    opts: WsOptions = {},
  ) {
    super();
    const loc = typeof window !== 'undefined' ? window.location : null;
    const url =
      opts.url ??
      `${loc?.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc?.host ?? 'localhost'}/ws?gameId=${encodeURIComponent(gameId)}`;
    this.opts = {
      url,
      WebSocketImpl: opts.WebSocketImpl ?? WebSocket,
      orderTimeoutMs: opts.orderTimeoutMs ?? 15_000,
      pingIntervalMs: opts.pingIntervalMs ?? 15_000,
      random: opts.random ?? Math.random,
    };
  }

  private started = false;
  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.emit('status', this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new this.opts.WebSocketImpl(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.sync.reset();
      this.emit('status', 'open');
      // Trois pings rapprochés pour une estimation initiale, puis périodiques.
      this.ping();
      setTimeout(() => this.ping(), 300);
      setTimeout(() => this.ping(), 900);
      this.pingTimer = setInterval(() => this.ping(), this.opts.pingIntervalMs);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') return;
      let msg: ServerMessage;
      try {
        msg = decodeMessage<ServerMessage>(ev.data as ArrayBuffer);
      } catch (e) {
        console.warn('Message illisible', e);
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev: CloseEvent) => {
      this.cleanupSocket();
      this.failPending();
      if (this.closed) return;
      // Codes 44xx : refus définitif (authentification, partie introuvable) — pas de reconnexion.
      if (ev.code >= 4400 && ev.code < 4500) {
        this.emit('status', 'failed');
        this.emit('error', { code: String(ev.code), message: ev.reason || 'refused' });
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose suit toujours */
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = backoffDelay(this.attempt++, this.opts.random);
    this.emit('status', 'reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanupSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    }
    this.ws = null;
  }

  private failPending() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'disconnected' });
      this.pending.delete(id);
    }
  }

  private handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.emit('welcome', { game: msg.game, me: msg.me, clock: msg.clock, view: msg.view });
        break;
      case 'diff':
        this.emit('diff', msg.diff);
        break;
      case 'clock':
        this.emit('clock', msg.clock);
        break;
      case 'notify':
        this.emit('notify', msg.items);
        break;
      case 'orderResult': {
        const p = this.pending.get(msg.id);
        const outcome: OrderOutcome = { ok: msg.ok, error: msg.error, message: msg.message };
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(outcome);
        }
        this.emit('orderResult', { id: msg.id, ...outcome });
        break;
      }
      case 'pong':
        this.sync.add(msg.clientTime, msg.serverTime, Date.now());
        break;
      case 'error':
        this.emit('error', { code: msg.code, message: msg.message });
        break;
    }
  }

  private send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(encodeMessage(msg));
    return true;
  }

  private ping() {
    this.send({ t: 'ping', clientTime: Date.now() });
  }

  sendOrder(order: Order): Promise<OrderOutcome> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.send({ t: 'order', id, order })) {
        resolve({ ok: false, error: 'disconnected' });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, this.opts.orderTimeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  setSpeed(speed: number) {
    this.send({ t: 'control', speed });
  }

  setPaused(paused: boolean) {
    this.send({ t: 'control', paused });
  }

  serverNow(): number {
    return Date.now() + this.sync.offset;
  }

  /** Aller-retour estimé (ms), null tant qu'aucun pong. */
  get rtt(): number | null {
    return this.sync.rtt;
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.cleanupSocket();
    this.failPending();
    try {
      ws?.close(1000);
    } catch {
      /* déjà fermée */
    }
    this.emit('status', 'closed');
  }
}
