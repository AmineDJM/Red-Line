import Stripe from 'stripe';

/** Événement de webhook, sous la forme minimale dont le serveur a besoin. */
export interface PaymentEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface CheckoutRequest {
  purchaseId: string;
  userId: string;
  packName: string;
  amountCents: number;
  currency: string;
  credits: number;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Prestataire de paiement (Stripe Checkout en production ; un faux client injecté dans les tests).
 * Le crédit du portefeuille ne dépend JAMAIS du retour navigateur : uniquement des webhooks vérifiés.
 */
export interface PaymentProvider {
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  /** Vérifie la signature `Stripe-Signature` sur le corps BRUT ; lève une erreur si elle est invalide. */
  verifyWebhook(raw: Buffer, signature: string): PaymentEvent;
  refund(paymentIntent: string): Promise<{ id: string }>;
}

/** Vérification des webhooks Stripe (HMAC-SHA256, tolérance 5 min) sans appel réseau. */
export function stripeWebhookVerifier(
  webhookSecret: string,
  client: Stripe = new Stripe('sk_test_verification_only'),
): (raw: Buffer, signature: string) => PaymentEvent {
  return (raw, signature) =>
    client.webhooks.constructEvent(raw, signature, webhookSecret) as unknown as PaymentEvent;
}

export function stripeProvider(secretKey: string, webhookSecret: string): PaymentProvider {
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  const verify = stripeWebhookVerifier(webhookSecret, stripe);
  return {
    async createCheckout(r) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: r.purchaseId,
        metadata: { purchaseId: r.purchaseId, userId: r.userId, credits: String(r.credits) },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: r.currency,
              unit_amount: r.amountCents,
              product_data: { name: `Red Line — ${r.packName}` },
            },
          },
        ],
        success_url: r.successUrl,
        cancel_url: r.cancelUrl,
      });
      if (!session.url) throw new Error('Stripe n’a pas renvoyé d’URL de paiement');
      return { sessionId: session.id, url: session.url };
    },
    verifyWebhook: verify,
    async refund(paymentIntent) {
      const r = await stripe.refunds.create({ payment_intent: paymentIntent });
      return { id: r.id };
    },
  };
}
