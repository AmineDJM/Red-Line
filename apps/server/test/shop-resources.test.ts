import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import {
  api,
  createGame,
  dbAvailable,
  guest,
  login,
  makeDataDir,
  register,
  resetDb,
  sqlQuery,
  startApp,
} from './helpers.js';
import { fakeState } from './fake-engine.js';

const hasDb = await dbAvailable();
const ADMIN = { ADMIN_EMAIL: 'admin@redline.test', ADMIN_PASSWORD: 'motdepasse-admin' };

const credit = (userId: string, amount: number) =>
  sqlQuery((sql) => sql`UPDATE users SET premium_balance = ${amount} WHERE id = ${userId}`);

describe.skipIf(!hasDb)('boutique : ressources en jeu', () => {
  let built: BuiltApp;
  let admin: string;
  let buyer: { cookie: string; userId: string };
  const dataDir = makeDataDir();

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir, env: ADMIN, instanceId: 'res-1' });
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
    buyer = await register(built.app, 'ressources@redline.test', 'Intendant');
  });
  afterAll(async () => {
    await built?.app.close();
  });

  const balanceOf = async (cookie: string) =>
    (await api(built.app, cookie)('GET', '/api/shop/wallet')).json().balance as number;
  const buy = (cookie: string, gameId: string, offerId: string) =>
    api(built.app, cookie)('POST', `/api/games/${gameId}/shop/resources`, { offerId });

  it('offres publiques (config initiale), triées', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/shop/resources' });
    expect(res.statusCode).toBe(200);
    const offers = res.json().offers as { id: string; money: number; resources: object }[];
    expect(offers.map((o) => o.id).slice(0, 3)).toEqual(['res-credit', 'res-loan', 'res-fund']);
    expect(offers.find((o) => o.id === 'res-oil')).toMatchObject({
      money: 0,
      resources: { oil: 200 },
      price: 40,
    });
  });

  it('achat : débit en transaction, commande grant journalisée, solde après achat', async () => {
    await credit(buyer.userId, 500);
    const solo = await createGame(built.app, buyer.cookie, { nationId: 'fra' });
    const r = await buy(buyer.cookie, solo, 'res-logistics');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      ok: true,
      cost: 120,
      balance: 380,
      granted: { money: 0, resources: { oil: 150, metals: 150, electronics: 75, food: 200 } },
    });
    const g = built.ctx.host.games.get(solo)!;
    expect(fakeState(g.state).sys.at(-1)).toEqual({
      kind: 'grant',
      nationId: 'fra',
      resources: { oil: 150, metals: 150, electronics: 75, food: 200 },
    });
    const m = await buy(buyer.cookie, solo, 'res-credit');
    expect(m.json()).toMatchObject({ cost: 50, balance: 330, granted: { money: 500_000_000 } });
    expect(fakeState(g.state).sys.at(-1)).toEqual({
      kind: 'grant',
      nationId: 'fra',
      money: 500_000_000,
    });
    const wallet = (await api(built.app, buyer.cookie)('GET', '/api/shop/wallet')).json();
    expect(wallet.history.slice(0, 2)).toEqual([
      expect.objectContaining({ delta: -50, reason: 'resources', ref: 'res-credit' }),
      expect.objectContaining({ delta: -120, reason: 'resources', ref: 'res-logistics' }),
    ]);
    await g.writes;
    const rows = await sqlQuery(
      (sql) =>
        sql`SELECT payload FROM game_orders WHERE game_id = ${solo} AND player_slot = -1 ORDER BY seq`,
    );
    expect(rows.map((x) => x.payload)).toEqual([
      {
        sys: {
          kind: 'grant',
          nationId: 'fra',
          resources: { oil: 150, metals: 150, electronics: 75, food: 200 },
        },
      },
      { sys: { kind: 'grant', nationId: 'fra', money: 500_000_000 } },
    ]);
  });

  it('refus : solde insuffisant, offre inconnue ou inactive, non-membre, refus du moteur', async () => {
    const solo = await createGame(built.app, buyer.cookie, { nationId: 'usa' });
    expect((await buy(buyer.cookie, solo, 'nope')).statusCode).toBe(404);
    const poor = await guest(built.app);
    const poorGame = await createGame(built.app, poor.cookie, { nationId: 'dza' });
    expect((await buy(poor.cookie, poorGame, 'res-oil')).statusCode).toBe(402);
    expect((await buy(poor.cookie, solo, 'res-oil')).statusCode).toBe(404);

    // Offre administrée : création, désactivation ; montant refusé par le (faux) moteur.
    const reqAdmin = api(built.app, admin);
    expect(
      (
        await reqAdmin('POST', '/admin/api/shop/resources', {
          id: 'res-test',
          name: 'Témoin',
          money: 13,
          price: 5,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await reqAdmin('POST', '/admin/api/shop/resources', { id: 'vide', name: 'Vide', price: 5 }))
        .statusCode,
    ).toBe(400);
    const before = await balanceOf(buyer.cookie);
    const refused = await buy(buyer.cookie, solo, 'res-test');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('grant_refused');
    expect(await balanceOf(buyer.cookie)).toBe(before);
    await reqAdmin('PUT', '/admin/api/shop/resources/res-test', {
      name: 'Témoin',
      money: 13,
      price: 5,
      active: false,
    });
    expect((await buy(buyer.cookie, solo, 'res-test')).statusCode).toBe(404);
    const list = (await reqAdmin('GET', '/admin/api/shop/resources')).json().offers;
    expect(list.find((o: { id: string }) => o.id === 'res-test')).toMatchObject({ active: false });
    expect(
      (await api(built.app, buyer.cookie)('GET', '/admin/api/shop/resources')).statusCode,
    ).toBe(403);
    const audit = (await reqAdmin('GET', '/admin/api/audit')).json().entries;
    expect(audit.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['shop.resources.create', 'shop.resources.update']),
    );
  });

  it('politique de la partie : plafond commun aux accélérations, boutique désactivée', async () => {
    await credit(buyer.userId, 1000);
    const req = api(built.app, buyer.cookie);
    const limited = (
      await req('POST', '/api/lobby', {
        name: 'Plafonnée',
        nationId: 'dza',
        maxPlayers: 1,
        shopPolicy: { mode: 'limited', capPerPlayer: 100 },
      })
    ).json().game.id;
    const first = await buy(buyer.cookie, limited, 'res-oil');
    expect(first.json()).toMatchObject({ ok: true, cost: 40, spent: 40, cap: 100 });
    // Accélération de 20 (10 h) : 60 dépensés ; une seconde cargaison dépasserait le plafond.
    const acc = await req('POST', `/api/games/${limited}/accelerate`, {
      target: { type: 'production', id: 'prod-1' },
      hours: 10,
    });
    expect(acc.statusCode).toBe(200);
    expect((await buy(buyer.cookie, limited, 'res-oil')).statusCode).toBe(200);
    const capped = await buy(buyer.cookie, limited, 'res-food');
    expect(capped.statusCode).toBe(403);
    expect(capped.json().error).toBe('cap_reached');

    const disabled = (
      await req('POST', '/api/lobby', {
        name: 'Compétitive',
        nationId: 'usa',
        maxPlayers: 1,
        shopPolicy: { mode: 'disabled' },
      })
    ).json().game.id;
    const off = await buy(buyer.cookie, disabled, 'res-oil');
    expect(off.statusCode).toBe(403);
    expect(off.json().error).toBe('shop_disabled');
  });

  it('compte illimité : gratuit, même boutique désactivée, sans débit', async () => {
    const reqAdmin = api(built.app, admin);
    const disabled = (
      await reqAdmin('POST', '/api/lobby', {
        name: 'Essais',
        nationId: 'fra',
        maxPlayers: 1,
        shopPolicy: { mode: 'disabled' },
      })
    ).json().game.id;
    const r = await buy(admin, disabled, 'res-fund');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, cost: 0, unlimited: true });
    const g = built.ctx.host.games.get(disabled)!;
    expect(fakeState(g.state).sys.at(-1)).toMatchObject({ kind: 'grant', money: 10_000_000_000 });
    const [n] = await sqlQuery(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM wallet_ledger WHERE game_id = ${disabled} AND reason = 'resources'`,
    );
    expect(n!.n).toBe(0);
  });

  it('reprise après arrêt brutal : la dotation est rejouée depuis le journal', async () => {
    await credit(buyer.userId, 100);
    const id = await createGame(built.app, buyer.cookie, { nationId: 'fra' });
    expect((await buy(buyer.cookie, id, 'res-food')).statusCode).toBe(200);
    await Promise.all([...built.ctx.host.games.values()].map((x) => x.writes));
    await built.ctx.host.stop({ snapshot: false, release: false });
    await built.app.close();

    built = await startApp({ dataDir, env: ADMIN, instanceId: 'res-1' });
    const again = await built.ctx.host.ensureLoaded(id);
    expect(again).not.toBeNull();
    // Instantané de création + rejeu du journal : la dotation est appliquée une seule fois.
    expect(fakeState(again!.state).sys.filter((c) => c.kind === 'grant')).toEqual([
      { kind: 'grant', nationId: 'fra', resources: { food: 300 } },
    ]);
  });
});
