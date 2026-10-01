import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AccelerateBodySchema,
  type CosmeticItem,
  type ShopPack,
  type WalletEntry,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  cosmetics,
  purchases,
  shopPacks,
  shopPromotions,
  stripeEvents,
  userCosmetics,
  walletLedger,
} from '../db/schema.js';
import { HttpError } from '../auth/auth.js';
import { parseBody, unavailable } from '../http/util.js';
import { gameAccess, gameIdParam, requireUser } from '../http/access.js';
import { PURCHASE_REQUIRED } from '../legal/legal.js';
import type { ShopConfig } from './config.js';
import type { PaymentEvent } from './payments.js';
import { lockUser, moveWallet } from './wallet.js';

export const PAYMENTS_UNAVAILABLE = 'Paiements indisponibles';

type PackRow = typeof shopPacks.$inferSelect;
type PromoRow = typeof shopPromotions.$inferSelect;

/** Packs et cosmétiques initiaux (config.json) : insérés s'ils n'existent pas (jamais d'écrasement). */
export async function seedShop(db: Db, cfg: ShopConfig): Promise<void> {
  if (cfg.packs.length) {
    await db
      .insert(shopPacks)
      .values(cfg.packs.map((p) => ({ ...p })))
      .onConflictDoNothing();
  }
  if (cfg.cosmetics.length) {
    await db
      .insert(cosmetics)
      .values(cfg.cosmetics.map((c) => ({ ...c })))
      .onConflictDoNothing();
  }
}

/** Promotion active la plus avantageuse pour un pack. */
export function bestPromo(pack: PackRow, promos: PromoRow[], now = new Date()): PromoRow | null {
  let best: PromoRow | null = null;
  for (const p of promos) {
    if (!p.active || p.startsAt > now || p.endsAt <= now) continue;
    if (p.packId !== null && p.packId !== pack.id) continue;
    if (!best || p.percentOff > best.percentOff) best = p;
  }
  return best;
}

export function packView(pack: PackRow, promos: PromoRow[], now = new Date()): ShopPack {
  const promo = bestPromo(pack, promos, now);
  return {
    id: pack.id,
    name: pack.name,
    amount: pack.amount,
    bonus: pack.bonus,
    priceCents: promo
      ? Math.round((pack.priceCents * (100 - promo.percentOff)) / 100)
      : pack.priceCents,
    currency: pack.currency,
    promo: promo
      ? { label: promo.label, percentOff: promo.percentOff, until: promo.endsAt.toISOString() }
      : null,
  };
}

const toWalletEntry = (r: typeof walletLedger.$inferSelect): WalletEntry => ({
  id: r.id,
  delta: r.delta,
  reason: r.reason,
  ref: r.ref,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Traite un événement Stripe déjà VÉRIFIÉ, de façon idempotente (table stripe_events, même transaction).
 * Seul chemin de crédit du portefeuille par un achat.
 */
export async function processPaymentEvent(
  db: Db,
  event: PaymentEvent,
): Promise<{ duplicate: boolean; handled: string }> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (!fresh) return { duplicate: true, handled: 'duplicate' };
    const obj = event.data?.object ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (event.type === 'checkout.session.completed' && obj.payment_status !== 'paid') {
          return { duplicate: false, handled: 'awaiting_payment' };
        }
        const meta = (obj.metadata ?? {}) as Record<string, unknown>;
        const purchaseId = str(obj.client_reference_id) ?? str(meta.purchaseId);
        if (!purchaseId || !z.string().uuid().safeParse(purchaseId).success) {
          return { duplicate: false, handled: 'unknown_purchase' };
        }
        const [p] = await tx
          .select()
          .from(purchases)
          .where(eq(purchases.id, purchaseId))
          .for('update');
        if (!p || !p.userId) return { duplicate: false, handled: 'unknown_purchase' };
        if (p.stripeSessionId && str(obj.id) && p.stripeSessionId !== obj.id) {
          return { duplicate: false, handled: 'session_mismatch' };
        }
        if (typeof obj.amount_total === 'number' && obj.amount_total !== p.priceCents) {
          await tx.update(purchases).set({ status: 'failed' }).where(eq(purchases.id, p.id));
          return { duplicate: false, handled: 'amount_mismatch' };
        }
        if (p.status !== 'pending') return { duplicate: false, handled: 'already_processed' };
        await tx
          .update(purchases)
          .set({ status: 'paid', paidAt: new Date(), paymentIntent: str(obj.payment_intent) })
          .where(eq(purchases.id, p.id));
        await moveWallet(tx, { userId: p.userId, delta: p.credits, reason: 'purchase', ref: p.id });
        return { duplicate: false, handled: 'credited' };
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const purchaseId = str(obj.client_reference_id);
        if (purchaseId && z.string().uuid().safeParse(purchaseId).success) {
          await tx
            .update(purchases)
            .set({ status: 'failed' })
            .where(and(eq(purchases.id, purchaseId), eq(purchases.status, 'pending')));
        }
        return { duplicate: false, handled: 'failed' };
      }
      case 'charge.refunded': {
        const intent = str(obj.payment_intent);
        if (!intent) return { duplicate: false, handled: 'ignored' };
        const [p] = await tx
          .select()
          .from(purchases)
          .where(eq(purchases.paymentIntent, intent))
          .for('update');
        if (!p || !p.userId || p.status !== 'paid') {
          return { duplicate: false, handled: 'already_processed' };
        }
        await tx
          .update(purchases)
          .set({ status: 'refunded', refundedAt: new Date() })
          .where(eq(purchases.id, p.id));
        await moveWallet(tx, {
          userId: p.userId,
          delta: -p.credits,
          reason: 'refund',
          ref: p.id,
          allowNegative: true,
        });
        return { duplicate: false, handled: 'refunded' };
      }
      default:
        return { duplicate: false, handled: 'ignored' };
    }
  });
}

/** Remboursement depuis l'administration : Stripe d'abord, puis débit (idempotent avec le webhook). */
export async function refundPurchase(
  ctx: AppContext,
  purchaseId: string,
): Promise<{ balance: number | null }> {
  const [p] = await ctx.db.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) throw new HttpError(404, 'not_found', 'Achat introuvable');
  if (p.status !== 'paid') throw new HttpError(409, 'not_refundable', `Achat ${p.status}`);
  if (p.paymentIntent) {
    if (!ctx.payments) throw unavailable('payments_unavailable', PAYMENTS_UNAVAILABLE);
    await ctx.payments.refund(p.paymentIntent);
  }
  return ctx.db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (!cur || cur.status !== 'paid' || !cur.userId) return { balance: null };
    await tx
      .update(purchases)
      .set({ status: 'refunded', refundedAt: new Date() })
      .where(eq(purchases.id, cur.id));
    const balance = await moveWallet(tx, {
      userId: cur.userId,
      delta: -cur.credits,
      reason: 'refund',
      ref: cur.id,
      allowNegative: true,
    });
    return { balance };
  });
}

const CheckoutBodySchema = z.object({ packId: z.string().min(1).max(64) });

export async function shopRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  const activePromos = () =>
    db.select().from(shopPromotions).where(eq(shopPromotions.active, true));

  app.get('/api/shop/packs', async () => {
    const [packs, promos] = await Promise.all([
      db.select().from(shopPacks).where(eq(shopPacks.active, true)).orderBy(asc(shopPacks.sort)),
      activePromos(),
    ]);
    return {
      packs: packs.map((p) => packView(p, promos)),
      paymentsAvailable: !!ctx.payments,
      ...(ctx.payments ? {} : { message: PAYMENTS_UNAVAILABLE }),
    };
  });

  app.get('/api/shop/wallet', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const history = await db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, user.id))
      .orderBy(desc(walletLedger.id))
      .limit(100);
    return {
      balance: user.premiumBalance,
      history: history.map(toWalletEntry),
      ...(user.unlimited ? { unlimited: true } : {}),
    };
  });

  app.post(
    '/api/shop/checkout',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { user } = await requireUser(ctx, req, reply);
      const { packId } = parseBody(CheckoutBodySchema, req.body);
      if (!ctx.payments) throw unavailable('payments_unavailable', PAYMENTS_UNAVAILABLE);
      if (user.isGuest) {
        throw new HttpError(403, 'account_required', 'Créez un compte pour effectuer un achat');
      }
      const missing = await ctx.legal.missing(user.id, PURCHASE_REQUIRED);
      if (missing.length) {
        return reply.code(403).send({
          error: 'legal_required',
          message:
            'Acceptez les conditions générales de vente et la renonciation à la rétractation',
          needsAcceptance: missing,
        });
      }
      const [pack] = await db
        .select()
        .from(shopPacks)
        .where(and(eq(shopPacks.id, packId), eq(shopPacks.active, true)));
      if (!pack) throw new HttpError(404, 'not_found', 'Pack introuvable');
      const view = packView(pack, await activePromos());
      const [purchase] = await db
        .insert(purchases)
        .values({
          userId: user.id,
          packId: pack.id,
          credits: pack.amount + pack.bonus,
          priceCents: view.priceCents,
          currency: pack.currency,
        })
        .returning();
      const base =
        ctx.config.publicUrl ??
        `${req.protocol}://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')}`;
      const session = await ctx.payments.createCheckout({
        purchaseId: purchase!.id,
        userId: user.id,
        packName: pack.name,
        amountCents: view.priceCents,
        currency: pack.currency,
        credits: purchase!.credits,
        successUrl: `${base}/?boutique=merci&achat=${purchase!.id}`,
        cancelUrl: `${base}/?boutique=annule`,
      });
      await db
        .update(purchases)
        .set({ stripeSessionId: session.sessionId })
        .where(eq(purchases.id, purchase!.id));
      return { url: session.url, purchaseId: purchase!.id };
    },
  );

  // Webhook Stripe : corps BRUT (la signature porte sur les octets exacts).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/api/stripe/webhook', async (req, reply) => {
      if (!ctx.payments) throw unavailable('payments_unavailable', PAYMENTS_UNAVAILABLE);
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string' || !Buffer.isBuffer(req.body)) {
        return reply.code(400).send({ error: 'invalid_signature', message: 'Signature absente' });
      }
      let event: PaymentEvent;
      try {
        event = ctx.payments.verifyWebhook(req.body, sig);
      } catch {
        ctx.log.warn('webhook Stripe : signature invalide');
        return reply.code(400).send({ error: 'invalid_signature', message: 'Signature invalide' });
      }
      const r = await processPaymentEvent(db, event);
      ctx.log.info({ event: event.id, type: event.type, ...r }, 'webhook Stripe');
      return { received: true, duplicate: r.duplicate, handled: r.handled };
    });
  });

  // ─────────── Cosmétiques ───────────

  app.get('/api/shop/cosmetics', async (req, reply) => {
    const state = await ctx.auth.authenticate(req, reply);
    const items = await db
      .select()
      .from(cosmetics)
      .where(eq(cosmetics.active, true))
      .orderBy(asc(cosmetics.kind), asc(cosmetics.id));
    const owned = state
      ? (
          await db
            .select({ id: userCosmetics.cosmeticId })
            .from(userCosmetics)
            .where(eq(userCosmetics.userId, state.user.id))
        ).map((r) => r.id)
      : [];
    return {
      items: items
        .filter((c) => c.purchasable || owned.includes(c.id))
        .map((c): CosmeticItem & { purchasable: boolean } => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          price: c.price,
          preview: c.preview,
          purchasable: c.purchasable,
        })),
      owned,
    };
  });

  app.post('/api/shop/cosmetics/:id/buy', async (req, reply) => {
    const { user } = await requireUser(ctx, req, reply);
    const id = (req.params as { id: string }).id;
    const [item] = await db
      .select()
      .from(cosmetics)
      .where(and(eq(cosmetics.id, id), eq(cosmetics.active, true)));
    if (!item || !item.purchasable) throw new HttpError(404, 'not_found', 'Article introuvable');
    const balance = await db.transaction(async (tx) => {
      await lockUser(tx, user.id);
      const [owned] = await tx
        .select()
        .from(userCosmetics)
        .where(and(eq(userCosmetics.userId, user.id), eq(userCosmetics.cosmeticId, id)));
      if (owned) throw new HttpError(409, 'already_owned', 'Article déjà possédé');
      // Mode illimité : solde premium illimité, rien n'est débité.
      const b = user.unlimited
        ? user.premiumBalance
        : await moveWallet(tx, {
            userId: user.id,
            delta: -item.price,
            reason: 'cosmetic',
            ref: item.id,
          });
      await tx
        .insert(userCosmetics)
        .values({ userId: user.id, cosmeticId: id, source: 'purchase' });
      return b;
    });
    return { ok: true, balance, ...(user.unlimited ? { unlimited: true } : {}) };
  });

  // ─────────── Accélérations ───────────

  app.post(
    '/api/games/:id/accelerate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const auth = await requireUser(ctx, req, reply);
      const gameId = gameIdParam(req);
      const body = parseBody(AccelerateBodySchema, req.body);
      const { row, member } = await gameAccess(ctx, gameId, auth);
      if (!member) throw new HttpError(404, 'not_found', 'Partie introuvable');
      if (row.status === 'ended') throw new HttpError(409, 'game_over', 'La partie est terminée');
      if (row.status === 'lobby') throw new HttpError(409, 'not_started', 'Partie non lancée');
      const policy = row.shopPolicy ?? { mode: 'open' };
      if (policy.mode === 'disabled') {
        throw new HttpError(403, 'shop_disabled', 'Achats désactivés dans cette partie');
      }
      const cfg = ctx.shop.accelerate;
      const cost = Math.max(cfg.minimum, Math.ceil(body.hours * cfg.pricePerHour));
      const g = await ctx.host.ensureLoaded(gameId);
      if (!g) throw new HttpError(409, 'game_unavailable', 'Partie momentanément indisponible');
      const balance = await db.transaction(async (tx) => {
        const unlimited = auth.user.unlimited;
        await lockUser(tx, auth.user.id);
        // Mode illimité : ni plafond de partie ni débit (la partie multijoueur est déjà non classée).
        if (policy.mode === 'limited' && !unlimited) {
          const [s] = await tx
            .select({ spent: sql<number>`coalesce(-sum(${walletLedger.delta}), 0)::int` })
            .from(walletLedger)
            .where(
              and(
                eq(walletLedger.userId, auth.user.id),
                eq(walletLedger.gameId, gameId),
                eq(walletLedger.reason, 'accelerate'),
              ),
            );
          const cap = policy.capPerPlayer ?? 0;
          if ((s?.spent ?? 0) + cost > cap) {
            throw new HttpError(
              403,
              'cap_reached',
              `Plafond de dépenses de la partie atteint (${s?.spent ?? 0} / ${cap})`,
            );
          }
        }
        const b = unlimited
          ? auth.user.premiumBalance
          : await moveWallet(tx, {
              userId: auth.user.id,
              delta: -cost,
              reason: 'accelerate',
              ref: `${body.target.type}:${body.target.id}:${body.hours}h`,
              gameId,
            });
        // Le moteur refuse (cible inconnue…) : exception → la transaction annule le débit.
        const r = await ctx.host.system(gameId, {
          kind: 'accelerate',
          nationId: member.nationId,
          target: body.target,
          hours: body.hours,
        });
        if (!r.ok) {
          throw new HttpError(
            409,
            r.error === 'unsupported' ? 'accelerate_unavailable' : 'accelerate_refused',
            r.message ?? 'Accélération refusée',
          );
        }
        return b;
      });
      return {
        ok: true,
        balance,
        cost: auth.user.unlimited ? 0 : cost,
        ...(auth.user.unlimited ? { unlimited: true } : {}),
      };
    },
  );
}

/** Dernières promotions (administration). */
export async function listPromotions(db: Db) {
  return db.select().from(shopPromotions).orderBy(desc(shopPromotions.id));
}
