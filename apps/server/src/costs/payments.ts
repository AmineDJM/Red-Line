import type { PaymentProvider } from '../shop/payments.js';
import type { UsageMeter } from './usage.js';

/** Prestataire de paiement dont les appels sortants (Stripe) sont comptés par utilisateur. */
export function meteredPayments(p: PaymentProvider, usage: UsageMeter): PaymentProvider {
  return {
    createCheckout: (req) => {
      usage.stripe(req.userId);
      return p.createCheckout(req);
    },
    verifyWebhook: (raw, sig) => p.verifyWebhook(raw, sig),
    refund: (intent) => {
      usage.stripe(null);
      return p.refund(intent);
    },
  };
}
