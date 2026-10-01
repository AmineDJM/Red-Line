import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import { pushEndpointAllowed } from '../src/push/push.js';
import {
  WsClient,
  api,
  createGame,
  dbAvailable,
  guest,
  listen,
  login,
  makeDataDir,
  register,
  resetDb,
  sqlQuery,
  startApp,
  until,
} from './helpers.js';
import { fakeState } from './fake-engine.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

describe.skipIf(!hasDb)('exploitation : IA imposée, nations, sécurité, quotas, inactivité', () => {
  let built: BuiltApp;
  let port: number;
  let admin: string;
  const dataDir = makeDataDir({ dists: true });

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir,
      env: ADMIN,
      runtime: {
        maxActiveSoloPerUser: 2,
        dormancyDelayMs: 60_000,
        multiAbandonMs: 3_600_000,
        soloAbandonMs: 7_200_000,
        idleUnloadMs: 120_000,
      },
    });
    port = await listen(built.app);
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('IA imposée par l’administration puis nation rendue au joueur', async () => {
    const A = await register(built.app, 'a@redline.test', 'Alice');
    const B = await register(built.app, 'b@redline.test', 'Bob');
    const created = await api(built.app, A.cookie)('POST', '/api/lobby', {
      name: 'Partie IA',
      nationId: 'fra',
      maxPlayers: 2,
      speed: 1000,
    });
    const gameId = created.json().game.id as string;
    const joined = await api(built.app, B.cookie)('POST', `/api/lobby/${gameId}/join`, {
      nationId: 'dza',
    });
    expect(joined.json().game.status).toBe('running');
    const wsA = await WsClient.connect(port, gameId, A.cookie);
    const wsB = await WsClient.connect(port, gameId, B.cookie);
    await wsA.next('welcome');
    await wsB.next('welcome');
    const url = `/admin/api/games/${gameId}/players/dza/ai`;

    // Droits : un joueur ne peut pas ; nation sans joueur humain : 404.
    expect((await api(built.app, A.cookie)('POST', url, { ai: true })).statusCode).toBe(403);
    const none = await api(built.app, admin)('POST', `/admin/api/games/${gameId}/players/usa/ai`, {
      ai: true,
    });
    expect(none.statusCode).toBe(404);

    const r = await api(built.app, admin)('POST', url, { ai: true, aiLevel: 'hard' });
    expect(r.statusCode).toBe(200);
    expect(r.json().player).toMatchObject({ nationId: 'dza', isAi: true, aiForced: true });
    const g = built.ctx.host.games.get(gameId)!;
    expect(fakeState(g.state).ai.dza).toBe(true);
    expect((await wsA.next('notice', (m) => m.text.includes('confiée'))).text).toContain('Algérie');

    // Le joueur ne reprend pas la main en revenant, ses ordres sont refusés.
    await wsB.close();
    const wsB2 = await WsClient.connect(port, gameId, B.cookie);
    await wsB2.next('welcome');
    expect(fakeState(g.state).ai.dza).toBe(true);
    wsB2.send({ t: 'order', id: 7, order: { kind: 'stance', unitIds: ['dza-1'], stance: 'hold' } });
    const refused = await wsB2.next('orderResult', (m) => m.id === 7);
    expect(refused).toMatchObject({ ok: false, error: 'not_allowed' });
    // Le remplacement automatique pour inactivité ne s'applique pas deux fois.
    expect(await built.ctx.host.checkInactive(Date.now() + 1000 * 3600_000)).toBe(0); // A connecté

    const list = (await api(built.app, admin)('GET', '/admin/api/games')).json().games;
    const row = list.find((x: { game: { id: string } }) => x.game.id === gameId);
    expect(row.players.find((p: { nationId: string }) => p.nationId === 'dza')).toMatchObject({
      isAi: true,
      aiForced: true,
      userName: 'Bob',
      connected: true,
    });

    // Restitution.
    const back = await api(built.app, admin)('POST', url, { ai: false });
    expect(back.json().player).toMatchObject({ isAi: false, aiForced: false });
    expect(fakeState(g.state).ai.dza).toBe(false);
    wsB2.send({ t: 'order', id: 8, order: { kind: 'stance', unitIds: ['dza-1'], stance: 'hold' } });
    expect((await wsB2.next('orderResult', (m) => m.id === 8)).error).not.toBe('not_allowed');
    await built.ctx.host.settle(gameId);
    const [p] = await sqlQuery(
      (sql) =>
        sql`SELECT ai_forced, is_ai_replacement FROM game_players WHERE game_id = ${gameId} AND nation_id = 'dza'`,
    );
    expect(p).toMatchObject({ ai_forced: false, is_ai_replacement: false });
    const audit = await sqlQuery(
      (sql) => sql`SELECT action FROM admin_audit WHERE target = ${`game:${gameId}`} ORDER BY id`,
    );
    expect(audit.map((a) => a.action)).toEqual(['game.player_ai', 'game.player_restore']);
    await wsA.close();
    await wsB2.close();
  });

  it('nation : retour à la valeur du dépôt', async () => {
    const req = api(built.app, admin);
    const cur = (await req('GET', '/admin/api/map/nations/fra')).json().data;
    const saved = await req('PUT', '/admin/api/map/nations/fra', {
      data: { ...cur, name: 'République française' },
    });
    expect(saved.statusCode).toBe(200);
    expect((await req('GET', '/api/map/nations')).json().nations[0].name).toBe(
      'République française',
    );
    const reset = await req('POST', '/admin/api/map/nations/fra/reset', {});
    expect(reset.statusCode).toBe(200);
    expect((await req('GET', '/admin/api/map/nations/fra')).json().data.name).toBe('France');
    expect((await req('POST', '/admin/api/map/nations/zzz/reset', {})).statusCode).toBe(404);
  });

  it('en-têtes de sécurité, CSP compatible MapLibre, CSRF', async () => {
    const page = await built.app.inject({ method: 'GET', url: '/', headers: { host: 'rl.test' } });
    expect(page.statusCode).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('worker-src ');
    expect(csp).toContain('blob:');
    expect(csp).toContain('wss://rl.test');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    const adminPage = await built.app.inject({ method: 'GET', url: '/admin/' });
    expect(adminPage.headers['content-security-policy']).toBeDefined();
    const apiRes = await built.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(apiRes.headers['cache-control']).toBe('no-store');
    expect(apiRes.headers['content-security-policy']).toBeUndefined();

    // Écriture inter-sites refusée ; même origine acceptée.
    const u = await guest(built.app);
    const evil = await built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: u.cookie, origin: 'https://evil.example', host: 'rl.test' },
    });
    expect(evil.statusCode).toBe(403);
    const site = await built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: u.cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(site.statusCode).toBe(403);
    const ok = await built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: u.cookie, origin: 'https://rl.test', host: 'rl.test' },
    });
    expect(ok.statusCode).toBe(200);
    // Adresse mal encodée : 400, pas 500.
    expect((await built.app.inject({ method: 'GET', url: '/%E0%A4%A' })).statusCode).toBe(400);
  });

  it('notifications push : seuls les services des navigateurs sont acceptés (SSRF)', async () => {
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(pushEndpointAllowed('https://web.push.apple.com/x')).toBe(true);
    expect(pushEndpointAllowed('http://fcm.googleapis.com/x')).toBe(false);
    expect(pushEndpointAllowed('https://169.254.169.254/latest')).toBe(false);
    expect(pushEndpointAllowed('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    const u = await guest(built.app);
    const r = await api(built.app, u.cookie)('POST', '/api/push/subscribe', {
      endpoint: 'https://127.0.0.1:5432/x',
      keys: { p256dh: 'x'.repeat(20), auth: 'abcdef' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('quota de parties solo par joueur', async () => {
    const u = await guest(built.app);
    await createGame(built.app, u.cookie);
    await createGame(built.app, u.cookie);
    const third = await api(built.app, u.cookie)('POST', '/api/games', { nationId: 'fra' });
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('too_many_games');
  });

  it('partie solo sans joueur : elle continue (IA lointaines en veille), fin pour abandon', async () => {
    const host = built.ctx.host;
    const u = await guest(built.app);
    const id = await createGame(built.app, u.cookie, { nationId: 'fra', speed: 1000 });
    const ws = await WsClient.connect(port, id, u.cookie);
    await ws.next('welcome');
    await ws.close();
    await until(() => host.games.get(id)?.idleSince !== null, 'départ du joueur');
    const g = host.games.get(id)!;
    const t0 = Date.now();
    await host.manageIdle(t0 + 30_000);
    expect(g.dormant).toBe(false);
    await host.manageIdle(t0 + 61_000);
    expect(g.dormant).toBe(true);
    expect(fakeState(g.state).sys.at(-1)).toEqual({ kind: 'dormancy', on: true });
    // Avant le délai d'abandon (ici 2 h, 48 h en production) : la partie continue la nuit.
    await host.manageIdle(t0 + 7_199_000);
    expect(host.games.get(id)).toBe(g);
    expect(g.meta.status).toBe('running');

    // Retour du joueur : réveil des IA.
    const back = await WsClient.connect(port, id, u.cookie);
    expect((await back.next('welcome')).clock.paused).toBe(false);
    expect(g.dormant).toBe(false);
    expect(fakeState(g.state).sys.at(-1)).toEqual({ kind: 'dormancy', on: false });
    await back.close();

    // Nouvelle absence au-delà du délai : fin de partie pour abandon et fermeture.
    await until(() => g.idleSince !== null, 'nouveau départ');
    await host.manageIdle(Date.now() + 7_201_000);
    expect(host.games.has(id)).toBe(false);
    const [row] = await sqlQuery(
      (sql) => sql`SELECT status, pause_reason, lease_owner FROM games WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ status: 'ended', pause_reason: 'abandoned', lease_owner: null });
    const meta = await api(built.app, u.cookie)('GET', `/api/games/${id}`);
    expect(meta.json().game).toMatchObject({ status: 'ended', endReason: 'abandoned' });
  });

  it('multijoueur sans aucun joueur connecté pendant 24 h : fin pour abandon', async () => {
    const host = built.ctx.host;
    const u = await guest(built.app);
    const id = await createGame(built.app, u.cookie, { nationId: 'fra', speed: 1000 });
    const ws = await WsClient.connect(port, id, u.cookie);
    await ws.next('welcome');
    await ws.close();
    await until(() => host.games.get(id)?.idleSince !== null, 'départ du joueur');
    const g = host.games.get(id)!;
    (g.meta as { mode: string }).mode = 'multi'; // seul le mode compte ici
    const t0 = Date.now();
    await host.manageIdle(t0 + 3_599_000);
    expect(g.meta.status).toBe('running');
    await host.manageIdle(t0 + 3_601_000);
    expect(host.games.has(id)).toBe(false);
    const [row] = await sqlQuery(
      (sql) => sql`SELECT status, pause_reason FROM games WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ status: 'ended', pause_reason: 'abandoned' });
  });

  it('partie mise en pause puis déchargée : terminée en base après le délai', async () => {
    const host = built.ctx.host;
    const u = await guest(built.app);
    const id = await createGame(built.app, u.cookie, { nationId: 'fra', speed: 1000 });
    const ws = await WsClient.connect(port, id, u.cookie);
    await ws.next('welcome');
    ws.send({ t: 'control', paused: true });
    await ws.next('clock', (m) => m.clock.paused);
    await ws.close();
    await until(() => host.games.get(id)?.idleSince !== null, 'départ du joueur');
    await host.manageIdle(Date.now() + 121_000);
    expect(host.games.has(id)).toBe(false);
    expect(await host.abandonUnloaded(Date.now() + 3_600_000)).toBe(0);
    expect(await host.abandonUnloaded(Date.now() + 7_300_000)).toBe(1);
    const [row] = await sqlQuery(
      (sql) => sql`SELECT status, pause_reason FROM games WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ status: 'ended', pause_reason: 'abandoned' });
  });

  it('suppression d’une partie solo par son joueur (et quota libéré)', async () => {
    const u = await guest(built.app);
    const other = await guest(built.app);
    const id = await createGame(built.app, u.cookie, { nationId: 'fra', speed: 1000 });
    const ws = await WsClient.connect(port, id, u.cookie);
    await ws.next('welcome');
    expect((await api(built.app, other.cookie)('DELETE', `/api/games/${id}`)).statusCode).toBe(403);
    const r = await api(built.app, u.cookie)('DELETE', `/api/games/${id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await ws.next('error')).code).toBe('game_deleted');
    expect(built.ctx.host.games.has(id)).toBe(false);
    const rows = await sqlQuery((sql) => sql`SELECT id FROM games WHERE id = ${id}`);
    expect(rows).toHaveLength(0);
    expect((await api(built.app, u.cookie)('DELETE', `/api/games/${id}`)).statusCode).toBe(404);
    await ws.close().catch(() => {});
  });
});
