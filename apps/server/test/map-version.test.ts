import { mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerView, ProvinceDef } from '@redline/shared';
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
const DATA = join(REPO_ROOT, 'data');

/**
 * Dossier de données « d'avant la fusion des provinces » : data/ du dépôt, sauf data/map remplacé par
 * la carte archivée (data/map/archive/1, sans version.json ni archive) — l'état d'un serveur de
 * production avant la mise à jour.
 */
function oldDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-map-v1-'));
  for (const e of readdirSync(DATA)) if (e !== 'map') symlinkSync(join(DATA, e), join(dir, e));
  mkdirSync(join(dir, 'map'));
  const v1 = join(DATA, 'map', 'archive', '1');
  for (const e of readdirSync(v1)) symlinkSync(join(v1, e), join(dir, 'map', e));
  return dir;
}

/**
 * Compatibilité des parties en cours après un changement de carte (fusion des provinces) : une partie
 * créée sur l'ancienne carte (2 567 provinces) se recharge après la mise à jour avec SA carte
 * (data/map/archive/1), ses ordres journalisés se rejouent, et seules les nouvelles parties
 * utilisent la nouvelle carte.
 */
describe.skipIf(!hasDb || !engine)('versions de carte : parties anciennes après la fusion', () => {
  let before: BuiltApp;
  let after: BuiltApp | null = null;
  let cookie = '';
  let gameId = '';
  let hash = '';
  let oldIds: string[] = [];

  beforeAll(async () => {
    await resetDb();
    before = await startApp({ dataDir: oldDataDir(), engine, instanceId: 'map-v1' });
  }, 120_000);
  afterAll(async () => {
    await before?.app.close().catch(() => {});
    await after?.app.close();
  });

  it(
    'avant la mise à jour : partie créée sur la carte 1, ordre de déplacement journalisé',
    { timeout: 180_000 },
    async () => {
      expect(before.ctx.store.mapVersion).toBe(1);
      const p = await guest(before.app);
      cookie = p.cookie;
      const res = await api(before.app, cookie)('POST', '/api/games', {
        scenarioId: 'middle-east',
        nationId: 'egy',
        speed: 1,
      });
      expect(res.statusCode).toBe(201);
      gameId = res.json().game.id;
      expect(res.json().game.mapVersion).toBe(1);

      const port = await listen(before.app);
      const ws = await WsClient.connect(port, gameId, cookie);
      const w = await ws.next('welcome', () => true, 60_000);
      const view = w.view as PlayerView;
      const provinces = (await api(before.app, cookie)('GET', '/api/map/provinces')).json()
        .provinces as ProvinceDef[];
      expect(provinces.length).toBe(2567);
      oldIds = provinces.map((x) => x.id);
      // Une unité terrestre égyptienne vers la ville d'une province voisine (identifiants de la carte 1).
      const cat = new Map(before.ctx.data.repoCatalog.map((x) => [x.id, x]));
      const unit = Object.values(view.units).find((u) => {
        const sys = u.systemId ? cat.get(u.systemId) : undefined;
        return u.owner === 'egy' && sys?.movement === 'land' && sys.canCapture;
      })!;
      expect(unit).toBeDefined();
      const target = provinces.find((x) => x.nationId === 'egy' && !x.isCapital)!;
      ws.send({
        t: 'order',
        id: 1,
        order: { kind: 'move', unitIds: [unit.id], to: target.cityPoint },
      });
      expect(await ws.next('orderResult', (m) => m.id === 1)).toMatchObject({ ok: true });
      ws.send({ t: 'control', paused: true });
      await ws.next('clock', (m) => m.clock.paused);
      await ws.close();
      const g = before.ctx.host.games.get(gameId)!;
      hash = engine!.stateHash(g.state);
      expect(Object.keys(engine!.ownersFrame!(g.state)).length).toBe(2567);
      await before.app.close();
    },
  );

  it(
    'après la mise à jour : la partie se recharge avec sa carte (archive 1), sans erreur',
    { timeout: 180_000 },
    async () => {
      after = await startApp({ dataDir: DATA, engine, instanceId: 'map-v2' });
      const store = after.ctx.store;
      expect(store.mapVersion).toBeGreaterThanOrEqual(2);
      expect(after.ctx.data.archivedMapVersions).toContain(1);

      const g = await after.ctx.host.ensureLoaded(gameId);
      expect(g).not.toBeNull();
      expect(g!.mapVersion).toBe(1);
      expect(engine!.stateHash(g!.state)).toBe(hash);
      const owners = engine!.ownersFrame!(g!.state);
      expect(Object.keys(owners).sort()).toEqual([...oldIds].sort());
      const [row] = await sqlQuery(
        (sql) => sql`SELECT map_version, pause_reason, last_error FROM games WHERE id = ${gameId}`,
      );
      expect(row).toMatchObject({ map_version: 1, last_error: null });
      expect(row!.pause_reason).not.toBe('error');

      // Le client reçoit la version épinglée et charge la carte correspondante.
      const meta = (await api(after.app, cookie)('GET', `/api/games/${gameId}`)).json().game;
      expect(meta.mapVersion).toBe(1);
      const port = await listen(after.app);
      const ws = await WsClient.connect(port, gameId, cookie);
      const w = await ws.next('welcome', () => true, 60_000);
      expect(w.game.mapVersion).toBe(1);
      await ws.close();
      const get = (url: string) => api(after!.app, cookie)('GET', url);
      const v1 = (await get('/api/map/provinces?map=1')).json().provinces as ProvinceDef[];
      expect(v1.map((x) => x.id).sort()).toEqual([...oldIds].sort());
      expect((await get('/api/map/nations?map=1')).json().mapVersion).toBe(1);
      const geo1 = (await get('/api/map/provinces.geojson?map=1')).json();
      expect(geo1.features.length).toBe(2567);
      expect((await get('/api/map/routes?map=1')).statusCode).toBe(200);
      const names = (await get('/api/map/names/en?map=1')).json();
      expect(Object.keys(names.provinces).length).toBeGreaterThan(500);
      expect((await get('/api/map/provinces?map=99')).statusCode).toBe(404);

      // Carte courante : la carte fusionnée, pour les nouvelles parties.
      const cur = (await get('/api/map/provinces')).json().provinces as ProvinceDef[];
      expect(cur.length).toBeLessThan(1600);
      expect((await get('/api/map/nations')).json().mapVersion).toBe(store.mapVersion);
      const res = await api(after.app, cookie)('POST', '/api/games', {
        scenarioId: 'middle-east',
        nationId: 'egy',
        speed: 1,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().game.mapVersion).toBe(store.mapVersion);
      const g2 = after.ctx.host.games.get(res.json().game.id)!;
      expect(Object.keys(engine!.ownersFrame!(g2.state)).length).toBe(cur.length);
    },
  );
});
