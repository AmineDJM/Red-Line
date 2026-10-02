import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.js';
import {
  stripeWebhookVerifier,
  type CheckoutRequest,
  type PaymentProvider,
} from '../src/shop/payments.js';
import {
  api,
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
const WHSEC = 'whsec_test_redline';
const stripe = new Stripe('sk_test_signature_only');

/** Faux client Stripe : Checkout et remboursements simulés, vérification de signature RÉELLE. */
function fakeStripe() {
  const checkouts: CheckoutRequest[] = [];
  const refunds: string[] = [];
  const provider: PaymentProvider = {
    async createCheckout(r) {
      checkouts.push(r);
      return {
        sessionId: `cs_test_${checkouts.length}`,
        url: `https://checkout.stripe.test/${checkouts.length}`,
      };
    },
    verifyWebhook: stripeWebhookVerifier(WHSEC),
    async refund(pi) {
      refunds.push(pi);
      return { id: `re_${refunds.length}` };
    },
  };
  return { provider, checkouts, refunds };
}

function signed(event: object, secret = WHSEC) {
  const payload = JSON.stringify(event);
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret }),
    },
  };
}

describe.skipIf(!hasDb)('boutique sans clés Stripe', () => {
  let built: BuiltApp;
  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir: makeDataDir(), payments: null });
  });
  afterAll(async () => {
    await built?.app.close();
  });

  it('affiche « paiements indisponibles » et refuse le paiement et les webhooks', async () => {
    const packs = (await built.app.inject({ method: 'GET', url: '/api/shop/packs' })).json();
    expect(packs).toMatchObject({ paymentsAvailable: false, message: 'Paiements indisponibles' });
    expect(packs.packs.length).toBeGreaterThan(0);
    const u = await register(built.app, 'sans@redline.test');
    const res = await api(built.app, u.cookie)('POST', '/api/shop/checkout', {
      packId: 'pack-recon',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: 'payments_unavailable',
      message: 'Paiements indisponibles',
    });
    const hook = await built.app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      ...signed({ id: 'evt_x' }),
    });
    expect(hook.statusCode).toBe(503);
  });
});

describe.skipIf(!hasDb)('boutique : Stripe Checkout, webhooks, portefeuille, accélérations', () => {
  let built: BuiltApp;
  let admin: string;
  const fake = fakeStripe();
  let buyer: { cookie: string; userId: string };
  let purchaseId = '';

  beforeAll(async () => {
    await resetDb();
    built = await startApp({ dataDir: makeDataDir(), env: ADMIN, payments: fake.provider });
    admin = await login(built.app, ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_PASSWORD);
  });
  afterAll(async () => {
    await built?.app.close();
  });

  const balanceOf = async (cookie: string) =>
    (await api(built.app, cookie)('GET', '/api/shop/wallet')).json().balance as number;

  it('packs et promotions (administration)', async () => {
    const reqAdmin = api(built.app, admin);
    const now = Date.now();
    const promo = await reqAdmin('POST', '/admin/api/shop/promotions', {
      packId: 'pack-brigade',
      label: 'Lancement',
      percentOff: 20,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3600_000).toISOString(),
    });
    expect(promo.statusCode).toBe(201);
    const packs = (await built.app.inject({ method: 'GET', url: '/api/shop/packs' })).json();
    expect(packs.paymentsAvailable).toBe(true);
    const brigade = packs.packs.find((p: { id: string }) => p.id === 'pack-brigade');
    expect(brigade).toMatchObject({ amount: 550, bonus: 50, priceCents: 799 });
    expect(brigade.promo).toMatchObject({ label: 'Lancement', percentOff: 20 });
    expect(packs.packs.find((p: { id: string }) => p.id === 'pack-recon').promo).toBeNull();

    // Pack créé et désactivé depuis l'administration.
    expect(
      (
        await reqAdmin('POST', '/admin/api/shop/packs', {
          id: 'pack-test',
          name: 'Test',
          amount: 10,
          priceCents: 100,
        })
      ).statusCode,
    ).toBe(201);
    await reqAdmin('PUT', '/admin/api/shop/packs/pack-test', {
      name: 'Test',
      amount: 10,
      priceCents: 100,
      active: false,
    });
    const ids = (await built.app.inject({ method: 'GET', url: '/api/shop/packs' }))
      .json()
      .packs.map((p: { id: string }) => p.id);
    expect(ids).not.toContain('pack-test');
  });

  it('paiement : compte requis, CGV et rétractation requises, puis session Checkout', async () => {
    const g = await guest(built.app);
    expect(
      (
        await api(built.app, g.cookie)('POST', '/api/shop/checkout', { packId: 'pack-brigade' })
      ).json().error,
    ).toBe('account_required');

    buyer = await register(built.app, 'acheteur@redline.test', 'Acheteur');
    const req = api(built.app, buyer.cookie);
    const refused = await req('POST', '/api/shop/checkout', { packId: 'pack-brigade' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: 'legal_required',
      needsAcceptance: [
        { id: 'cgv', version: 2 },
        { id: 'withdrawal', version: 2 },
      ],
    });
    await req('POST', '/api/legal/accept', {
      docs: [
        { id: 'cgv', version: 2 },
        { id: 'withdrawal', version: 2 },
      ],
    });
    expect((await req('POST', '/api/shop/checkout', { packId: 'nope' })).statusCode).toBe(404);
    const ok = await req('POST', '/api/shop/checkout', { packId: 'pack-brigade' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toBe('https://checkout.stripe.test/1');
    purchaseId = ok.json().purchaseId;
    expect(fake.checkouts[0]).toMatchObject({
      purchaseId,
      userId: buyer.userId,
      amountCents: 799,
      currency: 'eur',
      credits: 600,
    });
    // Le retour navigateur ne crédite rien.
    expect(await balanceOf(buyer.cookie)).toBe(0);
  });

  const completed = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: purchaseId,
        payment_status: 'paid',
        amount_total: 799,
        payment_intent: 'pi_test_1',
        ...extra,
      },
    },
  });

  it('webhook signé : invalide refusé, valide crédité, rejoué sans double crédit', async () => {
    const hook = (body: ReturnType<typeof signed>) =>
      built.app.inject({ method: 'POST', url: '/api/stripe/webhook', ...body });

    const bad = await hook(signed(completed('evt_1'), 'whsec_autre_secret'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_signature');
    const noSig = await built.app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      payload: JSON.stringify(completed('evt_1')),
      headers: { 'content-type': 'application/json' },
    });
    expect(noSig.statusCode).toBe(400);
    // Corps modifié après signature.
    const s = signed(completed('evt_1'));
    const tampered = await hook({ ...s, payload: s.payload.replace('799', '1') });
    expect(tampered.statusCode).toBe(400);
    expect(await balanceOf(buyer.cookie)).toBe(0);

    const ok = await hook(signed(completed('evt_1')));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ received: true, duplicate: false, handled: 'credited' });
    expect(await balanceOf(buyer.cookie)).toBe(600);

    const replay = await hook(signed(completed('evt_1')));
    expect(replay.json()).toMatchObject({ duplicate: true });
    const other = await hook(signed(completed('evt_2')));
    expect(other.json()).toMatchObject({ duplicate: false, handled: 'already_processed' });
    expect(await balanceOf(buyer.cookie)).toBe(600);

    const wallet = (await api(built.app, buyer.cookie)('GET', '/api/shop/wallet')).json();
    expect(wallet.history).toEqual([
      expect.objectContaining({ delta: 600, reason: 'purchase', ref: purchaseId }),
    ]);
    const [p] = await sqlQuery(
      (sql) => sql`SELECT status, payment_intent FROM purchases WHERE id = ${purchaseId}`,
    );
    expect(p).toMatchObject({ status: 'paid', payment_intent: 'pi_test_1' });
    const events = await sqlQuery((sql) => sql`SELECT id FROM stripe_events ORDER BY id`);
    expect(events.map((e) => e.id)).toEqual(['evt_1', 'evt_2']);
  });

  it('journal du portefeuille en ajout seul (déclencheur SQL)', async () => {
    await expect(sqlQuery((sql) => sql`UPDATE wallet_ledger SET delta = 999999`)).rejects.toThrow(
      /ajout seul/,
    );
    await expect(sqlQuery((sql) => sql`DELETE FROM wallet_ledger`)).rejects.toThrow(/ajout seul/);
  });

  it('accélérations selon la politique de la partie (ouverte, plafonnée, désactivée)', async () => {
    const req = api(built.app, buyer.cookie);
    const solo = (await req('POST', '/api/games', { nationId: 'fra' })).json().game.id;
    const acc = (id: string, hours: number, target = 'prod-1') =>
      req('POST', `/api/games/${id}/accelerate`, {
        target: { type: 'production', id: target },
        hours,
      });

    const r1 = await acc(solo, 10);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ok: true, cost: 20, balance: 580 });
    const g = built.ctx.host.games.get(solo)!;
    expect(fakeState(g.state).sys.at(-1)).toEqual({
      kind: 'accelerate',
      nationId: 'fra',
      target: { type: 'production', id: 'prod-1' },
      hours: 10,
    });
    // Refus du moteur : aucun débit.
    const r2 = await acc(solo, 1, 'inconnu');
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('accelerate_refused');
    expect(await balanceOf(buyer.cookie)).toBe(580);

    const limited = (
      await req('POST', '/api/lobby', {
        name: 'Plafonnée',
        nationId: 'dza',
        maxPlayers: 1,
        shopPolicy: { mode: 'limited', capPerPlayer: 30 },
      })
    ).json().game.id;
    expect((await acc(limited, 10)).statusCode).toBe(200);
    const capped = await acc(limited, 10);
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
    expect((await acc(disabled, 1)).json().error).toBe('shop_disabled');

    const poor = await guest(built.app);
    const poorGame = (
      await api(built.app, poor.cookie)('POST', '/api/games', { nationId: 'usa' })
    ).json().game.id;
    const broke = await api(built.app, poor.cookie)('POST', `/api/games/${poorGame}/accelerate`, {
      target: { type: 'research', id: 'x' },
      hours: 1,
    });
    expect(broke.statusCode).toBe(402);
    expect((await acc(poorGame, 1)).statusCode).toBe(404); // pas membre
    expect(await balanceOf(buyer.cookie)).toBe(560);
  });

  it('cosmétiques : achat, doublon refusé, récompenses de saison non achetables, pas de loot box', async () => {
    const req = api(built.app, buyer.cookie);
    const list = (await req('GET', '/api/shop/cosmetics')).json();
    expect(list.items.some((i: { id: string }) => i.id.startsWith('season.'))).toBe(false);
    const buy = await req('POST', '/api/shop/cosmetics/theme.terminal.amber/buy');
    expect(buy.json()).toMatchObject({ ok: true, balance: 410 });
    expect((await req('POST', '/api/shop/cosmetics/theme.terminal.amber/buy')).json().error).toBe(
      'already_owned',
    );
    expect((await req('POST', '/api/shop/cosmetics/season.flag.laurel/buy')).statusCode).toBe(404);
    expect((await req('GET', '/api/shop/cosmetics')).json().owned).toEqual([
      'theme.terminal.amber',
    ]);
  });

  it("remboursement depuis l'administration, idempotent avec le webhook charge.refunded", async () => {
    expect((await api(built.app, buyer.cookie)('GET', '/admin/api/purchases')).statusCode).toBe(
      403,
    );
    const list = (await api(built.app, admin)('GET', '/admin/api/purchases?status=paid')).json();
    expect(list.purchases).toHaveLength(1);
    const res = await api(built.app, admin)('POST', `/admin/api/purchases/${purchaseId}/refund`);
    expect(res.statusCode).toBe(200);
    expect(fake.refunds).toEqual(['pi_test_1']);
    expect(await balanceOf(buyer.cookie)).toBe(-190);
    const again = await api(built.app, admin)('POST', `/admin/api/purchases/${purchaseId}/refund`);
    expect(again.statusCode).toBe(409);

    const hook = await built.app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      ...signed({
        id: 'evt_refund',
        object: 'event',
        type: 'charge.refunded',
        data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_test_1' } },
      }),
    });
    expect(hook.json().handled).toBe('already_processed');
    expect(await balanceOf(buyer.cookie)).toBe(-190);
    // Solde négatif : plus aucune dépense possible.
    expect(
      (await api(built.app, buyer.cookie)('POST', '/api/shop/cosmetics/flag.frame.gold/buy'))
        .statusCode,
    ).toBe(402);
    const audit = (await api(built.app, admin)('GET', '/admin/api/audit')).json().entries;
    expect(audit.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['shop.refund', 'shop.promo.create', 'shop.pack.update']),
    );
  });
});
