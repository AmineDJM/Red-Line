import { create } from 'zustand';
import {
  gameTimeAt,
  type ChatMessage,
  type ClockState,
  type GameMeta,
  type GameNotification,
  type GameTime,
  type NationId,
  type PlayerView,
  type ViewDiff,
} from '@redline/shared';
import { applyDiff } from '../net/applyDiff.js';
import type { ConnectionStatus, GameConnection, WelcomeEvent } from '../net/connection.js';

export interface StoredNotification {
  id: number;
  item: GameNotification;
  read: boolean;
}

const MAX_NOTIFICATIONS = 150;
const MAX_CHAT = 400;

export interface Notice {
  id: number;
  level: 'info' | 'warn';
  text: string;
}

/** État de la partie tel que reçu du serveur (ou du moteur local). */
export interface GameStore {
  connection: GameConnection | null;
  status: ConnectionStatus;
  meta: GameMeta | null;
  me: NationId | null;
  clock: ClockState | null;
  view: PlayerView | null;
  notifications: StoredNotification[];
  /** Incrémenté à chaque changement de `view` (abonnés hors React). */
  viewVersion: number;
  /** Messagerie : messages reçus (tous canaux), du plus ancien au plus récent. */
  chat: ChatMessage[];
  /** Dernier identifiant lu par canal. */
  chatRead: Record<string, number>;
  /** Avis de l'administration (bandeau). */
  notices: Notice[];

  attach(conn: GameConnection | null): void;
  welcome(w: WelcomeEvent): void;
  diff(d: ViewDiff): void;
  setClock(c: ClockState): void;
  notify(items: GameNotification[]): void;
  markAllRead(): void;
  markRead(id: number): void;
  receiveChat(messages: ChatMessage[]): void;
  markChannelRead(channel: string): void;
  notice(n: Omit<Notice, 'id'>): void;
  dismissNotice(id: number): void;
  reset(): void;
}

let notifSeq = 0;

export const useGame = create<GameStore>((set, get) => ({
  connection: null,
  status: 'closed',
  meta: null,
  me: null,
  clock: null,
  view: null,
  notifications: [],
  viewVersion: 0,
  chat: [],
  chatRead: {},
  notices: [],

  attach(conn) {
    set({ connection: conn });
  },
  welcome(w) {
    set((s) => ({
      meta: w.game,
      me: w.me,
      clock: w.clock,
      view: w.view,
      viewVersion: s.viewVersion + 1,
    }));
  },
  diff(d) {
    const v = get().view;
    if (!v) return;
    set((s) => ({ view: applyDiff(v, d), viewVersion: s.viewVersion + 1 }));
  },
  setClock(c) {
    set({ clock: c });
  },
  notify(items) {
    if (!items.length) return;
    set((s) => ({
      notifications: [
        ...items.map((item) => ({ id: ++notifSeq, item, read: false })).reverse(),
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    }));
  },
  markAllRead() {
    set((s) => ({
      notifications: s.notifications.map((n) => (n.read ? n : { ...n, read: true })),
    }));
  },
  markRead(id) {
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }));
  },
  receiveChat(messages) {
    if (!messages.length) return;
    set((s) => {
      const byId = new Map(s.chat.map((m) => [m.id, m]));
      for (const m of messages) byId.set(m.id, m);
      const chat = [...byId.values()].sort((a, b) => a.id - b.id).slice(-MAX_CHAT);
      return { chat };
    });
  },
  markChannelRead(channel) {
    const last = get()
      .chat.filter((m) => m.channel === channel)
      .reduce((m, x) => Math.max(m, x.id), 0);
    if (!last || (get().chatRead[channel] ?? 0) >= last) return;
    set((s) => ({ chatRead: { ...s.chatRead, [channel]: last } }));
    get().connection?.markChatRead?.(channel, last);
  },
  notice(n) {
    set((s) => ({ notices: [...s.notices.slice(-2), { ...n, id: ++notifSeq }] }));
  },
  dismissNotice(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },
  reset() {
    set({
      chat: [],
      chatRead: {},
      notices: [],
      connection: null,
      status: 'closed',
      meta: null,
      me: null,
      clock: null,
      view: null,
      notifications: [],
      viewVersion: 0,
    });
  },
}));

/** Temps de jeu courant, extrapolé depuis l'horloge (sans React). */
export function gameNow(): GameTime {
  const { clock, connection, view } = useGame.getState();
  if (!clock) return view?.time ?? 0;
  return gameTimeAt(clock, connection ? connection.serverNow() : Date.now());
}

/** Branche les événements d'une connexion sur le store ; renvoie la fonction de débranchement. */
export function bindConnection(conn: GameConnection): () => void {
  const g = useGame.getState();
  g.reset();
  g.attach(conn);
  const offs = [
    conn.on('status', (status) => useGame.setState({ status })),
    conn.on('welcome', (w) => useGame.getState().welcome(w)),
    conn.on('diff', (d) => useGame.getState().diff(d)),
    conn.on('clock', (c) => useGame.getState().setClock(c)),
    conn.on('notify', (items) => useGame.getState().notify(items)),
    conn.on('chat', (m) => useGame.getState().receiveChat([m])),
    conn.on('chatHistory', (list) => useGame.getState().receiveChat(list)),
    conn.on('notice', (n) => useGame.getState().notice(n)),
  ];
  conn.start();
  return () => {
    offs.forEach((off) => off());
    conn.close();
    useGame.getState().attach(null);
  };
}
