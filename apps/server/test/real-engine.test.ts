import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import { loadRealEngine } from '../src/engine.js';
import { REPO_ROOT } from '../src/paths.js';
import {
  WsClient,
  api,
  dbAvailable,
  guest,
  listen,
  resetDb,
  sqlQuery,
  startApp,
} from './helpers.js';

const hasDb = await dbAvailable();
const { engine } = loadRealEngine();

/** Quelques vérifications de bout en bout avec le VRAI moteur et les vraies données du dépôt. */
describe.skipIf(!hasDb || !engine)('vrai moteur : multijoueur, spectateur, IA, timelapse', () => {
  let built: BuiltApp;
  let port: number;
  let gameId = '';

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir: join(REPO_ROOT, 'data'), engine });
    port = await listen(built.app);
  }, 120_000);
  afterAll(async () => {
    await built?.app.close();
  });

  it('partie à 2 joueurs lancée avec le vrai moteur', { timeout: 120_000 }, async () => {
    const A = await guest(built.app);
    const B = await guest(built.app);
    const created = await api(built.app, A.cookie)('POST', '/api/lobby', {
      name: 'Vrai moteur',
      nationId: 'fra',
      maxPlayers: 2,
    });
    expect(created.statusCode).toBe(201);
    gameId = created.json().game.id;
    const joined = await api(built.app, B.cookie)('POST', `/api/lobby/${gameId}/join`, {
      nationId: 'dza',
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().game.status).toBe('running');

    const ws = await WsClient.connect(port, gameId, A.cookie);
    const w = await ws.next('welcome', () => true, 60_000);
    expect(w.me).toBe('fra');
    expect(w.view.nations.fra!.isPlayer).toBe(true);
    expect(w.view.nations.dza!.isPlayer).toBe(true);
    await ws.close();

    // Timelapse : image initiale complète.
    await built.ctx.host.settle(gameId);
    const tl = (await api(built.app, A.cookie)('GET', `/api/games/${gameId}/timelapse`)).json();
    expect(tl.frames[0].day).toBe(0);
    expect(Object.keys(tl.frames[0].owners).length).toBeGreaterThan(100);
    expect(Object.values(tl.frames[0].owners)).toEqual(expect.arrayContaining(['fra', 'dza']));

    // Rapports détaillés : 404 propre si le moteur n'exporte pas battleReportFor.
    const br = await api(built.app, A.cookie)('GET', `/api/games/${gameId}/battle-reports/x`);
    expect(br.statusCode).toBe(404);
    // Statistiques : seulement en fin de partie.
    expect((await api(built.app, A.cookie)('GET', `/api/games/${gameId}/stats`)).statusCode).toBe(
      409,
    );
  });

  it(
    'spectateur : vue publique du moteur, sans économie ni secrets',
    { timeout: 60_000 },
    async () => {
      const C = await guest(built.app);
      const ws = await WsClient.connect(port, `${gameId}&spectate=1`, C.cookie);
      const w = await ws.next('welcome', () => true, 30_000);
      expect(w.view.spectator).toBe(true);
      expect(w.view.me).toBe('');
      expect(w.view.economy.money).toBe(0);
      expect(w.view.intel).toBeUndefined();
      expect(Object.values(w.view.units).every((u) => u.level !== 'own')).toBe(true);
      await ws.close();
    },
  );

  it('IA de remplacement (applySystem setAi) et reprise', { timeout: 60_000 }, async () => {
    const host = built.ctx.host;
    expect(await host.checkInactive(Date.now() + 25 * 3600_000)).toBe(2);
    await host.settle(gameId);
    const rows = await sqlQuery(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM game_orders WHERE game_id = ${gameId} AND player_slot = -1`,
    );
    expect(rows[0]!.n).toBe(2);
    const C = await guest(built.app);
    const ws = await WsClient.connect(port, `${gameId}&spectate=1`, C.cookie);
    const w = await ws.next('welcome', () => true, 30_000);
    expect(w.view.nations.fra!.isAi).toBe(true);
    await ws.close();
  });
});
