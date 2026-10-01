import { AiBalanceSchema, type AiBalance, type AiLevelBalance } from '@redline/shared';
import type { World } from '../api.js';
import type { AiLevel, EngineState } from '../state/types.js';

/**
 * Réglages de l'IA : section `ai` de data/balance, complétée par les valeurs par défaut du schéma
 * (packages/shared/src/balance.ts, AiBalanceSchema). Calculés une fois par monde.
 */
const cache = new WeakMap<World, AiBalance>();

export function aiCfg(world: World): AiBalance {
  let c = cache.get(world);
  if (!c) {
    c = AiBalanceSchema.parse(world.balance.ai ?? {});
    cache.set(world, c);
  }
  return c;
}

/** Profil du niveau de difficulté d'une nation. */
export function aiLevelCfg(state: EngineState, level: AiLevel): AiLevelBalance {
  return aiCfg(state.world).levels[level];
}
