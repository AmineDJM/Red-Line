import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, walletLedger, type WalletReason } from '../db/schema.js';
import { HttpError } from '../auth/auth.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbOrTx = Db | Tx;

/**
 * Mouvement du portefeuille : mise à jour atomique du solde (users.premium_balance) + ligne du journal en
 * ajout seul (wallet_ledger, protégé par un déclencheur SQL). Refusé si le solde deviendrait négatif, sauf
 * `allowNegative` (remboursement d'un achat déjà dépensé).
 */
export async function moveWallet(
  tx: DbOrTx,
  m: {
    userId: string;
    delta: number;
    reason: WalletReason;
    ref?: string | null;
    gameId?: string | null;
    allowNegative?: boolean;
  },
): Promise<number> {
  const cond = m.allowNegative
    ? eq(users.id, m.userId)
    : and(eq(users.id, m.userId), sql`${users.premiumBalance} + ${m.delta} >= 0`);
  const [u] = await tx
    .update(users)
    .set({ premiumBalance: sql`${users.premiumBalance} + ${m.delta}` })
    .where(cond)
    .returning({ balance: users.premiumBalance });
  if (!u) throw new HttpError(402, 'insufficient_premium', 'Solde de monnaie premium insuffisant');
  await tx.insert(walletLedger).values({
    userId: m.userId,
    delta: m.delta,
    reason: m.reason,
    ref: m.ref ?? null,
    gameId: m.gameId ?? null,
    balanceAfter: u.balance,
  });
  return u.balance;
}

/** Verrouille la ligne de l'utilisateur pour la transaction (plafonds, achats concurrents). */
export async function lockUser(tx: Tx, userId: string): Promise<number> {
  const [u] = await tx
    .select({ balance: users.premiumBalance })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!u) throw new HttpError(404, 'not_found', 'Utilisateur introuvable');
  return u.balance;
}
