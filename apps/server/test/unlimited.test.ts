import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Order } from '@redline/shared';
import type { BuiltApp } from '../src/app.js';
import { loadRealEngine } from '../src/engine.js';
import { REPO_ROOT } from '../src/paths.js';
import {
  WsClient,
  api,
  dbAvailable,
  guest,
  listen,
  login,
  register,
  resetDb,
  sqlQuery,
  startApp,
} from './helpers.js';

const hasDb = await dbAvailable();
const { engine } = loadRealEngine();

const ADMIN = 'amine@example.com';
const ADMIN_PW = 'motdepasse-admin';
/** 20 destroyers importés (~57 Md$) : bien au-delà de la trésorerie de départ de la France (~5,6 Md$). */
const EXPENSIVE: Order = {
  kind: 'produce',
  provinceId: 'fra-1',
  systemId: 'us.arleigh-burke',
  count: 20,
};

/** Mode illimité de bout en bout avec le VRAI moteur et les vraies données du dépôt. */
describe.skipIf(!hasDb || !engine)('mode illimité (compte administrateur)', () => {
  let built: BuiltApp;
  let port: number;
  let adminCookie = '';
  let soloId = '';

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir: join(REPO_ROOT, 'data'),
      engine,
      env: { ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: ADMIN_PW },
      runtime: { maxActiveSoloPerUser: 1 },
    });
    port = await listen(built.app);
    adminCookie = await login(built.app, ADMIN, ADMIN_PW);
  }, 180_000);
  afterAll(async () => {
    await built?.app.close();
  });

  const unlimitedOf = (gameId: string) =>
    engine!.unlimitedNations!(built.ctx.host.games.get(gameId)!.state);

  it(
    'ADMIN_EMAIL illimité d’office : production très chère acceptée, aucun quota, premium illimité',
    { timeout: 180_000 },
    async () => {
      const me = (await api(built.app, adminCookie)('GET', '/api/me')).json();
      expect(me.user.unlimited).toBe(true);
      expect(me.premiumUnlimited).toBe(true);

      // Quota de 1 partie solo : levé pour le compte illimité, appliqué aux autres.
      const g1 = await api(built.app, adminCookie)('POST', '/api/games', { nationId: 'fra' });
      expect(g1.statusCode).toBe(201);
      soloId = g1.json().game.id;
      const g2 = await api(built.app, adminCookie)('POST', '/api/games', { nationId: 'dza' });
      expect(g2.statusCode).toBe(201);
      const P = await guest(built.app);
      const p1 = await api(built.app, P.cookie)('POST', '/api/games', { nationId: 'fra' });
      expect(p1.statusCode).toBe(201);
      const p2 = await api(built.app, P.cookie)('POST', '/api/games', { nationId: 'dza' });
      expect(p2.statusCode).toBe(429);

      expect(unlimitedOf(soloId)).toEqual(['fra']);
      expect(unlimitedOf(p1.json().game.id)).toEqual([]);
      // Commande système journalisée (rejouée à la reprise).
      await built.ctx.host.settle(soloId);
      const sys = await sqlQuery(
        (sql) =>
          sql`SELECT payload FROM game_orders WHERE game_id = ${soloId} AND player_slot = -1`,
      );
      expect(sys.map((r) => r.payload)).toEqual([
        { sys: { kind: 'unlimited', nationId: 'fra', on: true } },
      ]);

      const ws = await WsClient.connect(port, soloId, adminCookie);
      const w = await ws.next('welcome', () => true, 60_000);
      expect(w.view.economy.unlimited).toBe(true);
      expect(w.view.economy.money).toBe(1e15);
      expect(w.view.nations.fra!.unlimited).toBe(true);
      ws.send({ t: 'order', id: 1, order: EXPENSIVE });
      const r = await ws.next('orderResult', (m) => m.id === 1, 30_000);
      expect(r).toMatchObject({ ok: true });
      // Solo : aucun avis public.
      expect(ws.messages.some((m) => m.t === 'notice')).toBe(false);
      await ws.close();

      // Joueur ordinaire : la même commande est refusée faute de fonds.
      const wsP = await WsClient.connect(port, p1.json().game.id, P.cookie);
      await wsP.next('welcome', () => true, 60_000);
      wsP.send({ t: 'order', id: 1, order: EXPENSIVE });
      const rP = await wsP.next('orderResult', (m) => m.id === 1, 30_000);
      expect(rP).toMatchObject({ ok: false, error: 'insufficient_funds' });
      await wsP.close();

      // Monnaie premium : solde illimité, accélération sans débit.
      const wallet = (await api(built.app, adminCookie)('GET', '/api/shop/wallet')).json();
      expect(wallet.unlimited).toBe(true);
      const g = built.ctx.host.games.get(soloId)!;
      const prodId = engine!.viewFor(g.state, 'fra').economy.production[0]!.id;
      const acc = await api(built.app, adminCookie)('POST', `/api/games/${soloId}/accelerate`, {
        target: { type: 'production', id: prodId },
        hours: 24,
      });
      expect(acc.statusCode).toBe(200);
      expect(acc.json()).toMatchObject({ ok: true, balance: 0, cost: 0, unlimited: true });
      const accP = await api(built.app, P.cookie)(
        'POST',
        `/api/games/${p1.json().game.id}/accelerate`,
        { target: { type: 'production', id: 'x' }, hours: 24 },
      );
      expect(accP.statusCode).toBe(402);
    },
  );

  it(
    'multijoueur : partie non classée, avis public et salon ; aucun point',
    { timeout: 180_000 },
    async () => {
      const created = await api(built.app, adminCookie)('POST', '/api/lobby', {
        name: 'Essai illimité',
        nationId: 'fra',
        maxPlayers: 2,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().game.id;
      const lobby = (await api(built.app, adminCookie)('GET', '/api/lobby')).json();
      const entry = lobby.games.find((x: { game: { id: string } }) => x.game.id === id);
      expect(entry.unlimitedNations).toEqual(['fra']);
      expect(entry.game.unranked).toBe(true);

      const B = await guest(built.app);
      const joined = await api(built.app, B.cookie)('POST', `/api/lobby/${id}/join`, {
        nationId: 'dza',
      });
      expect(joined.json().game.status).toBe('running');
      expect(joined.json().game.unranked).toBe(true);
      expect(unlimitedOf(id)).toEqual(['fra']);
      const [row] = await sqlQuery((sql) => sql`SELECT unranked FROM games WHERE id = ${id}`);
      expect(row!.unranked).toBe(true);

      const ws = await WsClient.connect(port, id, B.cookie);
      const w = await ws.next('welcome', () => true, 60_000);
      expect(w.view.nations.fra!.unlimited).toBe(true);
      expect(w.view.economy.unlimited).toBeUndefined();
      const n = await ws.next('notice', () => true, 10_000);
      expect(n.text).toBe('Mode illimité actif pour France — partie non classée.');
      await ws.close();

      // Fin de partie : résultats enregistrés, aucun point de saison.
      await built.ctx.rankings.onGameEnded(built.ctx.host.games.get(id)!, null);
      const results = await sqlQuery(
        (sql) => sql`SELECT points, season_id FROM game_results WHERE game_id = ${id}`,
      );
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.points === 0 && r.season_id === null)).toBe(true);
      const ranks = await sqlQuery((sql) => sql`SELECT count(*)::int AS n FROM rankings`);
      expect(ranks[0]!.n).toBe(0);
    },
  );

  it(
    'back-office : seul un superadmin bascule le mode illimité (journal d’audit, effet immédiat)',
    { timeout: 180_000 },
    async () => {
      const M = await register(built.app, 'modo@example.com');
      const asAdmin = api(built.app, adminCookie);
      expect(
        (await asAdmin('PUT', `/admin/api/users/${M.userId}`, { role: 'moderator' })).statusCode,
      ).toBe(200);
      // Un modérateur ne peut pas toucher au mode illimité (routes Utilisateurs : superadmin).
      const denied = await api(built.app, M.cookie)('PUT', `/admin/api/users/${M.userId}`, {
        unlimited: true,
      });
      expect(denied.statusCode).toBe(403);

      const P = await register(built.app, 'joueur@example.com');
      const created = await api(built.app, P.cookie)('POST', '/api/games', { nationId: 'usa' });
      const gid = created.json().game.id;
      expect(unlimitedOf(gid)).toEqual([]);
      const on = await asAdmin('PUT', `/admin/api/users/${P.userId}`, { unlimited: true });
      expect(on.statusCode).toBe(200);
      expect(on.json().user.unlimited).toBe(true);
      expect(unlimitedOf(gid)).toEqual(['usa']);
      expect((await api(built.app, P.cookie)('GET', '/api/me')).json().user.unlimited).toBe(true);

      const off = await asAdmin('PUT', `/admin/api/users/${P.userId}`, { unlimited: false });
      expect(off.json().user.unlimited).toBe(false);
      expect(unlimitedOf(gid)).toEqual([]);
      const audit = await sqlQuery(
        (sql) =>
          sql`SELECT action, before->>'unlimited' AS b, after->>'unlimited' AS a FROM admin_audit
              WHERE target = ${`user:${P.userId}`} ORDER BY id`,
      );
      expect(audit).toEqual([
        { action: 'user.unlimited', b: 'false', a: 'true' },
        { action: 'user.unlimited', b: 'true', a: 'false' },
      ]);
      // Désactivation pour le compte administrateur lui-même : effet dans ses parties chargées.
      const admin = (await asAdmin('GET', '/api/me')).json().user;
      await asAdmin('PUT', `/admin/api/users/${admin.id}`, { unlimited: false });
      expect(unlimitedOf(soloId)).toEqual([]);
      await asAdmin('PUT', `/admin/api/users/${admin.id}`, { unlimited: true });
      expect(unlimitedOf(soloId)).toEqual(['fra']);
    },
  );

  it(
    'reprise : instantané + rejeu du journal rétablissent le mode illimité',
    {
      timeout: 240_000,
    },
    async () => {
      const host = built.ctx.host;
      await Promise.all([...host.games.values()].map((x) => x.writes));
      await host.stop({ snapshot: false, release: true });
      await built.app.close();
      built = await startApp({
        dataDir: join(REPO_ROOT, 'data'),
        engine,
        env: { ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: ADMIN_PW },
      });
      const r = await built.ctx.host.ensureLoaded(soloId);
      expect(r).not.toBeNull();
      expect(unlimitedOf(soloId)).toEqual(['fra']);
      // Aucune nouvelle commande : le rejeu suffit (activation, accélération, retrait, réactivation).
      const sys = await sqlQuery(
        (sql) =>
          sql`SELECT count(*)::int AS n FROM game_orders WHERE game_id = ${soloId} AND player_slot = -1`,
      );
      expect(sys[0]!.n).toBe(4);
    },
  );
});
