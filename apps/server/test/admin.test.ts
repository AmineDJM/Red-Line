import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import type { AdminSystem, CatalogChange, WeaponSystem } from '@redline/shared';
import { syncRepoCatalog } from '../src/data/catalog-store.js';
import {
  WsClient,
  createGame,
  dbAvailable,
  guest,
  listen,
  makeDataDir,
  resetDb,
  sessionCookie,
  sqlQuery,
  startApp,
  testSystem,
} from './helpers.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

describe.skipIf(!hasDb)("API d'administration", () => {
  let built: BuiltApp;
  let admin: string;
  const dataDir = makeDataDir();

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    built.app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });

  const loginAdmin = async (b: BuiltApp) =>
    sessionCookie(
      await b.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: ADMIN.ADMIN_EMAIL, password: ADMIN.ADMIN_PASSWORD },
      }),
    );

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir, env: ADMIN });
    admin = await loginAdmin(built);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('liste et lit les fiches chargées depuis le dépôt', async () => {
    const list = (await req('GET', '/admin/api/systems')).json().systems as AdminSystem[];
    expect(list.map((s) => s.system.id)).toEqual(['eu.test-inf', 'eu.test-tank']);
    expect(list[0]!.revision).toBe(1);
    const one = await req('GET', '/admin/api/systems/eu.test-inf');
    expect(one.json().system.system.name).toBe('Système eu.test-inf');
    expect((await req('GET', '/admin/api/systems/xx.nope')).statusCode).toBe(404);
  });

  it('modifie une fiche avec historique avant/après et audit, puis retour arrière', async () => {
    const orig = (await req('GET', '/admin/api/systems/eu.test-inf')).json().system
      .system as WeaponSystem;
    const res = await req('PUT', '/admin/api/systems/eu.test-inf', {
      data: { ...orig, speedKmh: 50 },
      message: 'Infanterie plus lente',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().system).toMatchObject({ revision: 2, system: { speedKmh: 50 } });

    const invalid = await req('PUT', '/admin/api/systems/eu.test-inf', {
      data: { ...orig, hp: -3 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('invalid_system');
    const mismatch = await req('PUT', '/admin/api/systems/eu.test-inf', {
      data: { ...orig, id: 'eu.autre' },
    });
    expect(mismatch.statusCode).toBe(400);

    const hist = (await req('GET', '/admin/api/systems/eu.test-inf/history')).json()
      .changes as CatalogChange[];
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      systemId: 'eu.test-inf',
      revision: 2,
      message: 'Infanterie plus lente',
      scope: 'new_games',
      author: 'Administrateur',
      before: { speedKmh: 36000 },
      after: { speedKmh: 50 },
    });

    const audit = await sqlQuery(
      (sql) => sql`SELECT action, target FROM admin_audit WHERE target = 'system:eu.test-inf'`,
    );
    expect(audit).toEqual([{ action: 'system.update', target: 'system:eu.test-inf' }]);

    const rev = await req('POST', '/admin/api/systems/eu.test-inf/revert', {
      changeId: hist[0]!.id,
    });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().system).toMatchObject({ revision: 3, system: { speedKmh: 36000 } });
    const hist2 = (await req('GET', '/admin/api/systems/eu.test-inf/history')).json()
      .changes as CatalogChange[];
    expect(hist2).toHaveLength(2);
    expect(hist2[0]!.message).toContain('Retour arrière');

    // Une fiche identique n'engendre ni révision ni historique (comparaison insensible à l'ordre des clés).
    const same = await req('PUT', '/admin/api/systems/eu.test-inf', {
      data: rev.json().system.system,
    });
    expect(same.json().system.revision).toBe(3);
    expect(
      (await req('GET', '/admin/api/systems/eu.test-inf/history')).json().changes,
    ).toHaveLength(2);
  });

  it('crée, duplique, désactive ; refuse le retour arrière d’une création', async () => {
    const created = await req('POST', '/admin/api/systems', {
      data: testSystem('ru.test-arty', { doctrine: 'ru', origin: 'RU', category: 'artillery' }),
      message: 'Nouvelle artillerie',
    });
    expect(created.statusCode).toBe(201);
    expect(
      (await req('POST', '/admin/api/systems', { data: testSystem('ru.test-arty') })).statusCode,
    ).toBe(409);

    const dup = await req('POST', '/admin/api/systems/ru.test-arty/duplicate', {
      newId: 'ru.test-arty-2',
    });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().system.system).toMatchObject({
      id: 'ru.test-arty-2',
      name: 'Système ru.test-arty (copie)',
    });
    expect(
      (await req('POST', '/admin/api/systems/ru.test-arty/duplicate', { newId: 'Pas Valide' }))
        .statusCode,
    ).toBe(400);

    const [creation] = (await req('GET', '/admin/api/systems/ru.test-arty/history')).json().changes;
    const bad = await req('POST', '/admin/api/systems/ru.test-arty/revert', {
      changeId: creation.id,
    });
    expect(bad.statusCode).toBe(400);

    const cur = (await req('GET', '/admin/api/systems/ru.test-arty-2')).json().system.system;
    await req('PUT', '/admin/api/systems/ru.test-arty-2', { data: { ...cur, enabled: false } });
    const pub = (await built.app.inject({ method: 'GET', url: '/api/catalog' })).json()
      .systems as WeaponSystem[];
    expect(pub.map((s) => s.id)).toContain('ru.test-arty');
    expect(pub.map((s) => s.id)).not.toContain('ru.test-arty-2');
  });

  it('import JSON : un import invalide est rejeté en bloc, un import valide crée et met à jour', async () => {
    const before = (await req('GET', '/admin/api/systems')).json().systems.length;
    const bad = await req('POST', '/admin/api/catalog/import', {
      systems: [testSystem('cn.test-new'), { id: 'cn.cassé', name: '' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ created: 0, updated: 0 });
    expect(bad.json().errors).toEqual([expect.objectContaining({ index: 1, id: 'cn.cassé' })]);
    expect((await req('GET', '/admin/api/systems')).json().systems.length).toBe(before);

    const exp = (await req('GET', '/admin/api/catalog/export')).json().systems as WeaponSystem[];
    const tank = exp.find((s) => s.id === 'eu.test-tank')!;
    const ok = await req('POST', '/admin/api/catalog/import', {
      systems: [{ ...tank, hp: 99 }, testSystem('cn.test-new', { doctrine: 'cn', origin: 'CN' })],
      message: 'Import de test',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ created: 1, updated: 1, errors: [] });
    expect((await req('GET', '/admin/api/systems')).json().systems.length).toBe(before + 1);
  });

  it("n'écrase jamais une modification du back-office au redémarrage ; catalog:reset resynchronise", async () => {
    const cur = (await req('GET', '/admin/api/systems/eu.test-inf')).json().system.system;
    await req('PUT', '/admin/api/systems/eu.test-inf', {
      data: { ...cur, name: 'Fantassins modifiés' },
    });
    await built.app.close();
    built = await startApp({ dataDir, env: ADMIN });
    admin = await loginAdmin(built);
    expect((await req('GET', '/admin/api/systems/eu.test-inf')).json().system.system.name).toBe(
      'Fantassins modifiés',
    );
    const r = await syncRepoCatalog(built.ctx.db, built.ctx.data.repoCatalog, { force: true });
    expect(r.updated).toEqual(expect.arrayContaining(['eu.test-inf', 'eu.test-tank']));
    expect((await req('GET', '/admin/api/systems/eu.test-inf')).json().system.system.name).toBe(
      'Système eu.test-inf',
    );
  });

  it('portée « running_games » : parties en cours mises à jour et joueurs prévenus ; « new_games » : non', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie);
    const port = await listen(built.app);
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    const host = built.ctx.host;
    const releaseBefore = host.games.get(id)!.releaseId;

    const cur = (await req('GET', '/admin/api/systems/eu.test-tank')).json().system.system;
    await req('PUT', '/admin/api/systems/eu.test-tank', {
      data: { ...cur, speedKmh: 11 },
      scope: 'new_games',
    });
    expect(host.games.get(id)!.releaseId).toBe(releaseBefore);
    expect(host.games.get(id)!.world.catalog.get('eu.test-tank')!.speedKmh).not.toBe(11);

    const res = await req('PUT', '/admin/api/systems/eu.test-tank', {
      data: { ...cur, speedKmh: 22 },
      scope: 'running_games',
      playerMessage: 'Les chars ralentissent.',
    });
    expect(res.statusCode).toBe(200);
    const notice = await ws.next('notice');
    expect(notice.text).toBe('Les chars ralentissent.');
    const g = host.games.get(id)!;
    expect(g.world.catalog.get('eu.test-tank')!.speedKmh).toBe(22);
    expect(g.releaseId).not.toBe(releaseBefore);
    const [row] = await sqlQuery(
      (sql) => sql`SELECT catalog_release_id FROM games WHERE id = ${id}`,
    );
    expect(row!.catalog_release_id).toBe(g.releaseId);

    // Une nouvelle partie utilise la dernière release.
    const id2 = await createGame(built.app, p.cookie, { nationId: 'usa' });
    expect(host.games.get(id2)!.world.catalog.get('eu.test-tank')!.speedKmh).toBe(22);
    await ws.close();
  });

  it('parties en direct : liste, pause, reprise ; métriques', async () => {
    const p = await guest(built.app);
    const id = await createGame(built.app, p.cookie, { nationId: 'dza' });
    const list = (await req('GET', '/admin/api/games')).json().games;
    const entry = list.find((x: { game: { id: string } }) => x.game.id === id);
    expect(entry).toMatchObject({
      players: [{ nationId: 'dza', isAi: false }],
      unitCount: 3,
      queueSize: 1,
    });
    expect((await req('POST', `/admin/api/games/${id}/pause`)).json()).toEqual({ ok: true });
    expect(built.ctx.host.games.get(id)!.pauseReason).toBe('admin');

    // Le joueur ne peut pas relancer une partie suspendue par l'administration.
    const port = await listen(built.app);
    const ws = await WsClient.connect(port, id, p.cookie);
    await ws.next('welcome');
    ws.send({ t: 'control', paused: false });
    await ws.next('error', (m) => m.code === 'not_allowed');

    const resumed = ws.nextNew('clock', (m) => !m.clock.paused);
    expect((await req('POST', `/admin/api/games/${id}/resume`)).json()).toEqual({ ok: true });
    await resumed;
    await ws.close();
    expect(
      (await req('POST', '/admin/api/games/00000000-0000-0000-0000-000000000000/pause')).statusCode,
    ).toBe(409);

    const m = (await req('GET', '/admin/api/metrics')).json();
    expect(m).toMatchObject({ games: expect.any(Number), connectedPlayers: expect.any(Number) });
    for (const k of [
      'uptimeS',
      'rssMb',
      'heapMb',
      'cpuPct',
      'eventLoopLagMs',
      'eventsProcessedPerMin',
    ]) {
      expect(typeof m[k]).toBe('number');
    }
    expect(m.games).toBeGreaterThanOrEqual(1);
    const audit = await sqlQuery(
      (sql) => sql`SELECT action FROM admin_audit WHERE target = ${`game:${id}`}`,
    );
    expect(audit.map((a) => a.action)).toEqual(['game.pause', 'game.resume']);
  });
});
