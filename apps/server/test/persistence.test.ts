import { beforeEach, describe, expect, it } from 'vitest';
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
import type { BuiltApp } from '../src/app.js';

const hasDb = await dbAvailable();

function hashOf(built: BuiltApp, id: string): string {
  const g = built.ctx.host.games.get(id);
  if (!g) throw new Error(`partie ${id} non hébergée par ${built.ctx.config.instanceId}`);
  return built.ctx.engine!.stateHash(g.state);
}

async function playAndPause(built: BuiltApp, cookie: string, id: string): Promise<void> {
  const port = await listen(built.app);
  const ws = await WsClient.connect(port, id, cookie);
  await ws.next('welcome');
  ws.send({ t: 'control', speed: 4 });
  await ws.next('clock', (m) => m.clock.speed === 4);
  ws.send({ t: 'order', id: 1, order: { kind: 'move', unitIds: ['fra-1'], to: [10, 50] } });
  expect(await ws.next('orderResult', (m) => m.id === 1)).toMatchObject({ ok: true });
  await sleep(600);
  ws.send({
    t: 'order',
    id: 2,
    order: { kind: 'stance', unitIds: ['fra-1'], stance: 'aggressive' },
  });
  expect(await ws.next('orderResult', (m) => m.id === 2)).toMatchObject({ ok: true });
  await sleep(300);
  ws.send({ t: 'control', paused: true });
  await ws.next('clock', (m) => m.clock.paused);
  await ws.close();
}

describe.skipIf(!hasDb)('persistance, reprise et bail', () => {
  const dataDir = makeDataDir();
  beforeEach(async () => {
    await resetDb();
  });

  it("instantané à l'arrêt propre puis reprise sur une nouvelle instance ⇒ même état", async () => {
    const a = await startApp({ dataDir, instanceId: 'inst-1' });
    const p = await guest(a.app);
    const id = await createGame(a.app, p.cookie);
    await playAndPause(a, p.cookie, id);
    const hash = hashOf(a, id);
    const time = a.ctx.host.games.get(id)!.state.time;
    expect(time).toBeGreaterThan(1000);
    await a.app.close(); // SIGTERM → instantané + libération du bail

    const [row] = await sqlQuery(
      (sql) => sql`SELECT lease_owner, status, last_order_seq,
        (SELECT max(seq)::int FROM game_snapshots WHERE game_id = ${id}) AS snap
        FROM games WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ lease_owner: null, status: 'paused', last_order_seq: 2, snap: 2 });

    const b = await startApp({ dataDir, instanceId: 'inst-2' });
    try {
      expect(b.ctx.host.games.has(id)).toBe(true); // adoptée au démarrage
      expect(hashOf(b, id)).toBe(hash);
      expect(b.ctx.host.games.get(id)!.state.time).toBe(time);
      const port = await listen(b.app);
      const ws = await WsClient.connect(port, id, p.cookie);
      const w = await ws.next('welcome');
      expect(w.clock.paused).toBe(true);
      expect(w.view.units['fra-1']!.stance).toBe('aggressive');
      expect(w.view.units['fra-1']!.move).toBeDefined();
      await ws.close();
    } finally {
      await b.app.close();
    }
  });

  it('reprise après un arrêt brutal : instantané initial + rejeu du journal ⇒ même état', async () => {
    const a = await startApp({ dataDir, instanceId: 'inst-1' });
    const p = await guest(a.app);
    const id = await createGame(a.app, p.cookie);
    await playAndPause(a, p.cookie, id);
    const hash = hashOf(a, id);
    await Promise.all([...a.ctx.host.games.values()].map((g) => g.writes));
    // « Crash » : ni instantané final, ni libération du bail.
    await a.ctx.host.stop({ snapshot: false, release: false });
    await a.app.close();

    const [snaps] = await sqlQuery(
      (sql) => sql`SELECT count(*)::int AS n FROM game_snapshots WHERE game_id = ${id}`,
    );
    expect(snaps!.n).toBe(1); // seulement l'instantané de création
    const orders = await sqlQuery(
      (sql) => sql`SELECT seq FROM game_orders WHERE game_id = ${id} ORDER BY seq`,
    );
    expect(orders.map((o) => o.seq)).toEqual([1, 2]);

    // Même identifiant d'instance (redémarrage du même processus) : le bail est repris tout de suite.
    const b = await startApp({ dataDir, instanceId: 'inst-1' });
    try {
      expect(hashOf(b, id)).toBe(hash);
    } finally {
      await b.app.close();
    }
  });

  it("rattrape le temps écoulé pendant l'arrêt d'une partie en cours", async () => {
    const a = await startApp({ dataDir, instanceId: 'inst-1' });
    const p = await guest(a.app);
    const id = await createGame(a.app, p.cookie, { nationId: 'fra', speed: 1000 });
    await sleep(50);
    await a.app.close();
    const [row] = await sqlQuery((sql) => sql`SELECT game_time_ms FROM games WHERE id = ${id}`);
    await sleep(300);
    const b = await startApp({ dataDir, instanceId: 'inst-2' });
    try {
      const t = b.ctx.host.games.get(id)!.state.time;
      expect(t).toBeGreaterThan(Number(row!.game_time_ms) + 250_000);
    } finally {
      await b.app.close();
    }
  });

  it('bail : une seule instance simule une partie ; reprise après expiration ; perte détectée', async () => {
    const a = await startApp({ dataDir, instanceId: 'inst-a' });
    const b = await startApp({ dataDir, instanceId: 'inst-b' });
    try {
      const p = await guest(a.app);
      const id = await createGame(a.app, p.cookie);
      expect(a.ctx.host.games.has(id)).toBe(true);

      // B ne peut ni adopter ni servir la partie tant que A détient le bail.
      await b.ctx.host.beat();
      expect(b.ctx.host.games.has(id)).toBe(false);
      expect(await b.ctx.host.ensureLoaded(id)).toBeNull();
      const portB = await listen(b.app);
      const wsB = await WsClient.connect(portB, id, p.cookie);
      await wsB.next('error', (m) => m.code === 'game_unavailable');
      await sleep(50);
      expect(wsB.closeCode).toBe(1013);

      // A est connecté à un joueur ; son bail expire (A « gelé ») et B l'adopte.
      const portA = await listen(a.app);
      const wsA = await WsClient.connect(portA, id, p.cookie);
      await wsA.next('welcome');
      await a.ctx.host.snapshot(a.ctx.host.games.get(id)!, true);
      await sqlQuery(
        (sql) => sql`UPDATE games SET lease_until = now() - interval '1 second' WHERE id = ${id}`,
      );
      await b.ctx.host.beat();
      expect(b.ctx.host.games.has(id)).toBe(true);
      const [row] = await sqlQuery((sql) => sql`SELECT lease_owner FROM games WHERE id = ${id}`);
      expect(row!.lease_owner).toBe('inst-b');

      // Au battement suivant, A constate la perte du bail et coupe ses joueurs (ils se reconnecteront).
      await a.ctx.host.beat();
      expect(a.ctx.host.games.has(id)).toBe(false);
      await wsA.next('error', (m) => m.code === 'game_moved');

      // Les écritures de A sont refusées (fencing) : l'instantané n'est pas inséré.
      const wsB2 = await WsClient.connect(portB, id, p.cookie);
      await wsB2.next('welcome');
      await wsB2.close();
    } finally {
      await a.app.close();
      await b.app.close();
    }
  });

  it('instantanés périodiques des parties modifiées (SNAPSHOT_INTERVAL_S)', async () => {
    const a = await startApp({ dataDir, env: { SNAPSHOT_INTERVAL_S: '0.3' } });
    try {
      const p = await guest(a.app);
      const id = await createGame(a.app, p.cookie);
      await sleep(1100);
      const [r] = await sqlQuery(
        (sql) =>
          sql`SELECT max(seq)::int AS last, count(*)::int AS n FROM game_snapshots WHERE game_id = ${id}`,
      );
      expect(r!.last).toBeGreaterThanOrEqual(3);
      expect(r!.n).toBeLessThanOrEqual(3); // on ne garde que les 3 derniers
    } finally {
      await a.app.close();
    }
  });
});
