import type { GameNotification, NationId } from '@redline/shared';
import type { EngineState } from '../state/types.js';

/** Destinataires des notifications produites par le moteur (null = tout le monde). */
const audience = new WeakMap<GameNotification, NationId[] | null>();

export function setAudience(n: GameNotification, aud: NationId[] | null): void {
  audience.set(n, aud);
}

/** Filtre de brouillard : ne garde que les notifications qu'une nation a le droit de recevoir. */
export function notificationsForImpl(
  state: EngineState,
  nation: NationId,
  items: GameNotification[],
): GameNotification[] {
  return items.filter((n) => {
    const aud = audience.get(n);
    if (aud !== undefined) return aud === null || aud.includes(nation);
    return fallback(state, nation, n);
  });
}

/** Notifications d'origine inconnue (ex. après désérialisation côté serveur) : règle prudente. */
function fallback(state: EngineState, nation: NationId, n: GameNotification): boolean {
  switch (n.kind) {
    case 'province_captured':
    case 'nation_defeated':
    case 'victory':
      return true;
    case 'province_capture_started':
      return n.by === nation || state.provinces[n.provinceId]?.owner === nation;
    case 'unit_destroyed':
      return n.owner === nation;
    case 'combat_started':
      return n.unitIds.some((id) => state.units[id]?.owner === nation);
    case 'production_complete':
    case 'arrived':
      return state.units[n.unitId]?.owner === nation;
    case 'unit_detected':
      return !!state.know[nation]?.[n.unitId];
  }
}
