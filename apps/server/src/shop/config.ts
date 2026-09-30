import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SERVER_ROOT } from '../paths.js';

/**
 * Réglages commerciaux et de classement (apps/server/shop/config.json) : packs et cosmétiques initiaux
 * (ensuite gérés depuis le back-office), prix des accélérations, saisons, barème de points, mots filtrés.
 */
export const ShopConfigSchema = z.object({
  packs: z.array(
    z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(80),
      amount: z.number().int().positive(),
      bonus: z.number().int().min(0).default(0),
      priceCents: z.number().int().positive(),
      currency: z.enum(['eur', 'usd']).default('eur'),
      sort: z.number().int().default(0),
    }),
  ),
  cosmetics: z.array(
    z.object({
      id: z.string().min(1).max(64),
      kind: z.enum(['unit_skin', 'flag', 'map_theme', 'terminal_theme']),
      name: z.string().min(1).max(80),
      price: z.number().int().min(0),
      preview: z.string().default(''),
      purchasable: z.boolean().default(true),
    }),
  ),
  accelerate: z.object({
    /** Monnaie premium par heure de jeu retirée. */
    pricePerHour: z.number().positive(),
    minimum: z.number().int().min(0),
  }),
  seasons: z.object({
    lengthDays: z.number().positive(),
    rewards: z.array(z.object({ rank: z.number().int().positive(), cosmeticId: z.string() })),
  }),
  points: z.object({
    win: z.number(),
    participation: z.number(),
    perProvinceConquered: z.number(),
    perKill: z.number(),
    /** Parties classées : au moins N joueurs humains (pas de points en solo contre l'IA). */
    minHumanPlayers: z.number().int().min(1),
  }),
  chat: z.object({ blockedWords: z.array(z.string()).default([]) }).default({}),
});
export type ShopConfig = z.infer<typeof ShopConfigSchema>;

export function loadShopConfig(path = join(SERVER_ROOT, 'shop', 'config.json')): ShopConfig {
  return ShopConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
