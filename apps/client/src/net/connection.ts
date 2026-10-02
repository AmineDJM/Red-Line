import type {
  ChatMessage,
  ClockState,
  GameMeta,
  GameNotification,
  NationId,
  Order,
  OrderErrorCode,
  OrderReason,
  PlayerView,
  ViewDiff,
} from '@redline/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

export interface WelcomeEvent {
  game: GameMeta;
  me: NationId;
  clock: ClockState;
  view: PlayerView;
}

export interface OrderOutcome {
  ok: boolean;
  /** Code du contrat, ou 'disconnected' / 'timeout' côté client. */
  error?: OrderErrorCode | 'disconnected' | 'timeout';
  message?: string;
  /** Raison détaillée (traduite via `game.orders.reasons.<reason>`). */
  reason?: OrderReason;
  params?: Record<string, string | number>;
}

export interface OrderResultEvent extends OrderOutcome {
  id: number;
}

export interface GameConnectionEvents {
  welcome: WelcomeEvent;
  diff: ViewDiff;
  clock: ClockState;
  notify: GameNotification[];
  orderResult: OrderResultEvent;
  status: ConnectionStatus;
  /** Erreur serveur (message `error`). */
  error: { code: string; message: string };
  /** Messagerie (phase 5) : un message reçu. */
  chat: ChatMessage;
  /** Historique envoyé à la connexion. */
  chatHistory: ChatMessage[];
  /** Avis de l'administration. */
  notice: { level: 'info' | 'warn'; text: string };
}

/** Canal de messagerie côté client. */
export type ChatChannel = 'game' | 'alliance' | 'private';

export type Listener<T> = (payload: T) => void;

/**
 * Connexion à une partie. Trois implémentations : WebSocket (serveur), locale (moteur dans
 * le navigateur, bac à sable) et simulée (?mock=1).
 */
export interface GameConnection {
  readonly kind: 'ws' | 'local' | 'mock';
  on<K extends keyof GameConnectionEvents>(
    event: K,
    fn: Listener<GameConnectionEvents[K]>,
  ): () => void;
  /** Démarre la connexion (à appeler après s'être abonné aux événements). Idempotent. */
  start(): void;
  /** Envoie un ordre ; la promesse se résout avec le résultat (orderResult). */
  sendOrder(order: Order): Promise<OrderOutcome>;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
  /** Envoie un message (salon de la partie, alliance, ou privé à une nation `to`). */
  sendChat?(channel: ChatChannel, text: string, to?: string): void;
  /** Accuse lecture d'un canal jusqu'au message `upTo`. */
  markChatRead?(channel: string, upTo: number): void;
  /** Heure réelle estimée du serveur (ms epoch), pour `gameTimeAt(clock, serverNow())`. */
  serverNow(): number;
  close(): void;
}

/** Petit émetteur typé commun aux implémentations. */
export class Emitter {
  private map = new Map<keyof GameConnectionEvents, Set<Listener<never>>>();

  on<K extends keyof GameConnectionEvents>(
    event: K,
    fn: Listener<GameConnectionEvents[K]>,
  ): () => void {
    let set = this.map.get(event);
    if (!set) this.map.set(event, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  protected emit<K extends keyof GameConnectionEvents>(event: K, payload: GameConnectionEvents[K]) {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<GameConnectionEvents[K]>)(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
