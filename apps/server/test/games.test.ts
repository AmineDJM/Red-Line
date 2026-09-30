import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import type { PlayerView } from '@redline/shared';
import {
  WsClient,
  createGame,
  dbAvailable,
  guest,
  listen,
  makeDataDir,
  resetDb,
  sleep,
  sqlQuery,
  startApp,
} from './helpers.js';
import { PATROL_PERIOD_MS } from './fake-engine.js';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('parties solo et passerelle WebSocket', () => {
  let built: BuiltApp;
  let port: number;
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir });
    port = await listen(built.app);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('liste les scénarios (défaut « world-today »)', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(res.json().scenarios).toEqual([
      expect.objectContaining({ id: 'world-today', playableNations: 'all' }),
    ]);
  });

  it('crée une partie solo, la liste et renvoie sa méta', async () => {
    const p = await guest(built.app);
    const anon = await built.app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { nationId: 'fra' },
    });
    expect(anon.statusCode).toBe(401);

    const bad = await built.app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { cookie: p.cookie },
      payload: { nationId: 'xyz' },
    });
    expect(bad.statusCode).toBe(400);
    const badSpeed = await built.app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { cookie: p.cookie },
      payload: { nationId: 'fra', speed: 3 },
    });
    expect(badSpeed.statusCode).toBe(400);

    const id = await createGame(built.app, p.cookie, { nationId: 'dza', speed: 2 });
    const list = await built.app.inject({
      method: 'GET',
      url: '/api/games',
      headers: { cookie: p.cookie },
    });
    expect(list.json().games).toEqual([
      expect.objectContaining({
        nationId: 'dza',
        game: expect.objectContaining({
          id,
          mode: 'solo',
          status: 'running',
          speeds: [1, 2, 4, 1000],
        }),
      }),
    ]);
    const meta = await built.app.inject({
      method: 'GET',
      url: `/api/games/${id}`,
      headers: { cookie: p.cookie },
    });
    expect(meta.json()).toMatchObject({ me: 'dza', game: { id, scenarioId: 'world-today' } });
    expect(meta.json().game.name).toContain('Algérie');

    const other = await guest(built.app);
    const forbidden = await built.app.inject({
      method: 'GET',
      url: `/api/games/${id}`,
      headers: { cookie: other.cookie },
    });
    expect(forbidden.statusCode).toBe(404);

    const [row] = await sqlQuery(
      (
        sql,
      ) => sql`SELECT g.lease_owner, g.speed, (SELECT count(*)::int FROM game_snapshots s WHERE s.game_id = g.id) AS snaps
                   FROM games g WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ lease_owner: 'test-a', speed: 2, snaps: 1 });
  });

  it('refuse le WebSocket sans session ou à un non-joueur', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    await expect(WsClient.connect(port, id)).rejects.toThrow('HTTP 401');
    const other = await guest(built.app);
    await expect(WsClient.connect(port, id, other.cookie)).rejects.toThrow('HTTP 403');
    await expect(WsClient.connect(port, 'pas-un-uuid', p.cookie)).rejects.toThrow('HTTP 400');
    // Détournement inter-sites : origine étrangère refusée, origine du site acceptée.
    await expect(
      WsClient.connect(port, id, p.cookie, { origin: 'https://evil.example' }),
    ).rejects.toThrow('HTTP 403');
    const same = await WsClient.connect(port, id, p.cookie, { origin: `http://127.0.0.1:${port}` });
    await same.next('welcome');
    await same.close();
  });

  it('welcome, ordre valide (orderResult + diff + journal), ordre invalide, message invalide, ping', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    try {
      const welcome = await ws.next('welcome');
      expect(welcome.me).toBe('fra');
      expect(welcome.game.id).toBe(id);
      expect(welcome.clock).toMatchObject({ speed: 1, paused: false });
      expect(Object.keys(welcome.view.units).sort()).toEqual(['fra-1', 'scout']);
      expect(welcome.view.units.scout!.level).toBe('detected');

      ws.send({ t: 'order', id: 1, order: { kind: 'move', unitIds: ['fra-1'], to: [3, 45] } });
      const ok = await ws.next('orderResult', (m) => m.id === 1);
      expect(ok).toMatchObject({ ok: true });
      const diff = await ws.next(
        'diff',
        (m) => !!m.diff.units?.upsert.some((u) => u.id === 'fra-1' && u.move),
      );
      expect(diff.diff.units!.upsert[0]!.move!.legs[0]!.to).toEqual([3, 45]);

      // Ordre refusé par le moteur (unité d'une autre nation).
      ws.send({ t: 'order', id: 2, order: { kind: 'move', unitIds: ['scout'], to: [3, 45] } });
      expect(await ws.next('orderResult', (m) => m.id === 2)).toMatchObject({
        ok: false,
        error: 'not_owner',
      });
      // Unité inconnue.
      ws.send({ t: 'order', id: 3, order: { kind: 'stop', unitIds: ['u999'] } });
      expect(await ws.next('orderResult', (m) => m.id === 3)).toMatchObject({
        ok: false,
        error: 'unknown_unit',
      });
      // Schéma zod invalide (coordonnées hors bornes).
      ws.send({ t: 'order', id: 4, order: { kind: 'move', unitIds: ['fra-1'], to: [500, 45] } });
      expect(await ws.next('orderResult', (m) => m.id === 4)).toMatchObject({ ok: false });
      ws.send({ t: 'nimporte' });
      expect(await ws.next('error', (m) => m.code === 'bad_message')).toBeTruthy();
      ws.ws.send('du texte');
      await ws.nextNew('error', (m) => m.code === 'bad_message');

      ws.send({ t: 'ping', clientTime: 42 });
      const pong = await ws.next('pong');
      expect(pong.clientTime).toBe(42);
      expect(pong.serverTime).toBeGreaterThan(0);

      await sleep(100);
      const orders = await sqlQuery(
        (sql) =>
          sql`SELECT seq, player_slot, payload FROM game_orders WHERE game_id = ${id} ORDER BY seq`,
      );
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        seq: 1,
        player_slot: 0,
        payload: { kind: 'move', to: [3, 45] },
      });
    } finally {
      await ws.close();
    }
  });

  it("n'envoie jamais l'unité cachée (vue, diffs, notifications)", async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    try {
      await ws.next('welcome');
      // L'unité cachée patrouille toutes les secondes de jeu : on laisse passer plusieurs événements.
      ws.send({ t: 'control', speed: 4 });
      await ws.next('clock', (m) => m.clock.speed === 4);
      await sleep(PATROL_PERIOD_MS * 0.8);
      // Un trajet court pour recevoir une notification « arrivée » légitime.
      ws.send({
        t: 'order',
        id: 1,
        order: { kind: 'move', unitIds: ['fra-1'], to: [2.36, 48.86] },
      });
      await ws.next('orderResult', (m) => m.id === 1);
      const note = await ws.next('notify', (m) => m.items.some((n) => n.kind === 'arrived'), 8000);
      expect(note.items.every((n) => !('unitId' in n) || n.unitId !== 'secret')).toBe(true);
      // Tentative d'ordre sur l'unité cachée : même réponse qu'une unité inexistante.
      ws.send({ t: 'order', id: 2, order: { kind: 'stop', unitIds: ['secret'] } });
      expect(await ws.next('orderResult', (m) => m.id === 2)).toMatchObject({
        ok: false,
        error: 'unknown_unit',
      });

      const host = built.ctx.host.games.get(id)!;
      expect(host.state.time).toBeGreaterThan(PATROL_PERIOD_MS * 2);
      const all = Buffer.concat(ws.raw).toString('latin1');
      expect(all).not.toContain('secret');
      expect(all).toContain('scout');
    } finally {
      await ws.close();
    }
  });

  it('contrôle de la vitesse et de la pause (solo) avec diffusion de l’horloge', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    try {
      await ws.next('welcome');
      ws.send({ t: 'control', speed: 3 });
      expect((await ws.next('error', (m) => m.code === 'invalid_speed')).message).toContain(
        '1, 2, 4',
      );
      ws.send({ t: 'control', paused: true });
      const c1 = await ws.next('clock', (m) => m.clock.paused);
      const g = built.ctx.host.games.get(id)!;
      expect(g.meta.status).toBe('paused');
      const t = g.state.time;
      await sleep(300);
      expect(built.ctx.host.games.get(id)!.state.time).toBe(t);
      expect(c1.clock.anchorGame).toBe(t);
      const [row] = await sqlQuery(
        (sql) => sql`SELECT status, pause_reason FROM games WHERE id = ${id}`,
      );
      expect(row).toMatchObject({ status: 'paused', pause_reason: 'player' });
      ws.send({ t: 'control', paused: false, speed: 2 });
      const c2 = await ws.next('clock', (m) => !m.clock.paused);
      expect(c2.clock.speed).toBe(2);
    } finally {
      await ws.close();
    }
  });

  it('isole une exception du moteur : la partie fautive est suspendue, les autres continuent', async () => {
    const p = await guest(built.app);
    const bad = await createGame(built.app, p.cookie);
    const good = await createGame(built.app, p.cookie, { nationId: 'usa' });
    const wsBad = await WsClient.connect(port, bad, p.cookie);
    const wsGood = await WsClient.connect(port, good, p.cookie);
    try {
      await wsBad.next('welcome');
      await wsGood.next('welcome');
      wsBad.send({
        t: 'order',
        id: 1,
        order: { kind: 'stance', unitIds: ['crash'], stance: 'aggressive' },
      });
      expect(await wsBad.next('orderResult', (m) => m.id === 1)).toMatchObject({ ok: false });
      await wsBad.next('error', (m) => m.code === 'game_error');
      expect((await wsBad.next('clock', (m) => m.clock.paused)).clock.paused).toBe(true);
      wsBad.send({ t: 'order', id: 2, order: { kind: 'stop', unitIds: ['fra-1'] } });
      expect(await wsBad.next('orderResult', (m) => m.id === 2)).toMatchObject({
        ok: false,
        error: 'not_allowed',
      });

      wsGood.send({
        t: 'order',
        id: 1,
        order: { kind: 'move', unitIds: ['usa-1'], to: [-70, 40] },
      });
      expect(await wsGood.next('orderResult', (m) => m.id === 1)).toMatchObject({ ok: true });
      await sleep(50);
      const [row] = await sqlQuery(
        (sql) => sql`SELECT status, pause_reason, last_error FROM games WHERE id = ${bad}`,
      );
      expect(row).toMatchObject({ status: 'paused', pause_reason: 'error' });
      expect(String(row!.last_error)).toContain('boum');
      // Le joueur ne peut pas relancer une partie suspendue pour erreur.
      wsBad.send({ t: 'control', paused: false });
      await wsBad.next('error', (m) => m.code === 'not_allowed');
    } finally {
      await wsBad.close();
      await wsGood.close();
    }
  });

  it('limite le débit des messages par connexion', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    try {
      await ws.next('welcome');
      for (let i = 0; i < 80; i++) ws.send({ t: 'ping', clientTime: i });
      await ws.next('error', (m) => m.code === 'rate_limited');
      await sleep(200);
      const pongs = ws.messages.filter((m) => m.t === 'pong').length;
      expect(pongs).toBeLessThan(80);
      expect(pongs).toBeGreaterThanOrEqual(40);
    } finally {
      await ws.close();
    }
  });

  it('diffuse les diffs à tous les onglets du joueur, regroupés', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const a = await WsClient.connect(port, id, p.cookie);
    const b = await WsClient.connect(port, id, p.cookie);
    try {
      await a.next('welcome');
      const wb = await b.next('welcome');
      a.send({ t: 'order', id: 7, order: { kind: 'move', unitIds: ['fra-1'], to: [4, 44] } });
      await a.next('orderResult', (m) => m.id === 7);
      const d = await b.next('diff', (m) => !!m.diff.units?.upsert.some((u) => u.id === 'fra-1'));
      const view: PlayerView = wb.view;
      expect(view.units['fra-1']!.move).toBeUndefined();
      expect(d.diff.units!.upsert.find((u) => u.id === 'fra-1')!.move).toBeDefined();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe.skipIf(!hasDb)('dégradation propre sans moteur ni données', () => {
  it('renvoie 503 sans moteur, et 503 sur la carte sans fichiers', async () => {
    await resetDb();
    const noEngine = await startApp({ dataDir: makeDataDir(), engine: null });
    try {
      const p = await guest(noEngine.app);
      const res = await noEngine.app.inject({
        method: 'POST',
        url: '/api/games',
        headers: { cookie: p.cookie },
        payload: { nationId: 'fra' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('engine_unavailable');
      // Le catalogue (base) et la carte (fichiers) restent servis.
      expect(
        (await noEngine.app.inject({ method: 'GET', url: '/api/catalog' })).json().systems,
      ).toHaveLength(2);
      expect(
        (await noEngine.app.inject({ method: 'GET', url: '/api/map/nations' })).statusCode,
      ).toBe(200);
    } finally {
      await noEngine.app.close();
    }

    const noData = await startApp({
      dataDir: makeDataDir({ map: false, balance: false, catalog: false, tiles: 'none' }),
      instanceId: 'test-b',
    });
    try {
      for (const url of [
        '/api/map/nations',
        '/api/map/provinces',
        '/api/map/provinces.geojson',
        '/api/map/tiles',
      ]) {
        const res = await noData.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(503);
      }
      const p = await guest(noData.app);
      const res = await noData.app.inject({
        method: 'POST',
        url: '/api/games',
        headers: { cookie: p.cookie },
        payload: { nationId: 'fra' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('data_unavailable');
      expect((await noData.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await noData.app.close();
    }
  });
});
