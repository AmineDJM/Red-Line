import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type PlayerView,
  type ServerMessage,
} from '@redline/shared';
import { ClockSync } from '../src/net/clockSync.js';
import { backoffDelay, WsGameConnection } from '../src/net/ws.js';
import { bindConnection, useGame } from '../src/store/game.js';

/** WebSocket factice : enregistre les envois, permet de simuler le serveur. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: Uint8Array) {
    this.sent.push(decodeMessage<ClientMessage>(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMessage) {
    const bytes = encodeMessage(msg);
    this.onmessage?.({
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

const view: PlayerView = {
  time: 0,
  me: 'fra',
  nations: {},
  provinces: {},
  units: {
    u1: { id: 'u1', owner: 'fra', level: 'own', pos: [0, 0], lastSeen: 0, uncertaintyKm: 0 },
  },
  economy: {
    money: 0,
    resources: { oil: 0, metals: 0, electronics: 0, food: 0 },
    incomePerDay: { money: 0 },
    production: [],
  },
  victory: { provinceShareTarget: 0.6, leader: null, winner: null },
};

const welcome: ServerMessage = {
  t: 'welcome',
  game: {
    id: 'g1',
    name: 'Test',
    mode: 'solo',
    scenarioId: 'world-today',
    status: 'running',
    speeds: [1, 2],
  },
  me: 'fra',
  clock: { anchorGame: 0, anchorReal: 0, speed: 1, paused: false },
  view,
};

function connect() {
  const conn = new WsGameConnection('g1', {
    url: 'ws://test/ws?gameId=g1',
    WebSocketImpl: FakeSocket as unknown as new (url: string) => WebSocket,
    random: () => 0.5,
  });
  const unbind = bindConnection(conn);
  const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  return { conn, unbind, sock };
}

describe('WsGameConnection', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applique welcome puis les diffs dans le store', () => {
    const { sock, unbind } = connect();
    sock.open();
    expect(useGame.getState().status).toBe('open');
    sock.receive(welcome);
    expect(useGame.getState().me).toBe('fra');
    expect(Object.keys(useGame.getState().view!.units)).toEqual(['u1']);
    sock.receive({
      t: 'diff',
      diff: { time: 5000, units: { upsert: [{ ...view.units.u1!, pos: [1, 1] }], remove: [] } },
    });
    expect(useGame.getState().view!.units.u1!.pos).toEqual([1, 1]);
    expect(useGame.getState().view!.time).toBe(5000);
    sock.receive({
      t: 'notify',
      items: [{ kind: 'arrived', time: 5000, at: [1, 1], unitId: 'u1' }],
    });
    expect(useGame.getState().notifications).toHaveLength(1);
    sock.receive({
      t: 'clock',
      clock: { anchorGame: 5000, anchorReal: 10, speed: 4, paused: false },
    });
    expect(useGame.getState().clock!.speed).toBe(4);
    unbind();
  });

  it('résout les ordres avec orderResult et encode les messages en MessagePack', async () => {
    const { conn, sock, unbind } = connect();
    sock.open();
    const p = conn.sendOrder({ kind: 'stop', unitIds: ['u1'] });
    const sent = sock.sent.find((m) => m.t === 'order');
    expect(sent).toBeDefined();
    if (sent?.t !== 'order') throw new Error();
    sock.receive({ t: 'orderResult', id: sent.id, ok: false, error: 'not_owner' });
    await expect(p).resolves.toMatchObject({ ok: false, error: 'not_owner' });
    conn.setSpeed(2);
    conn.setPaused(true);
    expect(sock.sent.filter((m) => m.t === 'control')).toEqual([
      { t: 'control', speed: 2 },
      { t: 'control', paused: true },
    ]);
    unbind();
  });

  it('refuse les ordres hors connexion et échoue les ordres en attente à la coupure', async () => {
    const { conn, sock, unbind } = connect();
    await expect(conn.sendOrder({ kind: 'stop', unitIds: ['u1'] })).resolves.toMatchObject({
      ok: false,
      error: 'disconnected',
    });
    sock.open();
    const p = conn.sendOrder({ kind: 'stop', unitIds: ['u1'] });
    sock.drop();
    await expect(p).resolves.toMatchObject({ ok: false, error: 'disconnected' });
    unbind();
  });

  it('se reconnecte avec backoff exponentiel', () => {
    const { sock, unbind } = connect();
    sock.open();
    sock.drop();
    expect(useGame.getState().status).toBe('reconnecting');
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(backoffDelay(0, () => 0.5));
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.drop();
    vi.advanceTimersByTime(backoffDelay(1, () => 0.5) - 1);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.open();
    expect(useGame.getState().status).toBe('open');
    unbind();
  });

  it('ne se reconnecte pas après un refus définitif (44xx)', () => {
    const { sock, unbind } = connect();
    sock.drop(4404);
    expect(useGame.getState().status).toBe('failed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    unbind();
  });

  it("partie supprimée : retour à l'accueil, sans reconnexion", () => {
    const pushed: string[] = [];
    vi.stubGlobal('window', {
      location: { origin: 'http://test', pathname: '/game/g1', search: '' },
      history: {
        pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
        replaceState: (_s: unknown, _t: string, url: string) => pushed.push(url),
      },
      addEventListener: () => undefined,
    });
    const { sock, unbind } = connect();
    sock.open();
    sock.receive(welcome);
    sock.receive({ t: 'error', code: 'game_deleted', message: 'La partie a été supprimée.' });
    sock.drop(1000);
    expect(useGame.getState().status).toBe('failed');
    expect(pushed).toEqual(['/']);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    unbind();
    vi.unstubAllGlobals();
  });

  it("synchronise l'horloge par ping/pong", () => {
    const { conn, sock, unbind } = connect();
    vi.setSystemTime(1_000_000);
    sock.open();
    const ping = sock.sent.find((m) => m.t === 'ping');
    if (ping?.t !== 'ping') throw new Error('pas de ping');
    vi.setSystemTime(1_000_100); // aller-retour 100 ms
    sock.receive({ t: 'pong', clientTime: ping.clientTime, serverTime: 1_000_050 + 5000 });
    expect(conn.serverNow() - Date.now()).toBeCloseTo(5000, -1);
    unbind();
  });
});

describe('ClockSync', () => {
  it("retient l'échantillon au plus petit aller-retour", () => {
    const s = new ClockSync(4);
    s.add(0, 1000 + 50, 100); // rtt 100 → offset 1000
    s.add(200, 2000, 1200); // rtt 1000 → offset 1300 (bruité)
    expect(s.offset).toBeCloseTo(1000);
    expect(s.rtt).toBe(100);
  });

  it('borne le nombre d’échantillons', () => {
    const s = new ClockSync(2);
    s.add(0, 10, 10);
    s.add(0, 10, 20);
    s.add(0, 10, 30);
    expect(s.size).toBe(2);
  });
});

describe('backoffDelay', () => {
  it('croît exponentiellement puis plafonne à 15 s (±25 %)', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(500);
    expect(backoffDelay(1, mid)).toBe(1000);
    expect(backoffDelay(3, mid)).toBe(4000);
    expect(backoffDelay(20, mid)).toBe(15000);
    expect(backoffDelay(20, () => 1)).toBe(18750);
    expect(backoffDelay(20, () => 0)).toBe(11250);
  });
});
