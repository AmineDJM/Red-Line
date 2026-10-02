import type { GameTime, NationId, ProvinceId, UnitId } from '@redline/shared';

/**
 * Événements de la file. Clé de tri totale (t, p, s) : temps, priorité, numéro de séquence monotone.
 * Chaque événement porte la version de l'entité dont il dépend ; il est ignoré (invalidation paresseuse)
 * si l'entité a changé depuis sa programmation.
 */
interface Base {
  t: GameTime;
  p: number;
  s: number;
}

export type GameEvent =
  /** Fin d'un segment de trajet (hors dernier). */
  | (Base & { k: 'leg'; u: UnitId; v: number; i: number })
  /** Arrivée à destination. */
  | (Base & { k: 'arr'; u: UnitId; v: number })
  /** Passage d'une frontière de province (déclaration de guerre automatique). */
  | (Base & { k: 'terr'; u: UnitId; v: number; i: number })
  /** Entrée/sortie d'une zone fixe (détection et ville d'une province) : paire province–unité. */
  | (Base & { k: 'zone'; key: string })
  /** Contact entre deux unités (détection, engagement, croisements mobiles). */
  | (Base & { k: 'contact'; key: string })
  /** Round de combat d'une unité. */
  | (Base & { k: 'round'; u: UnitId; v: number })
  /** Poursuite : recalcul du trajet vers la cible. */
  | (Base & { k: 'chase'; u: UnitId })
  /** Fin de capture d'une province. */
  | (Base & { k: 'cap'; prov: ProvinceId; v: number })
  /** Fin de production. */
  | (Base & { k: 'prod'; n: NationId; id: string })
  /** Tick journalier (économie). */
  | (Base & { k: 'day' })
  /** Réflexion des IA. */
  | (Base & { k: 'ai' })
  /** Événement d'un module (phases 2+) : voir modules/types.ts. */
  | (Base & { k: 'mod'; m: 'eco' | 'mil' | 'intel' | 'diplo' | 'cmd'; e: string; d?: unknown });

export type EventKind = GameEvent['k'];

/** Priorités à temps égal (plus petit = traité d'abord). */
export const PRIORITY: Record<EventKind, number> = {
  leg: 0,
  terr: 1,
  arr: 2,
  zone: 3,
  contact: 3,
  cap: 4,
  prod: 5,
  round: 6,
  chase: 7,
  day: 8,
  ai: 9,
  mod: 5,
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Événement sans clé de tri (fournie par `schedule`). */
export type EventInput = DistributiveOmit<GameEvent, 'p' | 's'>;
