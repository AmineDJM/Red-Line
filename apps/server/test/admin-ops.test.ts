import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import { REPO_ROOT } from '../src/paths.js';
import {
  BALANCE,
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
  sessionCookie,
  sqlQuery,
  startApp,
  until,
} from './helpers.js';
import { fakeState } from './fake-engine.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

/** Documents légaux de test (copie des documents faisant foi) : CGV passées en version 3. */
function legalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-legal-'));
  cpSync(join(REPO_ROOT, 'apps/site/content/fr/legal'), dir, { recursive: true });
  const p = join(dir, 'cgv.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^version: 2$/m, 'version: 3'));
  return dir;
}

describe.skipIf(!hasDb)('administration (phases 5-6), légal, sécurité', () => {
  let built: BuiltApp;
  let port: number;
  let admin: string;
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir, env: { ...ADMIN, LEGAL_DIR: legalDir() } });
    port = await listen(built.app);
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('rôles : joueur, modérateur, équilibrage, super-admin', async () => {
    const reqAdmin = api(built.app, admin);
    const mk = async (email: string, role?: string) => {
      const u = await register(built.app, email);
      if (role) {
        const r = await reqAdmin('PUT', `/admin/api/users/${u.userId}`, { role });
        expect(r.statusCode).toBe(200);
      }
      return api(built.app, u.cookie);
    };
    const player = await mk('joueur@redline.test');
    const mod = await mk('modo@redline.test', 'moderator');
    const bal = await mk('equilibre@redline.test', 'balance');
    const anon = api(built.app, null);

    const cases: [string, string, number[]][] = [
      ['GET', '/admin/api/rules', [401, 403, 403, 200, 200]],
      ['GET', '/admin/api/research', [401, 403, 403, 200, 200]],
      ['GET', '/admin/api/map/nations', [401, 403, 403, 200, 200]],
      ['GET', '/admin/api/chat', [401, 403, 200, 200, 200]],
      ['GET', '/admin/api/security/suspicious', [401, 403, 200, 200, 200]],
      ['GET', '/admin/api/users', [401, 403, 403, 403, 200]],
      ['GET', '/admin/api/shop/packs', [401, 403, 403, 403, 200]],
      ['GET', '/admin/api/purchases', [401, 403, 403, 403, 200]],
      ['GET', '/admin/api/audit', [401, 403, 403, 403, 200]],
    ];
    for (const [method, url, expected] of cases) {
      const got = [];
      for (const r of [anon, player, mod, bal, reqAdmin]) {
        got.push((await r(method as 'GET', url)).statusCode);
      }
      expect({ url, got }).toEqual({ url, got: expected });
    }
  });

  it('règles versionnées : validation, portée, historique, retour arrière, réinitialisation', async () => {
    const req = api(built.app, admin);
    const p = await guest(built.app);
    const running = await createGame(built.app, p.cookie, { nationId: 'fra' });
    const cur = (await req('GET', '/admin/api/rules')).json();
    expect(cur.rules.time.speeds).toEqual([1, 2, 4, 1000]);
    expect(cur.source).toBe('repo');

    expect((await req('PUT', '/admin/api/rules', { data: { version: 1 } })).statusCode).toBe(400);
    const a = await req('PUT', '/admin/api/rules', {
      data: { ...BALANCE, time: { ...BALANCE.time, speeds: [1, 2] } },
      message: 'Moins de vitesses',
    });
    expect(a.statusCode).toBe(200);
    const revA = a.json().revision.id;
    // Portée « nouvelles parties » : la partie en cours garde ses règles.
    expect(built.ctx.host.games.get(running)!.balance.time.speeds).toEqual([1, 2, 4, 1000]);
    expect(
      (await api(built.app, p.cookie)('POST', '/api/games', { nationId: 'usa', speed: 4 }))
        .statusCode,
    ).toBe(400);

    const b = await req('PUT', '/admin/api/rules', {
      data: { ...BALANCE, time: { ...BALANCE.time, speeds: [1, 8] } },
      scope: 'running_games',
      playerMessage: 'Nouvelles règles',
    });
    expect(b.json().runningGames).toBe(1);
    const g = built.ctx.host.games.get(running)!;
    expect(g.balance.time.speeds).toEqual([1, 8]);
    await built.ctx.host.settle(running);
    const [row] = await sqlQuery((sql) => sql`SELECT balance FROM games WHERE id = ${running}`);
    expect((row!.balance as { time: { speeds: number[] } }).time.speeds).toEqual([1, 8]);

    const hist = (await req('GET', '/admin/api/rules/history')).json();
    expect(hist.revisions.map((r: { id: number }) => r.id)).toEqual([b.json().revision.id, revA]);
    await req('POST', '/admin/api/rules/revert', { revisionId: revA });
    expect((await req('GET', '/admin/api/rules')).json().rules.time.speeds).toEqual([1, 2]);
    await req('POST', '/admin/api/rules/reset', {});
    expect((await req('GET', '/admin/api/rules')).json().rules.time.speeds).toEqual([
      1, 2, 4, 1000,
    ]);
  });

  it('recherche, ORBAT, scénarios, nations (fusion), provinces : versionnés et effectifs', async () => {
    const req = api(built.app, admin);
    const node = {
      id: 'research.aero.gen5',
      name: 'Chasseurs de 5e génération',
      branch: 'aero',
      tier: 5,
      cost: { money: 5e9 },
      durationH: 720,
    };
    expect(
      (await req('PUT', '/admin/api/research/research.aero.gen4', { data: node })).json().error,
    ).toBe('id_mismatch');
    expect(
      (await req('PUT', '/admin/api/research/research.aero.gen5', { data: node })).statusCode,
    ).toBe(200);
    expect((await req('GET', '/admin/api/research')).json().nodes).toHaveLength(1);
    const got = (await req('GET', '/admin/api/research/research.aero.gen5')).json();
    expect(got.data.name).toBe('Chasseurs de 5e génération');
    expect(got.revisions).toHaveLength(1);

    const orbat = {
      nationId: 'dza',
      year: 2025,
      doctrine: 'ru',
      defenseBudgetUsd: 21e9,
      inventory: [{ systemId: 'eu.test-inf', count: 14 }],
      research: ['research.aero.gen4'],
    };
    expect((await req('PUT', '/admin/api/orbat/2025/fra', { data: orbat })).json().error).toBe(
      'id_mismatch',
    );
    expect((await req('PUT', '/admin/api/orbat/2025/dza', { data: orbat })).statusCode).toBe(200);
    expect((await req('GET', '/admin/api/orbat')).json().sets).toEqual({ '2025': ['dza'] });
    const info = (await built.app.inject({ method: 'GET', url: '/api/nations/info' })).json();
    expect(info.nations.find((n: { id: string }) => n.id === 'dza').defenseBudgetUsd).toBe(21e9);

    await req('PUT', '/admin/api/scenarios/europe', {
      data: {
        id: 'europe',
        name: 'Europe',
        description: 'Théâtre européen',
        playableNations: ['fra'],
        nationIds: ['fra', 'dza'],
      },
    });
    const scs = (await built.app.inject({ method: 'GET', url: '/api/scenarios' })).json().scenarios;
    expect(scs.map((s: { id: string }) => s.id)).toEqual(['world-today', 'europe']);

    // Nation renommée : l'API publique suit (cache invalidé).
    const fra = (await req('GET', '/admin/api/map/nations/fra')).json().data;
    const p = await guest(built.app);
    const running = await createGame(built.app, p.cookie, { nationId: 'dza' });
    const renamed = await req('PUT', '/admin/api/map/nations/fra', {
      data: { ...fra, name: 'République française' },
      scope: 'running_games',
    });
    expect(renamed.json().runningGames).toBeGreaterThanOrEqual(1);
    expect(built.ctx.host.games.get(running)!.dataRev).toBe(built.ctx.store.currentRev);
    const nations = (await built.app.inject({ method: 'GET', url: '/api/map/nations' })).json()
      .nations;
    expect(nations.find((n: { id: string }) => n.id === 'fra').name).toBe('République française');

    // Fusion : les provinces des États-Unis passent à la France.
    const merged = await req('PUT', '/admin/api/map/nations/usa', { mergeInto: 'fra' });
    expect(merged.json().merged).toBe(1);
    const provinces = (await built.app.inject({ method: 'GET', url: '/api/map/provinces' })).json()
      .provinces;
    expect(provinces.find((x: { id: string }) => x.id === 'usa-1')).toMatchObject({
      nationId: 'fra',
      isCapital: false,
    });
    const hist = (await req('GET', '/admin/api/map/provinces/usa-1/history')).json();
    expect(hist.revisions).toHaveLength(1);
    await req('POST', '/admin/api/map/provinces/usa-1/revert', {
      revisionId: hist.revisions[0].id,
    });
    // Retour arrière vers la valeur de cette révision (la fusion) : inchangé ; réinitialisation : dépôt.
    await req('POST', '/admin/api/map/provinces/usa-1/reset', {});
    const back = (await built.app.inject({ method: 'GET', url: '/api/map/provinces' })).json()
      .provinces;
    expect(back.find((x: { id: string }) => x.id === 'usa-1').nationId).toBe('usa');

    const status = (await req('GET', '/admin/api/data/status')).json();
    expect(status.rev).toBe(built.ctx.store.currentRev);
  });

  it('événement mondial en direct (commande système journalisée, avis aux joueurs)', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie, { nationId: 'fra' });
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    expect(
      (
        await api(built.app, p.cookie)('POST', `/admin/api/games/${id}/event`, {
          event: 'oil_crisis',
        })
      ).statusCode,
    ).toBe(403);
    const bad = await api(built.app, admin)('POST', `/admin/api/games/${id}/event`, {
      event: 'meteor',
    });
    expect(bad.statusCode).toBe(400);
    const res = await api(built.app, admin)('POST', `/admin/api/games/${id}/event`, {
      event: 'oil_crisis',
      message: 'Crise pétrolière mondiale !',
      params: { priceFactor: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeState(built.ctx.host.games.get(id)!.state).sys.at(-1)).toMatchObject({
      kind: 'worldEvent',
      event: 'oil_crisis',
    });
    expect((await ws.next('notice')).text).toBe('Crise pétrolière mondiale !');
    await ws.close();
  });

  it('utilisateurs : bannissement (sessions et WebSocket coupés), levée, anti-verrouillage', async () => {
    const req = api(built.app, admin);
    const u = await register(built.app, 'tricheur@redline.test', 'Tricheur');
    const id = await createGame(built.app, u.cookie, { nationId: 'fra' });
    const ws = await WsClient.connect(port, id, u.cookie);
    await ws.next('welcome');
    const ban = await req('PUT', `/admin/api/users/${u.userId}`, {
      banned: true,
      banReason: 'triche',
    });
    expect(ban.json().user).toMatchObject({ banReason: 'triche' });
    await ws.next('error', (m) => m.code === 'banned');
    expect((await api(built.app, u.cookie)('GET', '/api/me')).statusCode).toBe(401);
    const denied = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tricheur@redline.test', password: 'motdepasse-test' },
    });
    expect(denied.statusCode).toBe(403);
    await req('PUT', `/admin/api/users/${u.userId}`, { banned: false });
    const ok = await built.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tricheur@redline.test', password: 'motdepasse-test' },
    });
    expect(ok.statusCode).toBe(200);
    expect(sessionCookie(ok)).toMatch(/^rl_session=/);

    const me = (await req('GET', '/api/me')).json().user.id;
    expect((await req('PUT', `/admin/api/users/${me}`, { role: 'player' })).json().error).toBe(
      'self_lockout',
    );
    const detail = (await req('GET', `/admin/api/users/${u.userId}`)).json();
    expect(detail.games).toHaveLength(1);
    expect(detail.fingerprints.length).toBeGreaterThan(0);
    const list = (await req('GET', '/admin/api/users?q=tricheur')).json().users;
    expect(list).toHaveLength(1);
  });

  it('multi-comptes : même IP, même navigateur, même partie', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Navigateur-Test/1.0' };
    const reg = async (email: string) => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: ip,
        payload: { email, password: 'motdepasse-test', displayName: email.split('@')[0] },
      });
      return { cookie: sessionCookie(res), userId: res.json().user.id as string };
    };
    const x = await reg('multi1@redline.test');
    const y = await reg('multi2@redline.test');
    const lobby = await built.app.inject({
      method: 'POST',
      url: '/api/lobby',
      headers: { ...ip, cookie: x.cookie },
      payload: { name: 'Multi', nationId: 'fra', maxPlayers: 2 },
    });
    await built.app.inject({
      method: 'POST',
      url: `/api/lobby/${lobby.json().game.id}/join`,
      headers: { ...ip, cookie: y.cookie },
      payload: { nationId: 'dza' },
    });
    const pair = await until(async () => {
      const r = (await api(built.app, admin)('GET', '/admin/api/security/suspicious')).json();
      return r.pairs.find(
        (p: { users: { id: string }[] }) =>
          p.users.some((u) => u.id === x.userId) && p.users.some((u) => u.id === y.userId),
      );
    }, 'paire suspecte');
    expect(pair.score).toBeGreaterThanOrEqual(6);
    expect(pair.reasons.join(' ')).toMatch(/IP partagée.*même navigateur.*même partie/);
    expect(pair.sharedGames).toEqual([lobby.json().game.id]);
    const [fp] = await sqlQuery(
      (sql) => sql`SELECT ip_hash FROM user_fingerprints WHERE user_id = ${x.userId} LIMIT 1`,
    );
    expect(fp!.ip_hash).not.toContain('203.0.113.7'); // jamais d'IP en clair
  });

  it('documents légaux versionnés, acceptation, documents à (re)accepter dans /api/me', async () => {
    const doc = (await built.app.inject({ method: 'GET', url: '/api/legal/cgu' })).json().doc;
    expect(doc).toMatchObject({
      id: 'cgu',
      version: 2,
      title: "Conditions générales d'utilisation",
      lang: 'fr',
    });
    expect(doc.markdown).toContain('Red Line');
    // Jetons remplacés : éditeur (réglages par défaut) et contact déduit de l'hôte de la requête.
    expect(doc.markdown).toContain('921 737 607');
    expect(doc.markdown).toContain('contact@localhost');
    expect(doc.markdown).not.toContain('{{');
    // Traduction anglaise à jour : servie avec ?lang=en ; langue inconnue : version française.
    const en = (await built.app.inject({ method: 'GET', url: '/api/legal/cgu?lang=en' })).json()
      .doc;
    expect(en).toMatchObject({ id: 'cgu', version: 2, title: 'Terms of use', lang: 'en' });
    const xx = (await built.app.inject({ method: 'GET', url: '/api/legal/cgu?lang=xx' })).json()
      .doc;
    expect(xx.lang).toBe('fr');
    // Mentions légales et cookies : consultables, jamais soumis à acceptation.
    expect(
      (await built.app.inject({ method: 'GET', url: '/api/legal/mentions' })).json().doc.title,
    ).toBe('Mentions légales');
    expect((await built.app.inject({ method: 'GET', url: '/api/legal/autre' })).statusCode).toBe(
      404,
    );

    const u = await guest(built.app);
    const req = api(built.app, u.cookie);
    expect((await req('GET', '/api/me')).json().legal.needsAcceptance).toEqual([
      { id: 'cgu', version: 2 },
      { id: 'privacy', version: 2 },
    ]);
    expect(
      (await req('POST', '/api/legal/accept', { docs: [{ id: 'cgv', version: 2 }] })).json().error,
    ).toBe('outdated_version');
    await req('POST', '/api/legal/accept', { docs: [{ id: 'cgu', version: 2 }] });
    expect((await req('GET', '/api/me')).json().legal.needsAcceptance).toEqual([
      { id: 'privacy', version: 2 },
    ]);
    // CGV acceptées en version 2 : la version 3 doit être réacceptée.
    await sqlQuery(
      (sql) =>
        sql`INSERT INTO legal_acceptances (user_id, doc_id, version) VALUES (${u.userId}, 'cgv', 2)`,
    );
    expect((await req('GET', '/api/me')).json().legal.needsAcceptance).toEqual([
      { id: 'cgv', version: 3 },
      { id: 'privacy', version: 2 },
    ]);
  });

  it('métriques étendues et journal d’administration', async () => {
    const m = (await api(built.app, admin)('GET', '/admin/api/metrics')).json();
    expect(m).toMatchObject({
      gamesByStatus: expect.objectContaining({ running: expect.any(Number) }),
      spectators: 0,
    });
    expect(m.stateBytes).toBeGreaterThan(0);
    expect(m.wsBytesOutPerMin).toBeGreaterThan(0);
    const audit = (await api(built.app, admin)('GET', '/admin/api/audit')).json().entries;
    const actions = audit.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'data.rules.update',
        'data.rules.revert',
        'data.rules.reset',
        'data.nation.merge',
        'game.world_event',
        'user.update',
      ]),
    );
  });
});
