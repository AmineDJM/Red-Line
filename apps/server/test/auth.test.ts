import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import {
  dbAvailable,
  guest,
  makeDataDir,
  resetDb,
  sessionCookie,
  sqlQuery,
  startApp,
} from './helpers.js';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('authentification et rôles', () => {
  let built: BuiltApp;
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir,
      env: { ADMIN_EMAIL: 'Admin@RedLine.test', ADMIN_PASSWORD: 'motdepasse-admin' },
    });
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('crée un invité avec un cookie httpOnly SameSite=Lax', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/auth/guest' });
    expect(res.statusCode).toBe(200);
    const user = res.json().user;
    expect(user.isGuest).toBe(true);
    expect(user.role).toBe('player');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/rl_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/); // pas en test/dev

    const me = await built.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: sessionCookie(res) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
  });

  it('/api/me sans session ou avec un cookie falsifié → 401', async () => {
    expect((await built.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const forged = await built.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'rl_session=abc.def' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("inscription d'un invité (il garde son compte), connexion, déconnexion", async () => {
    const g = await guest(built.app);
    const reg = await built.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { cookie: g.cookie },
      payload: { email: 'Joueur@Example.com', password: 'secret-123', displayName: 'Joueur' },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().user).toMatchObject({
      id: g.userId,
      isGuest: false,
      email: 'joueur@example.com',
    });
    const cookie = sessionCookie(reg);
    expect(cookie).not.toBe(g.cookie); // rotation à la connexion

    // L'ancien jeton d'invité est invalidé.
    expect(
      (await built.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: g.cookie } }))
        .statusCode,
    ).toBe(401);

    const dup = await built.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'joueur@example.com', password: 'secret-123', displayName: 'Autre' },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'joueur@example.com', password: 'mauvais' },
    });
    expect(bad.statusCode).toBe(401);

    const login = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'JOUEUR@example.com', password: 'secret-123' },
    });
    expect(login.statusCode).toBe(200);
    const c2 = sessionCookie(login);

    const out = await built.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: c2 },
    });
    expect(out.statusCode).toBe(200);
    expect(
      (await built.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c2 } }))
        .statusCode,
    ).toBe(401);
  });

  it('valide les corps de requête (zod)', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'pas-un-email', password: 'court', displayName: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('crée le super-admin depuis ADMIN_EMAIL/ADMIN_PASSWORD et contrôle les rôles', async () => {
    const login = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@redline.test', password: 'motdepasse-admin' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe('superadmin');
    const admin = sessionCookie(login);

    const player = await guest(built.app);
    for (const url of ['/admin/api/systems', '/admin/api/games', '/admin/api/metrics']) {
      expect((await built.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await built.app.inject({ method: 'GET', url, headers: { cookie: player.cookie } }))
          .statusCode,
      ).toBe(403);
      expect(
        (await built.app.inject({ method: 'GET', url, headers: { cookie: admin } })).statusCode,
      ).toBe(200);
    }

    // Un modérateur voit les parties mais pas le catalogue.
    await sqlQuery((sql) => sql`UPDATE users SET role = 'moderator' WHERE id = ${player.userId}`);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/admin/api/games',
          headers: { cookie: player.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/admin/api/systems',
          headers: { cookie: player.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('fait tourner un jeton de session ancien', async () => {
    const g = await guest(built.app);
    await sqlQuery((sql) => sql`UPDATE sessions SET created_at = now() - interval '2 days'`);
    const me = await built.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: g.cookie },
    });
    expect(me.statusCode).toBe(200);
    const fresh = sessionCookie(me);
    expect(fresh).not.toBe(g.cookie);
    expect(
      (await built.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: fresh } }))
        .statusCode,
    ).toBe(200);
  });
});

describe.skipIf(!hasDb)("limitation de débit de l'authentification", () => {
  it('renvoie 429 au-delà du quota', async () => {
    await resetDb();
    const built = await startApp({ dataDir: makeDataDir(), runtime: { authRateLimitPerMin: 3 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'x@example.com', password: 'nope' },
        });
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes[3]).toBe(429);
    } finally {
      await built.app.close();
    }
  });
});
