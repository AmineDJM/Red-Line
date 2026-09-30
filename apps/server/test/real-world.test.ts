import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NationId, PlayerView } from '@redline/shared';
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
  resetDb,
  sqlQuery,
  startApp,
  until,
} from './helpers.js';

const hasDb = await dbAvailable();
const { engine } = loadRealEngine();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };
const DATA = join(REPO_ROOT, 'data');
/** 10 heures de jeu par seconde réelle (vitesse d'essai, refusée en production). */
const FAST = 36_000;

/**
 * VRAI moteur, VRAIES données : scénario créé dans le back-office, recherche et accélération payante,
 * événement mondial, conquête jusqu'à la victoire, rapport de bataille, statistiques de fin, timelapse ;
 * puis partie monde (201 nations) : arrêt brutal, reprise déterministe, bail repris par une autre instance.
 */
describe.skipIf(!hasDb || !engine)('vrai moteur : de la création à la victoire, reprise', () => {
  let built: BuiltApp;
  let port: number;
  let admin: string;

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir: DATA,
      engine,
      env: { ...ADMIN, REDLINE_EXTRA_SPEEDS: String(FAST) },
    });
    port = await listen(built.app);
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  }, 180_000);
  afterAll(async () => {
    await built?.app.close();
  });

  it(
    'scénario du back-office, accélération, événement mondial, victoire, rapports, statistiques',
    { timeout: 240_000 },
    async () => {
      // Scénario régional créé dans le back-office : createGame doit le recevoir (nations, ORBAT 2025).
      const sc = await api(built.app, admin)('PUT', '/admin/api/scenarios/duel-test', {
        data: {
          id: 'duel-test',
          name: 'Duel de test',
          description: 'France contre Belgique',
          playableNations: ['fra'],
          nationIds: ['fra', 'bel'],
          year: 2025,
          orbatSet: '2025',
        },
      });
      expect(sc.statusCode).toBe(200);
      const P = await guest(built.app);
      await sqlQuery((sql) => sql`UPDATE users SET premium_balance = 500 WHERE id = ${P.userId}`);
      const req = api(built.app, P.cookie);
      const created = await req('POST', '/api/games', {
        scenarioId: 'duel-test',
        nationId: 'fra',
        speed: 1,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().game.id as string;
      const g = built.ctx.host.games.get(id)!;
      expect(Object.keys(engine!.stats!(g.state).nations).sort()).toEqual(['bel', 'fra']);

      const ws = await WsClient.connect(port, id, P.cookie);
      const w = await ws.next('welcome', () => true, 30_000);
      let view: PlayerView = w.view;

      // Recherche (vrai arbre technologique), puis accélération payante de ce projet.
      let seq = 1;
      let started: string | null = null;
      for (const node of built.ctx.store.current().research.slice(0, 80)) {
        const oid = seq++;
        ws.send({ t: 'order', id: oid, order: { kind: 'research', nodeId: node.id } });
        const r = await ws.next('orderResult', (m) => m.id === oid);
        if (r.ok) {
          started = node.id;
          break;
        }
      }
      expect(started).not.toBeNull();
      const bad = await req('POST', `/api/games/${id}/accelerate`, {
        target: { type: 'research', id: 'inexistant' },
        hours: 2,
      });
      expect(bad.statusCode).toBe(409);
      expect(bad.json().error).toBe('accelerate_refused');
      const acc = await req('POST', `/api/games/${id}/accelerate`, {
        target: { type: 'research', id: started },
        hours: 2,
      });
      expect(acc.statusCode).toBe(200);
      const wallet = (await req('GET', '/api/shop/wallet')).json();
      expect(wallet.balance).toBe(500 - acc.json().cost); // débité une seule fois, après succès

      // Événement mondial (module diplo) déclenché par l'administration.
      const ev = await api(built.app, admin)('POST', `/admin/api/games/${id}/event`, {
        event: 'oil_crisis',
        message: 'Choc pétrolier',
      });
      expect(ev.statusCode).toBe(200);
      await ws.next('notice', (m) => m.text === 'Choc pétrolier');

      // Conquête de Bruxelles jusqu'à la victoire.
      const bel = built.ctx.store
        .current()
        .map!.provinces.find((p) => p.nationId === 'bel' && p.isCapital)!;
      const catalog = g.world.catalog;
      const capturers = Object.values(view.units).filter(
        (u) => u.level === 'own' && catalog.get(u.systemId!)?.canCapture,
      );
      expect(capturers.length).toBeGreaterThan(0);
      const mid = seq++;
      ws.send({
        t: 'order',
        id: mid,
        order: { kind: 'move', unitIds: capturers.map((u) => u.id), to: bel.cityPoint },
      });
      expect(await ws.next('orderResult', (m) => m.id === mid)).toMatchObject({ ok: true });
      ws.send({ t: 'control', speed: FAST });
      await ws.next('clock', (m) => m.clock.speed === FAST);
      const victory = await ws.next(
        'notify',
        (m) => m.items.some((n) => n.kind === 'victory'),
        180_000,
      );
      expect(victory.items.find((n) => n.kind === 'victory')).toMatchObject({ winner: 'fra' });
      await ws.next('clock', (m) => m.clock.paused, 10_000);
      await built.ctx.host.settle(id);

      // Rapport de bataille détaillé (battleReportFor du moteur).
      view = engine!.viewFor(g.state, 'fra' as NationId);
      const reports = view.battleReports ?? [];
      expect(reports.length).toBeGreaterThan(0);
      const br = await req('GET', `/api/games/${id}/battle-reports/${reports[0]!.id}`);
      expect(br.statusCode).toBe(200);
      expect(br.json().report.id).toBe(reports[0]!.id);
      expect((await req('GET', `/api/games/${id}/battle-reports/zz`)).statusCode).toBe(404);

      // Statistiques de fin (stats du moteur) et timelapse.
      const stats = (await req('GET', `/api/games/${id}/stats`)).json();
      expect(stats.winner).toBe('fra');
      const fra = stats.nations.find((n: { nationId: string }) => n.nationId === 'fra');
      expect(fra.provincesEnd).toBeGreaterThan(fra.provincesStart - 1);
      expect(fra.player).toBeTruthy();
      const tl = (await req('GET', `/api/games/${id}/timelapse`)).json();
      expect(tl.frames.length).toBeGreaterThan(0);
      expect(tl.frames.at(-1).owners[bel.id]).toBe('fra');
      const [row] = await sqlQuery(
        (sql) =>
          sql`SELECT status, winner, final_stats IS NOT NULL AS has FROM games WHERE id = ${id}`,
      );
      expect(row).toMatchObject({ status: 'ended', winner: 'fra', has: true });
      await ws.close();
    },
  );

  it(
    'partie monde : ordres, pause, arrêt brutal, reprise identique ; bail repris ailleurs',
    { timeout: 300_000 },
    async () => {
      const A = await guest(built.app);
      const B = await guest(built.app);
      const created = await api(built.app, A.cookie)('POST', '/api/lobby', {
        name: 'Monde',
        nationId: 'fra',
        maxPlayers: 2,
        speed: FAST,
      });
      const id = created.json().game.id as string;
      await api(built.app, B.cookie)('POST', `/api/lobby/${id}/join`, { nationId: 'usa' });
      const g = built.ctx.host.games.get(id)!;
      expect(Object.keys(engine!.stats!(g.state).nations).length).toBeGreaterThan(200);
      const ws = await WsClient.connect(port, id, A.cookie);
      const w = await ws.next('welcome', () => true, 30_000);
      const own = Object.values(w.view.units).filter((u) => u.level === 'own');
      ws.send({
        t: 'order',
        id: 1,
        order: { kind: 'move', unitIds: [own[0]!.id], to: [3, 47] },
      });
      expect((await ws.next('orderResult', (m) => m.id === 1)).ok).toBe(true);
      // Quelques heures de jeu : diffs reçus, IA actives.
      await ws.nextNew('diff', () => true, 30_000);
      await ws.close();
      expect((await api(built.app, admin)('POST', `/admin/api/games/${id}/pause`)).statusCode).toBe(
        200,
      );
      const hash = engine!.stateHash(g.state);
      const time = g.state.time;
      expect(time).toBeGreaterThan(3600_000);
      await built.ctx.host.settle(id);

      // « Crash » : ni instantané final, ni libération du bail.
      await built.ctx.host.stop({ snapshot: false, release: false });
      await built.app.close();
      const b = await startApp({
        dataDir: DATA,
        engine,
        env: { ...ADMIN, REDLINE_EXTRA_SPEEDS: String(FAST) },
      });
      try {
        const g2 = await b.ctx.host.ensureLoaded(id);
        expect(g2).not.toBeNull();
        expect(g2!.state.time).toBe(time);
        expect(engine!.stateHash(g2!.state)).toBe(hash);
        // Relance, puis arrêt brutal ; une autre instance reprend le bail expiré.
        expect(await b.ctx.host.adminSetPaused(id, false)).toBe(true);
        await b.ctx.host.settle(id);
        await b.ctx.host.stop({ snapshot: false, release: false });
      } finally {
        await b.app.close();
      }
      const c = await startApp({
        dataDir: DATA,
        engine,
        instanceId: 'autre-instance',
        env: { ...ADMIN, REDLINE_EXTRA_SPEEDS: String(FAST), LEASE_TTL_S: '2' },
      });
      built = c; // fermé par afterAll
      await until(
        async () => {
          await c.ctx.host.beat();
          return c.ctx.host.games.has(id);
        },
        'adoption de la partie orpheline',
        30_000,
      );
      const [row] = await sqlQuery(
        (sql) => sql`SELECT lease_owner, status FROM games WHERE id = ${id}`,
      );
      expect(row).toMatchObject({ lease_owner: 'autre-instance', status: 'running' });
    },
  );
});
