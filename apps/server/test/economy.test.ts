/**
 * Économie du service et gestion complète (back-office) : comptabilité de la consommation, agrégats,
 * attribution des coûts, RBAC, paramètres, annonces, actions sur les comptes et les parties.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
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

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

describe.skipIf(!hasDb)('économie du service et gestion (back-office)', () => {
  let built: BuiltApp;
  let port: number;
  let admin: string;
  let adminId: string;
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    await sqlQuery(
      (sql) => sql`TRUNCATE usage_stats, cost_entries, announcements RESTART IDENTITY`,
    );
    built = await startApp({ dataDir, env: ADMIN });
    port = await listen(built.app);
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
    adminId = (await api(built.app, admin)('GET', '/api/me')).json().user.id;
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('RBAC : coûts, annonces et actions sensibles réservés au superadmin', async () => {
    const player = await register(built.app, 'joueur-rbac@redline.test');
    const mod = await register(built.app, 'modo-rbac@redline.test');
    expect(
      (await api(built.app, admin)('PUT', `/admin/api/users/${mod.userId}`, { role: 'moderator' }))
        .statusCode,
    ).toBe(200);
    for (const [cookie, code] of [
      [null, 401],
      [player.cookie, 403],
      [mod.cookie, 403],
    ] as const) {
      const req = api(built.app, cookie);
      expect((await req('GET', '/admin/api/costs/dashboard')).statusCode).toBe(code);
      expect((await req('PUT', '/admin/api/costs/settings', {})).statusCode).toBe(code);
      expect((await req('POST', '/admin/api/announcements', {})).statusCode).toBe(code);
      expect((await req('POST', `/admin/api/users/${player.userId}/wallet`, {})).statusCode).toBe(
        code,
      );
      expect((await req('DELETE', `/admin/api/users/${player.userId}`, {})).statusCode).toBe(code);
      expect((await req('PUT', '/admin/api/server/settings', {})).statusCode).toBe(code);
    }
    // Le modérateur lit les paramètres d'exploitation et les archives, sans les modifier.
    expect((await api(built.app, mod.cookie)('GET', '/admin/api/server/settings')).statusCode).toBe(
      200,
    );
    expect((await api(built.app, mod.cookie)('GET', '/admin/api/games/archive')).statusCode).toBe(
      200,
    );
    expect((await api(built.app, admin)('GET', '/admin/api/costs/dashboard')).statusCode).toBe(200);
  });

  it('comptabilité : CPU, mémoire, octets, temps de jeu et ordres par partie et par joueur', async () => {
    const { usage } = built.ctx;
    await usage.flush();
    await sqlQuery((sql) => sql`TRUNCATE usage_stats`);
    const p = await register(built.app, 'mesure@redline.test', 'Mesuré');
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    ws.send({ t: 'order', id: 1, order: { kind: 'move', unitIds: ['fra-1'], to: [3, 45] } });
    await ws.next('orderResult');
    await new Promise((r) => setTimeout(r, 50));
    usage.sample();
    const pending = usage.pending();
    const g = pending.games.get(id)!;
    expect(g.cpuOtherMs).toBeGreaterThan(0); // création + instantané
    expect(g.orders).toBe(1);
    expect(g.memMbH).toBeGreaterThan(0);
    expect(pending.users.get(p.userId)!.wsBytes).toBeGreaterThan(0);
    expect(pending.users.get(p.userId)!.playS).toBeGreaterThanOrEqual(0);
    await ws.close();
    await usage.flush();
    const rows = await sqlQuery(
      (sql) =>
        sql`SELECT grain, scope, key, cpu_other_ms, ws_bytes, orders, mem_mb_h FROM usage_stats ORDER BY grain, scope`,
    );
    const grains = new Set(rows.map((r) => r.grain));
    expect(grains).toEqual(new Set(['hour', 'day']));
    const gameRow = rows.find((r) => r.scope === 'game' && r.key === id && r.grain === 'hour')!;
    expect(gameRow.orders).toBe(1);
    expect(Number(gameRow.cpu_other_ms)).toBeGreaterThan(0);
    const userRow = rows.find(
      (r) => r.scope === 'user' && r.key === p.userId && r.grain === 'day',
    )!;
    expect(Number(userRow.ws_bytes)).toBeGreaterThan(0);
    // Second versement : les compteurs s'ajoutent (upsert), sans doublon.
    usage.order(id, p.userId);
    await usage.flush();
    const [again] = await sqlQuery(
      (sql) =>
        sql`SELECT orders, count(*) OVER () AS n FROM usage_stats WHERE grain = 'hour' AND scope = 'game' AND key = ${id}`,
    );
    expect(again!.orders).toBe(2);
    expect(Number(again!.n)).toBe(1);

    // Rapport : le coût de la partie revient à son joueur (gratuit), la base au prorata du stockage.
    built.ctx.costs.invalidate();
    const r = await api(built.app, admin)('GET', '/admin/api/costs/report?period=24h&full=1');
    expect(r.statusCode).toBe(200);
    const report = r.json().report;
    const game = report.games.find((x: { id: string }) => x.id === id);
    expect(game.cost.compute).toBeGreaterThan(0);
    expect(game.storageBytes).toBeGreaterThan(0);
    const user = report.users.find((x: { id: string }) => x.id === p.userId);
    expect(user.kind).toBe('free');
    expect(user.cost.total).toBeGreaterThan(0);
    expect(report.cohorts.free.users).toBeGreaterThanOrEqual(1);
    expect(report.cost.total).toBeCloseTo(
      report.cost.compute +
        report.cost.database +
        report.cost.bandwidth +
        report.cost.stripe +
        report.cost.push +
        report.cost.other,
      9,
    );
    const one = await api(built.app, admin)('GET', `/admin/api/costs/users/${p.userId}?period=24h`);
    expect(one.json().cost.id).toBe(p.userId);
    const dash = await api(built.app, admin)('GET', '/admin/api/costs/dashboard?period=24h');
    expect(dash.statusCode).toBe(200);
    expect(dash.json().series.length).toBeGreaterThan(0);
    expect(dash.json().report.users).toBeUndefined();
    expect(dash.json().live.games).toBeGreaterThanOrEqual(1);
  });

  it('rétention : purge des agrégats horaires et journaliers anciens', async () => {
    await sqlQuery(
      (sql) => sql`INSERT INTO usage_stats (grain, period_start, scope, key, orders) VALUES
        ('hour', now() - interval '30 days', 'server', 'all', 1),
        ('day', now() - interval '500 days', 'server', 'all', 1),
        ('day', now() - interval '20 days', 'server', 'all', 1)`,
    );
    const n = await built.ctx.usage.purge();
    expect(n).toBe(2);
    const [left] = await sqlQuery(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM usage_stats WHERE period_start < now() - interval '10 days'`,
    );
    expect(left!.n).toBe(1);
  });

  it('paramètres de coût : validation, audit, dépenses saisies dans le rapport', async () => {
    const req = api(built.app, admin);
    const cur = (await req('GET', '/admin/api/costs/settings')).json().settings;
    expect(cur.compute.plan).toBe('starter');
    const bad = await req('PUT', '/admin/api/costs/settings', {
      ...cur,
      compute: { ...cur.compute, plan: 'inconnue' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await req('PUT', '/admin/api/costs/settings', {
      ...cur,
      compute: { ...cur.compute, plan: 'standard' },
    });
    expect(ok.statusCode).toBe(200);
    expect(built.ctx.costs.settings().compute.plan).toBe('standard');
    const today = new Date().toISOString().slice(0, 10);
    const e = await req('POST', '/admin/api/costs/entries', {
      day: today,
      category: 'video_api',
      label: 'Génération vidéo (essai)',
      amountUsd: 12.5,
    });
    expect(e.statusCode).toBe(201);
    await built.ctx.costs.recordExternal({
      category: 'video_api',
      label: 'API mesurée',
      amountUsd: 0.5,
    });
    const rep = (await req('GET', '/admin/api/costs/report?period=24h')).json().report;
    expect(rep.cost.other).toBeGreaterThanOrEqual(13);
    expect(rep.plan.id).toBe('standard');
    const list = (await req('GET', '/admin/api/costs/entries')).json().entries;
    expect(list.map((x: { source: string }) => x.source).sort()).toEqual(['manual', 'measured']);
    expect((await req('DELETE', `/admin/api/costs/entries/${e.json().entry.id}`)).statusCode).toBe(
      200,
    );
    const audits = await sqlQuery(
      (sql) => sql`SELECT action FROM admin_audit WHERE action LIKE 'costs.%' ORDER BY id`,
    );
    expect(audits.map((a) => a.action)).toEqual([
      'costs.settings',
      'costs.entry.create',
      'costs.entry.delete',
    ]);
  });

  it('comptes : suspension temporaire, sessions, mot de passe provisoire, portefeuille', async () => {
    const req = api(built.app, admin);
    const u = await register(built.app, 'sanction@redline.test', 'Sanctionné');
    expect(
      (await req('POST', `/admin/api/users/${adminId}/suspend`, { hours: 1 })).statusCode,
    ).toBe(400);
    const s = await req('POST', `/admin/api/users/${u.userId}/suspend`, {
      hours: 2,
      reason: 'spam',
    });
    expect(s.statusCode).toBe(200);
    expect((await api(built.app, u.cookie)('GET', '/api/me')).statusCode).toBe(401);
    const denied = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'sanction@redline.test', password: 'motdepasse-test' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toMatch(/suspendu jusqu/);
    // Fin de la suspension : connexion de nouveau possible.
    await sqlQuery(
      (sql) =>
        sql`UPDATE users SET banned_until = now() - interval '1 minute' WHERE id = ${u.userId}`,
    );
    const back = await login(built.app, 'sanction@redline.test', 'motdepasse-test');
    expect((await api(built.app, back)('GET', '/api/me')).statusCode).toBe(200);

    const reset = await req('POST', `/admin/api/users/${u.userId}/password-reset`);
    expect(reset.statusCode).toBe(200);
    const pw = reset.json().password as string;
    expect(pw.length).toBeGreaterThanOrEqual(10);
    expect((await api(built.app, back)('GET', '/api/me')).statusCode).toBe(401);
    const fresh = await login(built.app, 'sanction@redline.test', pw);
    const [audit] = await sqlQuery(
      (sql) =>
        sql`SELECT before, after FROM admin_audit WHERE action = 'user.password_reset' ORDER BY id DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit)).not.toContain(pw);

    const credit = await req('POST', `/admin/api/users/${u.userId}/wallet`, {
      delta: 500,
      note: 'Geste commercial',
    });
    expect(credit.json().balance).toBe(500);
    const over = await req('POST', `/admin/api/users/${u.userId}/wallet`, {
      delta: -600,
      note: 'Correction',
    });
    expect(over.statusCode).toBe(402);
    const ov = (await req('GET', `/admin/api/users/${u.userId}/overview`)).json();
    expect(ov.wallet).toMatchObject({ balance: 500, admin: 500 });
    expect(ov.sessions.length).toBe(1);
    expect(ov.kind).toBe('free');

    const rev = await req('POST', `/admin/api/users/${u.userId}/sessions/revoke`);
    expect(rev.json().revoked).toBe(1);
    expect((await api(built.app, fresh)('GET', '/api/me')).statusCode).toBe(401);

    const filtered = (await req('GET', '/admin/api/users?filter=banned')).json().users;
    expect(filtered.some((x: { id: string }) => x.id === u.userId)).toBe(true);
    const byId = (await req('GET', `/admin/api/users?q=${u.userId}`)).json().users;
    expect(byId.map((x: { id: string }) => x.id)).toEqual([u.userId]);
  });

  it('RGPD : export complet puis suppression (anonymisation, achats conservés)', async () => {
    const req = api(built.app, admin);
    const u = await register(built.app, 'rgpd@redline.test', 'Effacé');
    const gameId = await createGame(built.app, u.cookie);
    await built.ctx.host.settle(gameId);
    await sqlQuery(
      (
        sql,
      ) => sql`INSERT INTO purchases (user_id, pack_id, credits, price_cents, currency, status, paid_at)
        VALUES (${u.userId}, 'p1', 100, 499, 'eur', 'paid', now())`,
    );
    await req('POST', `/admin/api/users/${u.userId}/wallet`, { delta: 10, note: 'test' });
    // Ligne du portefeuille rattachée à la partie : la suppression de la partie doit passer (déclencheur).
    await sqlQuery(
      (sql) => sql`INSERT INTO wallet_ledger (user_id, delta, reason, ref, game_id, balance_after)
        VALUES (${u.userId}, 0, 'accelerate', 'x', ${gameId}, 10)`,
    );
    const exp = await req('GET', `/admin/api/users/${u.userId}/export`);
    expect(exp.statusCode).toBe(200);
    const data = exp.json();
    expect(data.account.email).toBe('rgpd@redline.test');
    expect(data.account.passwordHash).toBeUndefined();
    expect(data.purchases).toHaveLength(1);
    expect(data.games).toHaveLength(1);

    expect(
      (await req('DELETE', `/admin/api/users/${u.userId}`, { confirm: 'mauvais' })).statusCode,
    ).toBe(400);
    expect((await req('DELETE', `/admin/api/users/${adminId}`, { confirm: 'x' })).statusCode).toBe(
      400,
    );
    const del = await req('DELETE', `/admin/api/users/${u.userId}`, { confirm: 'Effacé' });
    expect(del.statusCode).toBe(200);
    expect(del.json().deletedGames).toBe(1);
    const [row] = await sqlQuery(
      (sql) =>
        sql`SELECT email, password_hash, display_name, deleted_at, banned_at FROM users WHERE id = ${u.userId}`,
    );
    expect(row).toMatchObject({ email: null, password_hash: null });
    expect(row!.display_name).toMatch(/^Compte supprimé/);
    expect(row!.deleted_at).not.toBeNull();
    const [kept] = await sqlQuery(
      (sql) =>
        sql`SELECT (SELECT count(*)::int FROM purchases WHERE user_id = ${u.userId}) AS buys,
          (SELECT count(*)::int FROM wallet_ledger WHERE user_id = ${u.userId}) AS ledger,
          (SELECT count(*)::int FROM games WHERE id = ${gameId}) AS games,
          (SELECT count(*)::int FROM wallet_ledger WHERE game_id IS NULL AND user_id = ${u.userId}) AS detached`,
    );
    expect(kept).toEqual({ buys: 1, ledger: 2, games: 0, detached: 2 });
    const [a] = await sqlQuery(
      (sql) =>
        sql`SELECT before, after FROM admin_audit WHERE action = 'user.delete' ORDER BY id DESC LIMIT 1`,
    );
    expect(JSON.stringify(a)).not.toContain('rgpd@redline.test');
    // Le journal du portefeuille reste en ajout seul.
    await expect(
      sqlQuery((sql) => sql`UPDATE wallet_ledger SET delta = 999 WHERE user_id = ${u.userId}`),
    ).rejects.toThrow(/ajout seul/);
  });

  it('parties : fin imposée (non classée, avis), archives, suppression confirmée', async () => {
    const req = api(built.app, admin);
    const p = await register(built.app, 'partie-fin@redline.test');
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    const end = await req('POST', `/admin/api/games/${id}/end`, { message: 'Maintenance' });
    expect(end.statusCode).toBe(200);
    await ws.next('notice', (n) => n.text === 'Maintenance');
    const [row] = await sqlQuery(
      (sql) => sql`SELECT status, pause_reason, unranked FROM games WHERE id = ${id}`,
    );
    expect(row).toEqual({ status: 'ended', pause_reason: 'admin', unranked: true });
    expect((await req('POST', `/admin/api/games/${id}/end`)).statusCode).toBe(409);
    const meta = (await api(built.app, p.cookie)('GET', `/api/games/${id}`)).json();
    expect(meta.game.endReason).toBe('admin');
    await ws.close();
    const arch = (await req('GET', '/admin/api/games/archive')).json().games;
    expect(arch.find((g: { id: string }) => g.id === id).endReason).toBe('admin');
    expect((await req('DELETE', `/admin/api/games/${id}`, { confirm: 'non' })).statusCode).toBe(
      400,
    );
    expect(
      (await req('DELETE', `/admin/api/games/${id}`, { confirm: id.slice(0, 8) })).statusCode,
    ).toBe(200);
    expect((await req('DELETE', `/admin/api/games/${id}`, { confirm: 'x' })).statusCode).toBe(404);
    const actions = await sqlQuery(
      (sql) => sql`SELECT action FROM admin_audit WHERE target = ${`game:${id}`} ORDER BY id`,
    );
    expect(actions.map((a) => a.action)).toEqual(['game.end', 'game.delete']);
  });

  it('annonces : diffusion aux connectés, rappel à la connexion, lecture publique', async () => {
    const req = api(built.app, admin);
    const p = await register(built.app, 'annonce@redline.test');
    const id = await createGame(built.app, p.cookie);
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const c = await req('POST', '/admin/api/announcements', {
      text: 'Maintenance à 22 h',
      level: 'warn',
      endsAt,
    });
    expect(c.statusCode).toBe(201);
    expect(c.json().sent).toBeGreaterThanOrEqual(1);
    await ws.next('notice', (n) => n.text === 'Maintenance à 22 h' && n.level === 'warn');
    await ws.close();
    const ws2 = await WsClient.connect(port, id, p.cookie);
    await ws2.next('notice', (n) => n.text === 'Maintenance à 22 h');
    await ws2.close();
    const pub = await built.app.inject({ method: 'GET', url: '/api/announcements' });
    expect(pub.json().announcements.map((a: { text: string }) => a.text)).toEqual([
      'Maintenance à 22 h',
    ]);
    const aid = c.json().announcement.id;
    expect(
      (await req('PUT', `/admin/api/announcements/${aid}`, { active: false })).statusCode,
    ).toBe(200);
    const pub2 = await built.app.inject({ method: 'GET', url: '/api/announcements' });
    expect(pub2.json().announcements).toEqual([]);
    expect((await req('DELETE', `/admin/api/announcements/${aid}`)).statusCode).toBe(200);
    expect(
      (
        await req('POST', '/admin/api/announcements', {
          text: 'x',
          startsAt: endsAt,
          endsAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(400);
  });

  it("paramètres d'exploitation : quotas et délais appliqués à chaud et conservés", async () => {
    const req = api(built.app, admin);
    const cur = (await req('GET', '/admin/api/server/settings')).json();
    expect(cur.settings.maxActiveSoloPerUser).toBe(10);
    expect(cur.info.speeds.length).toBeGreaterThan(0);
    const put = await req('PUT', '/admin/api/server/settings', {
      ...cur.settings,
      maxActiveSoloPerUser: 1,
      soloAbandonMin: 600,
    });
    expect(put.statusCode).toBe(200);
    expect(built.ctx.options.soloAbandonMs).toBe(600 * 60_000);
    const g = await guest(built.app);
    await createGame(built.app, g.cookie);
    const second = await built.app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { cookie: g.cookie },
      payload: { nationId: 'dza' },
    });
    expect(second.statusCode).toBe(429);
    // Relu en base au démarrage.
    built.ctx.options.maxActiveSoloPerUser = 10;
    await built.ctx.runtimeSettings.init();
    expect(built.ctx.options.maxActiveSoloPerUser).toBe(1);
    await req('PUT', '/admin/api/server/settings', { ...cur.settings });
    expect(
      (await req('PUT', '/admin/api/server/settings', { ...cur.settings, soloAbandonMin: 1 }))
        .statusCode,
    ).toBe(400);
  });

  it("journal d'audit filtrable (action, cible, dates, pagination)", async () => {
    const req = api(built.app, admin);
    const users = (await req('GET', '/admin/api/audit?action=user.&limit=1000')).json().entries;
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((e: { action: string }) => e.action.startsWith('user.'))).toBe(true);
    const future = (
      await req(
        'GET',
        `/admin/api/audit?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      )
    ).json().entries;
    expect(future).toEqual([]);
    const all = (await req('GET', '/admin/api/audit?limit=3')).json().entries;
    const next = (await req('GET', `/admin/api/audit?limit=3&before=${all[2].id}`)).json().entries;
    expect(next[0].id).toBeLessThan(all[2].id);
    await until(() => true, 'ok');
  });
});
