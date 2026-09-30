import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import type { PushSender } from '../src/push/push.js';
import { DAY_MS } from '../src/host/game-host.js';
import {
  WsClient,
  api,
  dbAvailable,
  guest,
  listen,
  login,
  makeDataDir,
  register,
  resetDb,
  sleep,
  sqlQuery,
  startApp,
  until,
} from './helpers.js';
import { createFakeEngine, fakeState, fakeStats } from './fake-engine.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

/** Données supplémentaires : recherche, ORBAT, scénario, photos. */
function extraData(dir: string): void {
  const w = (rel: string, v: unknown) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(v));
  };
  w('research/aero.json', {
    nodes: [
      {
        id: 'research.aero.gen4',
        name: 'Chasseurs de 4e génération',
        branch: 'aero',
        tier: 4,
        cost: { money: 1000 },
        durationH: 48,
      },
    ],
  });
  w('research/broken.json', { nodes: [{ id: 'pas-un-id' }] });
  w('orbat/2025/fra.json', {
    nationId: 'fra',
    year: 2025,
    doctrine: 'eu',
    defenseBudgetUsd: 64e9,
    activePersonnel: 200000,
    description: 'Puissance nucléaire européenne.',
    doctrineText: 'Projection et dissuasion.',
    inventory: [
      { systemId: 'eu.test-inf', count: 100 },
      { systemId: 'eu.test-tank', count: 200 },
    ],
    research: ['research.aero.gen4'],
  });
  w('scenarios/world-today.json', {
    id: 'world-today',
    name: 'Le monde aujourd’hui',
    description: 'Test',
    playableNations: 'all',
  });
  w('art/photos.json', {
    'eu.test-tank': {
      file: '/art/photos/eu.test-tank.webp',
      credit: 'Photographe',
      license: 'CC BY-SA 4.0',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:x.jpg',
    },
  });
}

describe.skipIf(!hasDb)('multijoueur : lobby, messagerie, spectateur, IA de remplacement', () => {
  let built: BuiltApp;
  let port: number;
  let admin: string;
  const dataDir = makeDataDir();
  extraData(dataDir);
  const pushes: { endpoint: string; payload: { category: string; body: string } }[] = [];
  const pushSender: PushSender = {
    async send(target, payload) {
      pushes.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  };

  let gameId = '';
  let A: { cookie: string; userId: string };
  let B: { cookie: string; userId: string };
  let wsA: WsClient;
  let wsB: WsClient;

  beforeAll(async () => {
    await resetDb();
    built = await startApp({
      dataDir,
      env: ADMIN,
      pushSender,
      runtime: { chatBurst: 8, chatPerSecond: 0.5 },
    });
    port = await listen(built.app);
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await wsA?.close();
    await wsB?.close();
    await built?.app.close();
  });

  it('charge recherche, ORBAT, scénarios et photos (fichiers invalides ignorés) et les passe au moteur', async () => {
    const d = built.ctx.data;
    expect(d.research.map((n) => n.id)).toEqual(['research.aero.gen4']);
    expect(d.orbats['2025']!.map((o) => o.nationId)).toEqual(['fra']);
    expect(d.warnings.some((w) => w.includes('broken.json'))).toBe(true);
    expect(d.scenarios[0]).toMatchObject({ id: 'world-today', orbatSet: '2025', year: 2025 });

    const photos = await built.app.inject({ method: 'GET', url: '/api/art/photos' });
    expect(photos.json().photos['eu.test-tank']).toMatchObject({ license: 'CC BY-SA 4.0' });

    const info = (await built.app.inject({ method: 'GET', url: '/api/nations/info' })).json();
    const fra = info.nations.find((n: { id: string }) => n.id === 'fra');
    expect(fra).toMatchObject({
      name: 'France',
      description: 'Puissance nucléaire européenne.',
      doctrine: 'eu',
      defenseBudgetUsd: 64e9,
      activePersonnel: 200000,
      provinceCount: 2,
    });
    expect(fra.highlights[0]).toEqual({ systemId: 'eu.test-tank', count: 200 });
    // Nation sans ORBAT : fiche minimale, sans erreur.
    expect(info.nations.find((n: { id: string }) => n.id === 'usa')).toMatchObject({
      description: '',
      defenseBudgetUsd: 0,
      highlights: [],
    });
  });

  it('lobby à 2 joueurs : création, liste, refus, arrivée, démarrage automatique quand plein', async () => {
    A = await register(built.app, 'alice@redline.test', 'Alice');
    B = await register(built.app, 'bob@redline.test', 'Bob');
    const reqA = api(built.app, A.cookie);
    const reqB = api(built.app, B.cookie);

    expect((await reqA('POST', '/api/lobby', { name: 'x', nationId: 'fra' })).statusCode).toBe(400);
    expect(
      (await reqA('POST', '/api/lobby', { name: 'Test', nationId: 'fra', speed: 3 })).statusCode,
    ).toBe(400);
    const created = await reqA('POST', '/api/lobby', {
      name: 'Guerre de test',
      nationId: 'fra',
      maxPlayers: 2,
      speed: 1000,
      shopPolicy: { mode: 'limited', capPerPlayer: 50 },
      inactiveAiAfterH: 12,
      aiLevel: 'hard',
    });
    expect(created.statusCode).toBe(201);
    const game = created.json().game;
    gameId = game.id;
    expect(game).toMatchObject({
      mode: 'multi',
      status: 'lobby',
      maxPlayers: 2,
      playerCount: 1,
      speeds: [1000],
      shopPolicy: { mode: 'limited', capPerPlayer: 50 },
    });

    const list = (await reqB('GET', '/api/lobby')).json().games;
    const mine = list.find((l: { game: { id: string } }) => l.game.id === gameId);
    expect(mine).toMatchObject({
      takenNations: ['fra'],
      takenBy: { fra: 'Alice' },
      creator: 'Alice',
      speed: 1000,
      scenarioName: 'Le monde aujourd’hui',
    });

    expect(
      (await reqB('POST', `/api/lobby/${gameId}/join`, { nationId: 'fra' })).json().error,
    ).toBe('nation_taken');
    expect((await reqB('POST', `/api/lobby/${gameId}/join`, { nationId: 'xyz' })).statusCode).toBe(
      400,
    );
    expect(
      (await reqA('POST', `/api/lobby/${gameId}/join`, { nationId: 'dza' })).json().error,
    ).toBe('already_joined');
    // Seul le créateur lance la partie.
    expect((await reqB('POST', `/api/lobby/${gameId}/start`)).statusCode).toBe(403);

    const joined = await reqB('POST', `/api/lobby/${gameId}/join`, { nationId: 'dza' });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().game).toMatchObject({ status: 'running', playerCount: 2 });
    const g = built.ctx.host.games.get(gameId)!;
    const s = fakeState(g.state);
    expect(s.players.sort()).toEqual(['dza', 'fra']);
    // Toutes les autres nations sont des IA actives.
    expect(s.ai).toEqual({ usa: true });
    // Le monde a reçu la recherche et les ORBAT ; la partie, le scénario, la vitesse et l'IA.
    const extras = fakeStats.lastExtras as {
      research: unknown[];
      orbats: Record<string, unknown[]>;
    };
    expect(extras.research).toHaveLength(1);
    expect(extras.orbats['2025']).toHaveLength(1);
    const [setupRow] = await sqlQuery((sql) => sql`SELECT setup FROM games WHERE id = ${gameId}`);
    expect(setupRow!.setup).toMatchObject({
      speed: 1000,
      scenarioId: 'world-today',
      players: expect.arrayContaining([{ nationId: 'usa', isAi: true, aiLevel: 'hard' }]),
    });
    expect((await reqA('POST', `/api/lobby/${gameId}/start`)).json().error).toBe('already_started');

    const games = (await reqA('GET', '/api/games')).json().games;
    expect(games[0]).toMatchObject({ nationId: 'fra', game: { id: gameId, mode: 'multi' } });

    wsA = await WsClient.connect(port, gameId, A.cookie);
    wsB = await WsClient.connect(port, gameId, B.cookie);
    expect((await wsA.next('welcome')).me).toBe('fra');
    expect((await wsB.next('welcome')).me).toBe('dza');
    await wsA.next('chatHistory');
    // Vitesse fixée à la création : pas de contrôle en multijoueur.
    wsA.send({ t: 'control', speed: 1 });
    expect((await wsA.next('error', (m) => m.code === 'not_allowed')).message).toContain('solo');
  });

  it('quitter le salon : le créateur passe la main, la partie vide est supprimée', async () => {
    const C = await guest(built.app);
    const D = await guest(built.app);
    const id = (
      await api(built.app, C.cookie)('POST', '/api/lobby', {
        name: 'Salon',
        nationId: 'usa',
        maxPlayers: 3,
      })
    ).json().game.id;
    await api(built.app, D.cookie)('POST', `/api/lobby/${id}/join`, { nationId: 'fra' });
    expect((await api(built.app, C.cookie)('POST', `/api/lobby/${id}/leave`)).statusCode).toBe(200);
    const [row] = await sqlQuery((sql) => sql`SELECT created_by FROM games WHERE id = ${id}`);
    expect(row!.created_by).toBe(D.userId);
    await api(built.app, D.cookie)('POST', `/api/lobby/${id}/leave`);
    const rows = await sqlQuery((sql) => sql`SELECT id FROM games WHERE id = ${id}`);
    expect(rows).toHaveLength(0);
  });

  it('messagerie : salon, privé, alliance (vue diplomatie), filtre, débit, historique', async () => {
    wsA.send({ t: 'chat', channel: 'game', text: 'Bonjour à tous' });
    const m1 = await wsB.next('chat', (m) => m.message.text === 'Bonjour à tous');
    expect(m1.message).toMatchObject({
      channel: 'game',
      from: { userId: A.userId, nationId: 'fra', name: 'Alice' },
    });

    wsB.send({ t: 'chat', channel: 'private', to: 'fra', text: 'Message secret' });
    const m2 = await wsA.next('chat', (m) => m.message.text === 'Message secret');
    expect(m2.message.channel).toBe('private:dza|fra');
    wsB.send({ t: 'chat', channel: 'private', to: 'usa', text: 'IA ?' });
    expect((await wsB.next('error', (m) => m.code === 'chat_bad_recipient')).code).toBeTruthy();

    wsA.send({ t: 'chat', channel: 'alliance', text: 'Alliés ?' });
    await wsA.next('error', (m) => m.code === 'chat_no_alliance');
    wsA.send({
      t: 'order',
      id: 1,
      order: {
        kind: 'createAlliance',
        name: 'Axe',
        flag: 'A',
        charter: { mutualDefense: true, intelSharing: true, passage: true },
      },
    });
    await wsA.next('orderResult', (m) => m.id === 1 && m.ok);
    wsA.send({ t: 'order', id: 2, order: { kind: 'inviteToAlliance', nationId: 'dza' } });
    await wsA.next('orderResult', (m) => m.id === 2 && m.ok);
    await wsB.next('diff', (m) => !!m.diff.diplomacy?.myAllianceId);
    wsA.send({ t: 'chat', channel: 'alliance', text: 'Pour l’alliance' });
    const m3 = await wsB.next('chat', (m) => m.message.text === 'Pour l’alliance');
    expect(m3.message.channel).toMatch(/^alliance:a\d+$/);

    wsA.send({ t: 'chat', channel: 'game', text: 'espèce de connard' });
    const m4 = await wsB.next('chat', (m) => m.message.text.startsWith('espèce'));
    expect(m4.message.text).toBe('espèce de *******');

    // Anti-flood : message identique, puis débit.
    wsA.send({ t: 'chat', channel: 'game', text: 'espèce de connard' });
    await wsA.next('error', (m) => m.code === 'chat_duplicate' || m.code === 'chat_rate_limited');
    for (let i = 0; i < 10; i++) wsA.send({ t: 'chat', channel: 'game', text: `flood ${i}` });
    await wsA.next('error', (m) => m.code === 'chat_rate_limited');

    const ws2 = await WsClient.connect(port, gameId, B.cookie);
    const hist = await ws2.next('chatHistory');
    const texts = hist.messages.map((m) => m.text);
    expect(texts).toEqual(
      expect.arrayContaining(['Bonjour à tous', 'Message secret', 'Pour l’alliance']),
    );
    await ws2.close();
    wsB.send({ t: 'chatRead', channel: 'game', upTo: m1.message.id });
    await until(
      async () =>
        (await sqlQuery((sql) => sql`SELECT up_to FROM chat_reads WHERE game_id = ${gameId}`))
          .length === 1,
      'accusé de lecture',
    );
  });

  it('modération : masquage rediffusé, texte visible par la modération, sourdine', async () => {
    const reqAdmin = api(built.app, admin);
    expect(
      (await api(built.app, A.cookie)('GET', `/admin/api/chat?gameId=${gameId}`)).statusCode,
    ).toBe(403);
    const list = (await reqAdmin('GET', `/admin/api/chat?gameId=${gameId}&q=Bonjour`)).json()
      .messages;
    expect(list).toHaveLength(1);
    const res = await reqAdmin('POST', `/admin/api/chat/${list[0].id}/hide`, {});
    expect(res.statusCode).toBe(200);
    const hidden = await wsB.next('chat', (m) => m.message.id === list[0].id && !!m.message.hidden);
    expect(hidden.message.text).toBe('');
    const again = (await reqAdmin('GET', `/admin/api/chat?gameId=${gameId}&q=Bonjour`)).json()
      .messages[0];
    expect(again).toMatchObject({ hidden: true, text: 'Bonjour à tous' });

    await reqAdmin('POST', '/admin/api/chat/mute', { userId: A.userId, hours: 1 });
    await sleep(2100); // recharge du seau de débit
    wsA.send({ t: 'chat', channel: 'game', text: 'Je suis muet ?' });
    await wsA.next('error', (m) => m.code === 'chat_muted');
    await reqAdmin('POST', '/admin/api/chat/mute', { userId: A.userId, hours: 0 });
  });

  it('spectateur : vue publique sans secrets, lecture seule, parties privées refusées', async () => {
    const C = await guest(built.app);
    const res = await api(built.app, C.cookie)('GET', `/api/games/${gameId}/spectate`);
    expect(res.statusCode).toBe(200);
    expect(res.json().game).toMatchObject({ id: gameId, spectator: true });

    await expect(WsClient.connect(port, gameId, C.cookie)).rejects.toThrow('HTTP 403');
    const ws = await WsClient.connect(port, `${gameId}&spectate=1`, C.cookie);
    try {
      const welcome = await ws.next('welcome');
      expect(welcome.me).toBe('');
      expect(welcome.game.spectator).toBe(true);
      expect(welcome.view.spectator).toBe(true);
      expect(welcome.view.units.secret).toBeUndefined();
      expect(welcome.view.economy.money).toBe(0);
      ws.send({ t: 'order', id: 9, order: { kind: 'stop', unitIds: ['fra-1'] } });
      expect(await ws.next('orderResult', (m) => m.id === 9)).toMatchObject({
        ok: false,
        error: 'not_allowed',
      });
      ws.send({ t: 'chat', channel: 'game', text: 'coucou' });
      await ws.next('error', (m) => m.code === 'read_only');
      // Les joueurs discutent : le spectateur ne reçoit rien.
      wsB.send({ t: 'chat', channel: 'game', text: 'entre joueurs' });
      await wsA.next('chat', (m) => m.message.text === 'entre joueurs');
      await sleep(300); // nombreuses patrouilles de l'unité secrète à la vitesse 1000
      expect(ws.messages.some((m) => m.t === 'chat' || m.t === 'chatHistory')).toBe(false);
      for (const raw of ws.raw) expect(raw.includes(Buffer.from('secret'))).toBe(false);
    } finally {
      await ws.close();
    }

    // Partie privée : pas de spectateur (sauf modération).
    const P = await guest(built.app);
    const priv = (
      await api(built.app, P.cookie)('POST', '/api/lobby', {
        name: 'Privée',
        nationId: 'usa',
        maxPlayers: 1,
        private: true,
      })
    ).json().game;
    expect(priv.status).toBe('running');
    expect(
      (await api(built.app, C.cookie)('GET', `/api/games/${priv.id}/spectate`)).statusCode,
    ).toBe(403);
    expect((await api(built.app, admin)('GET', `/api/games/${priv.id}/spectate`)).statusCode).toBe(
      200,
    );
    const lobbyIds = (await api(built.app, C.cookie)('GET', '/api/lobby'))
      .json()
      .games.map((l: { game: { id: string } }) => l.game.id);
    expect(lobbyIds).not.toContain(priv.id);
  });

  it("remplacement d'un joueur inactif par une IA, puis retour du joueur", async () => {
    const host = built.ctx.host;
    const g = host.games.get(gameId)!;
    await wsB.close();
    await until(() => !host.isConnected(g, B.userId), 'déconnexion de B');
    expect(await host.checkInactive(Date.now() + 11 * 3600_000)).toBe(0);
    expect(await host.checkInactive(Date.now() + 13 * 3600_000)).toBe(1);
    expect(fakeState(g.state).ai.dza).toBe(true);
    const n = await wsA.next('notice', (m) => m.text.includes('IA'));
    expect(n.text).toContain('Algérie');
    await host.settle(gameId);
    const [row] = await sqlQuery(
      (sql) =>
        sql`SELECT is_ai_replacement FROM game_players WHERE game_id = ${gameId} AND nation_id = 'dza'`,
    );
    expect(row!.is_ai_replacement).toBe(true);
    // Commande système journalisée (rejouée à la reprise).
    const sys = await sqlQuery(
      (sql) =>
        sql`SELECT payload FROM game_orders WHERE game_id = ${gameId} AND player_slot = -1 ORDER BY seq`,
    );
    expect(sys.at(-1)!.payload).toMatchObject({
      sys: { kind: 'setAi', nationId: 'dza', isAi: true },
    });

    wsB = await WsClient.connect(port, gameId, B.cookie);
    await wsB.next('welcome');
    expect(fakeState(g.state).ai.dza).toBe(false);
    await wsA.next('notice', (m) => m.text.includes('repris'));
  });

  it('notifications Web Push : clé VAPID, abonnement, alerte de capture au joueur absent', async () => {
    const key = (await built.app.inject({ method: 'GET', url: '/api/push/key' })).json();
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const [stored] = await sqlQuery(
      (sql) => sql`SELECT value FROM server_settings WHERE key = 'vapid'`,
    );
    expect((stored!.value as { publicKey: string }).publicKey).toBe(key.publicKey);

    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/bob',
      keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) },
    };
    expect((await api(built.app, B.cookie)('POST', '/api/push/subscribe', sub)).statusCode).toBe(
      200,
    );
    // Bob connecté : pas d'alerte.
    wsA.send({ t: 'order', id: 20, order: { kind: 'declareWar', nationId: 'usa' } });
    await wsA.next('orderResult', (m) => m.id === 20);
    await sleep(100);
    expect(pushes).toHaveLength(0);
    // Bob déconnecté : alerte de capture.
    await wsB.close();
    const g = built.ctx.host.games.get(gameId)!;
    await until(() => !built.ctx.host.isConnected(g, B.userId), 'déconnexion');
    wsA.send({ t: 'order', id: 21, order: { kind: 'declareWar', nationId: 'dza' } });
    await wsA.next('orderResult', (m) => m.id === 21);
    const p = await until(() => pushes.find((x) => x.payload.category === 'capture'), 'push');
    expect(p.endpoint).toBe(sub.endpoint);
    expect(p.payload.body).toContain('France');

    expect((await api(built.app, B.cookie)('DELETE', '/api/push/subscribe', {})).statusCode).toBe(
      200,
    );
    const left = await sqlQuery((sql) => sql`SELECT id FROM push_subscriptions`);
    expect(left).toHaveLength(0);
  });

  it("quitter une partie en cours : l'IA prend la nation, qui redevient libre", async () => {
    const reqB = api(built.app, B.cookie);
    expect((await reqB('POST', `/api/lobby/${gameId}/leave`)).statusCode).toBe(200);
    const g = built.ctx.host.games.get(gameId)!;
    expect(fakeState(g.state).ai.dza).toBe(true);
    expect(g.meta.playerCount).toBe(1);
    // Un nouveau joueur reprend l'Algérie en cours de partie.
    const E = await guest(built.app);
    const res = await api(built.app, E.cookie)('POST', `/api/lobby/${gameId}/join`, {
      nationId: 'dza',
    });
    expect(res.statusCode).toBe(200);
    expect(fakeState(g.state).ai.dza).toBe(false);
    expect(fakeState(g.state).sys.at(-1)).toEqual({ kind: 'addPlayer', nationId: 'dza' });
    const ws = await WsClient.connect(port, gameId, E.cookie);
    expect((await ws.next('welcome')).me).toBe('dza');
    await ws.close();
  });
});

describe.skipIf(!hasDb)('fin de partie : statistiques, timelapse, classements, rapports', () => {
  let built: BuiltApp;
  let port: number;
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir, engine: createFakeEngine({ patrol: false }) });
    port = await listen(built.app);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('partie classée à 2 joueurs jusqu’à la victoire', async () => {
    const E = await register(built.app, 'eve@redline.test', 'Eve');
    const F = await register(built.app, 'fred@redline.test', 'Fred');
    const id = (
      await api(built.app, E.cookie)('POST', '/api/lobby', {
        name: 'Classée',
        nationId: 'fra',
        maxPlayers: 2,
        speed: 1000,
      })
    ).json().game.id;
    await api(built.app, F.cookie)('POST', `/api/lobby/${id}/join`, { nationId: 'dza' });
    const host = built.ctx.host;
    const g = host.games.get(id)!;
    const ws = await WsClient.connect(port, id, E.cookie);
    await ws.next('welcome');

    // Statistiques secrètes tant que la partie dure.
    expect((await api(built.app, E.cookie)('GET', `/api/games/${id}/stats`)).statusCode).toBe(409);
    // Rapports de bataille détaillés.
    expect(
      (await api(built.app, E.cookie)('GET', `/api/games/${id}/battle-reports/r1`)).json().report,
    ).toMatchObject({ id: 'r1', title: 'Bataille de test' });
    expect(
      (await api(built.app, E.cookie)('GET', `/api/games/${id}/battle-reports/r2`)).statusCode,
    ).toBe(404);
    const stranger = await guest(built.app);
    expect(
      (await api(built.app, stranger.cookie)('GET', `/api/games/${id}/battle-reports/r1`))
        .statusCode,
    ).toBe(404);

    ws.send({ t: 'order', id: 1, order: { kind: 'declareWar', nationId: 'dza' } });
    await ws.next('orderResult', (m) => m.id === 1 && m.ok);
    await ws.next('notify', (m) => m.items.some((n) => n.kind === 'province_captured'));
    // Un jour de jeu plus tard (horloge avancée) : nouvelle image du timelapse.
    g.clock = { ...g.clock, anchorGame: g.clock.anchorGame + DAY_MS };
    ws.send({ t: 'order', id: 2, order: { kind: 'mobilize', on: true } });
    await ws.next('orderResult', (m) => m.id === 2 && m.ok);
    await until(() => g.meta.status === 'ended', 'fin de partie');
    await host.settle(id);

    const stats = (await api(built.app, F.cookie)('GET', `/api/games/${id}/stats`)).json();
    expect(stats.winner).toBe('fra');
    expect(stats.durationDays).toBe(1);
    expect(stats.nations[0]).toMatchObject({
      nationId: 'fra',
      player: 'Eve',
      conquered: 1,
      provincesEnd: 3,
    });

    const tl = (await api(built.app, F.cookie)('GET', `/api/games/${id}/timelapse`)).json();
    expect(tl.frames.map((f: { day: number }) => f.day)).toEqual([0, 1]);
    expect(tl.frames[0].owners['dza-1']).toBe('dza');
    expect(tl.frames[1].owners['dza-1']).toBe('fra');
    expect(tl.frames[1].owners['usa-1']).toBe('usa');
    const compact = await sqlQuery(
      (sql) => sql`SELECT day, delta FROM timelapse_frames WHERE game_id = ${id} ORDER BY day`,
    );
    expect(compact[1]!.delta).toEqual({ 'dza-1': 'fra' });

    const rk = (await built.app.inject({ method: 'GET', url: '/api/rankings' })).json();
    expect(rk.season).toMatchObject({ id: 's1', name: 'Saison 1' });
    expect(rk.entries).toEqual([
      expect.objectContaining({ rank: 1, name: 'Eve', points: 112, wins: 1, games: 1 }),
      expect.objectContaining({ rank: 2, name: 'Fred', points: 10, wins: 0, games: 1 }),
    ]);
    const seasons = (await built.app.inject({ method: 'GET', url: '/api/seasons' })).json();
    expect(seasons.seasons).toHaveLength(1);

    // Clôture de saison : récompenses cosmétiques, nouvelle saison.
    expect(await built.ctx.rankings.close('s1')).toBe(true);
    expect(await built.ctx.rankings.close('s1')).toBe(false);
    const cos = (await api(built.app, E.cookie)('GET', '/api/shop/cosmetics')).json();
    expect(cos.owned).toEqual(expect.arrayContaining(['season.theme.command']));
    const cosF = (await api(built.app, F.cookie)('GET', '/api/shop/cosmetics')).json();
    expect(cosF.owned).toEqual(
      expect.arrayContaining(['season.skin.veteran', 'season.flag.laurel']),
    );
    expect(cosF.owned).not.toContain('season.theme.command');
    await ws.close();
  });

  it('solo : aucun point de classement', async () => {
    const S = await guest(built.app);
    const res = await api(built.app, S.cookie)('POST', '/api/games', {
      nationId: 'usa',
      speed: 1000,
    });
    const id = res.json().game.id;
    const ws = await WsClient.connect(port, id, S.cookie);
    await ws.next('welcome');
    ws.send({ t: 'order', id: 1, order: { kind: 'mobilize', on: true } });
    const g = built.ctx.host.games.get(id)!;
    await until(() => g.meta.status === 'ended', 'fin de partie solo');
    await built.ctx.host.settle(id);
    const [r] = await sqlQuery(
      (sql) => sql`SELECT points, season_id FROM game_results WHERE game_id = ${id}`,
    );
    expect(r).toMatchObject({ points: 0, season_id: null });
    await ws.close();
  });
});

describe.skipIf(!hasDb)('reprise : les commandes système sont rejouées', () => {
  it('addPlayer et setAi rejoués après un arrêt brutal', async () => {
    await resetDb();
    const dataDir = makeDataDir();
    const engine = createFakeEngine({ patrol: false });
    const a = await startApp({ dataDir, engine, instanceId: 'crash-a' });
    const U = await guest(a.app);
    const V = await guest(a.app);
    const id = (
      await api(a.app, U.cookie)('POST', '/api/lobby', {
        name: 'Reprise',
        nationId: 'fra',
        maxPlayers: 3,
      })
    ).json().game.id;
    await api(a.app, V.cookie)('POST', `/api/lobby/${id}/join`, { nationId: 'dza' });
    await api(a.app, U.cookie)('POST', `/api/lobby/${id}/start`);
    const W = await guest(a.app);
    await api(a.app, W.cookie)('POST', `/api/lobby/${id}/join`, { nationId: 'usa' });
    await a.ctx.host.checkInactive(Date.now() + 25 * 3600_000);
    const before = fakeState(a.ctx.host.games.get(id)!.state);
    expect(before.players).toContain('usa');
    await a.ctx.host.settle(id);
    // Arrêt sans instantané final : la reprise repart de l'instantané de création + journal.
    await a.ctx.host.stop({ snapshot: false, release: true });
    await a.app.close();

    const b = await startApp({ dataDir, engine, instanceId: 'crash-b' });
    try {
      const g = await b.ctx.host.ensureLoaded(id);
      const after = fakeState(g!.state);
      expect(after.players.sort()).toEqual(['dza', 'fra', 'usa']);
      expect(after.ai).toMatchObject({ fra: true, dza: true, usa: true });
      expect(after.sys.map((c) => c.kind)).toEqual(before.sys.map((c) => c.kind));
    } finally {
      await b.app.close();
    }
  });
});
