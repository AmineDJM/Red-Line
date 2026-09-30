import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ChatMessage, ClientMessage, NationId, PlayerView } from '@redline/shared';
import type { Db } from '../db/client.js';
import { chatMessages, chatReads, users } from '../db/schema.js';
import type { Connection, GameHost, HostedGame } from '../host/game-host.js';
import type { ProcessMetrics } from '../metrics.js';

type ChatRow = typeof chatMessages.$inferSelect;
type ChatMsg = Extract<ClientMessage, { t: 'chat' }>;

const HISTORY_LIMIT = 150;
/** Même texte renvoyé dans ce délai : refusé (anti-flood). */
const DUPLICATE_MS = 5_000;

export function toChatMessage(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    gameId: r.gameId,
    channel: r.channel,
    from: { userId: r.userId ?? '', nationId: r.nationId, name: r.authorName },
    text: r.hidden ? '' : r.text,
    sentAt: r.createdAt.toISOString(),
    ...(r.hidden ? { hidden: true } : {}),
  };
}

export function privateChannel(a: NationId, b: NationId): string {
  return `private:${[a, b].sort().join('|')}`;
}

/** Alliance de la nation d'après SA vue diplomatie (moteur). */
export function allianceOf(view: PlayerView | null): { id: string; members: NationId[] } | null {
  const d = view?.diplomacy;
  const id = d?.myAllianceId ?? (view ? view.nations[view.me]?.allianceId : null) ?? null;
  if (!id) return null;
  const a = d?.alliances.find((x) => x.id === id);
  return { id, members: a?.members ?? [] };
}

/** Nettoyage : caractères de contrôle, espaces, lignes vides répétées. */
export function sanitize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Messagerie de partie : canaux « game » (tous les joueurs), « alliance:<id> » (membres selon la vue
 * diplomatie du moteur) et « private:<a>|<b> ». Messages en base (chat_messages), historique à la connexion,
 * limitation de débit, filtre de mots, sourdine et masquage par la modération. Les spectateurs n'y ont pas accès.
 */
export class ChatService {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly lastText = new Map<string, { text: string; at: number }>();
  private readonly filter: RegExp | null;

  constructor(
    private readonly deps: {
      db: Db;
      host: GameHost;
      log: FastifyBaseLogger;
      metrics: ProcessMetrics;
      rate: { perSecond: number; burst: number };
      blockedWords: string[];
    },
  ) {
    const words = deps.blockedWords.map((w) => w.trim()).filter(Boolean);
    this.filter = words.length
      ? new RegExp(`(^|[^\\p{L}])(${words.map(escapeRe).join('|')})(?=$|[^\\p{L}])`, 'giu')
      : null;
  }

  /** Remplace les mots bloqués par des astérisques. */
  censor(text: string): { text: string; filtered: boolean } {
    if (!this.filter) return { text, filtered: false };
    let filtered = false;
    const out = text.replace(this.filter, (_m, pre: string, word: string) => {
      filtered = true;
      return pre + '*'.repeat([...word].length);
    });
    return { text: out, filtered };
  }

  private take(key: string, now: number): boolean {
    const { perSecond, burst } = this.deps.rate;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: burst, last: now }));
    b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * perSecond);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (this.buckets.size > 20_000) this.buckets.clear();
    return true;
  }

  /** Canaux lisibles par une connexion de joueur. */
  private channelsOf(conn: Connection): { alliance: string | null; nation: NationId } {
    const a = allianceOf(conn.lastView);
    return { alliance: a ? `alliance:${a.id}` : null, nation: conn.nationId };
  }

  /** Vrai si la connexion doit recevoir un message du canal. */
  private receives(conn: Connection, channel: string): boolean {
    if (conn.spectator) return false;
    if (channel === 'game') return true;
    if (channel.startsWith('alliance:')) return this.channelsOf(conn).alliance === channel;
    if (channel.startsWith('private:')) return channel.slice(8).split('|').includes(conn.nationId);
    return false;
  }

  async handle(g: HostedGame, conn: Connection, msg: ChatMsg): Promise<void> {
    const err = (code: string, message: string) => conn.send({ t: 'error', code, message });
    if (conn.spectator) return err('read_only', 'Mode spectateur : lecture seule');
    const now = Date.now();
    const key = `${conn.userId}|${g.id}`;
    if (!this.take(key, now)) return err('chat_rate_limited', 'Trop de messages, patientez.');
    const text = sanitize(msg.text);
    if (!text) return err('chat_empty', 'Message vide');
    const prev = this.lastText.get(key);
    if (prev && prev.text === text && now - prev.at < DUPLICATE_MS) {
      return err('chat_duplicate', 'Message identique déjà envoyé');
    }

    let channel: string;
    if (msg.channel === 'game') channel = 'game';
    else if (msg.channel === 'alliance') {
      const a = allianceOf(conn.lastView);
      if (!a) return err('chat_no_alliance', "Vous n'appartenez à aucune alliance");
      channel = `alliance:${a.id}`;
    } else {
      const to = msg.to;
      if (!to || to === conn.nationId) return err('chat_bad_recipient', 'Destinataire invalide');
      if (!g.players.some((p) => p.nationId === to && p.userId)) {
        return err('chat_bad_recipient', 'Cette nation n’est pas tenue par un joueur');
      }
      channel = privateChannel(conn.nationId, to);
    }

    const [u] = await this.deps.db
      .select({ mutedUntil: users.chatMutedUntil, banned: users.bannedAt, name: users.displayName })
      .from(users)
      .where(eq(users.id, conn.userId));
    if (!u || u.banned) return err('banned', 'Compte suspendu');
    if (u.mutedUntil && u.mutedUntil.getTime() > now) {
      return err('chat_muted', `Messagerie suspendue jusqu'au ${u.mutedUntil.toISOString()}`);
    }
    const censored = this.censor(text);
    const [row] = await this.deps.db
      .insert(chatMessages)
      .values({
        gameId: g.id,
        channel,
        userId: conn.userId,
        nationId: conn.nationId,
        authorName: u.name,
        text: censored.text,
        filtered: censored.filtered,
      })
      .returning();
    this.lastText.set(key, { text, at: now });
    if (this.lastText.size > 20_000) this.lastText.clear();
    this.deps.metrics.count('chat');
    const out = toChatMessage(row!);
    this.deps.host.broadcast(g, { t: 'chat', message: out }, (c) => this.receives(c, channel));
  }

  /** Historique envoyé à la connexion : salon de la partie, alliance actuelle, messages privés. */
  async sendHistory(g: HostedGame, conn: Connection): Promise<void> {
    if (conn.spectator) return;
    const { alliance, nation } = this.channelsOf(conn);
    const conds = [
      eq(chatMessages.channel, 'game'),
      sql`(${chatMessages.channel} LIKE 'private:%' AND ${nation} = ANY(string_to_array(substr(${chatMessages.channel}, 9), '|')))`,
    ];
    if (alliance) conds.push(eq(chatMessages.channel, alliance));
    const rows = await this.deps.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.gameId, g.id), or(...conds)))
      .orderBy(desc(chatMessages.id))
      .limit(HISTORY_LIMIT);
    conn.send({ t: 'chatHistory', messages: rows.reverse().map(toChatMessage) });
  }

  async markRead(
    g: HostedGame,
    conn: Connection,
    msg: Extract<ClientMessage, { t: 'chatRead' }>,
  ): Promise<void> {
    if (conn.spectator) return;
    await this.deps.db
      .insert(chatReads)
      .values({ gameId: g.id, userId: conn.userId, channel: msg.channel, upTo: msg.upTo })
      .onConflictDoUpdate({
        target: [chatReads.gameId, chatReads.userId, chatReads.channel],
        set: { upTo: sql`greatest(${chatReads.upTo}, ${msg.upTo})` },
      });
  }

  /** Masquage (ou rétablissement) par la modération, rediffusé aux joueurs connectés. */
  async setHidden(
    messageId: number,
    hidden: boolean,
    adminId: string,
  ): Promise<ChatMessage | null> {
    const [row] = await this.deps.db
      .update(chatMessages)
      .set({ hidden, hiddenBy: hidden ? adminId : null })
      .where(eq(chatMessages.id, messageId))
      .returning();
    if (!row) return null;
    const g = this.deps.host.games.get(row.gameId);
    const out = toChatMessage(row);
    if (g)
      this.deps.host.broadcast(g, { t: 'chat', message: out }, (c) =>
        this.receives(c, row.channel),
      );
    return out;
  }
}
