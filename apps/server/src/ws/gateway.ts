import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import { z } from 'zod';
import {
  ClientMessageSchema,
  decodeMessage,
  encodeMessage,
  type NationId,
  type PlayerView,
  type ServerMessage,
} from '@redline/shared';
import type { AppContext } from '../context.js';
import { gamePlayers } from '../db/schema.js';
import type { Connection, HostedGame } from '../host/game-host.js';
import { gameAccess } from '../http/access.js';
import type { ProcessMetrics } from '../metrics.js';

const QuerySchema = z.object({
  gameId: z.string().uuid(),
  spectate: z.enum(['0', '1', 'true', 'false']).optional(),
});
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const PING_INTERVAL_MS = 30_000;

interface WsIdentity {
  userId: string;
  userName: string;
  nationId: NationId;
  gameId: string;
  spectator: boolean;
}

let nextConnId = 1;

class WsConnection implements Connection {
  readonly id = nextConnId++;
  lastView: PlayerView | null = null;
  alive = true;
  private tokens: number;
  private lastRefill = Date.now();
  private violations = 0;
  private lastRateWarn = 0;

  constructor(
    readonly socket: WebSocket,
    readonly userId: string,
    readonly nationId: NationId,
    readonly spectator: boolean,
    readonly userName: string,
    private readonly rate: { perSecond: number; burst: number },
    private readonly metrics: ProcessMetrics,
  ) {
    this.tokens = rate.burst;
  }

  send(msg: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Client trop lent : on coupe plutôt que d'accumuler en mémoire.
      this.socket.close(1013, 'Client trop lent');
      return;
    }
    const bytes = encodeMessage(msg);
    this.metrics.count('wsBytesOut', bytes.byteLength);
    this.metrics.count('wsMessagesOut');
    this.socket.send(bytes);
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  /** Seau à jetons ; renvoie faux si le message doit être rejeté. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.rate.burst,
      this.tokens + ((now - this.lastRefill) / 1000) * this.rate.perSecond,
    );
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.violations++;
    if (this.violations > this.rate.burst * 5) {
      this.close(1008, 'Trop de messages');
    } else if (now - this.lastRateWarn > 1000) {
      this.lastRateWarn = now;
      this.send({ t: 'error', code: 'rate_limited', message: 'Trop de messages, ralentissez.' });
    }
    return false;
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Protection contre le détournement de WebSocket inter-sites : l'en-tête Origin (s'il est présent)
 * doit correspondre à l'hôte servi. En développement, localhost est accepté (proxy Vite).
 */
function originAllowed(req: FastifyRequest, isProd: boolean): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // clients hors navigateur
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const served = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  if (host === served) return true;
  return !isProd && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

export async function wsGateway(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { host, auth, db, log } = ctx;
  const sockets = new Set<WsConnection>();

  const pinger = setInterval(() => {
    for (const c of sockets) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, PING_INTERVAL_MS);
  pinger.unref();
  app.addHook('onClose', async () => clearInterval(pinger));

  app.get(
    '/ws',
    {
      websocket: true,
      // Authentification et contrôle d'appartenance AVANT la mise à niveau du protocole.
      preValidation: async (req, reply) => {
        if (!originAllowed(req, ctx.config.isProd)) {
          return reply.code(403).send({ error: 'forbidden_origin', message: 'Origine refusée' });
        }
        const q = QuerySchema.safeParse(req.query);
        if (!q.success)
          return reply.code(400).send({ error: 'invalid_query', message: 'gameId invalide' });
        const state = await auth.resolve(req);
        if (!state)
          return reply.code(401).send({ error: 'unauthorized', message: 'Connexion requise' });
        const spectator = q.data.spectate === '1' || q.data.spectate === 'true';
        let nationId: NationId = '';
        if (spectator) {
          // Spectateur : vue publique (aucun secret), lecture seule.
          let access;
          try {
            access = await gameAccess(ctx, q.data.gameId, state);
          } catch {
            return reply.code(404).send({ error: 'not_found', message: 'Partie introuvable' });
          }
          if (!access.canSpectate) {
            return reply
              .code(403)
              .send({ error: 'forbidden', message: 'Partie non ouverte aux spectateurs' });
          }
          if (!ctx.engine?.publicView) {
            return reply
              .code(503)
              .send({ error: 'spectate_unavailable', message: 'Mode spectateur indisponible' });
          }
        } else {
          const [p] = await db
            .select({ nationId: gamePlayers.nationId })
            .from(gamePlayers)
            .where(
              and(eq(gamePlayers.gameId, q.data.gameId), eq(gamePlayers.userId, state.user.id)),
            )
            .limit(1);
          if (!p) {
            return reply
              .code(403)
              .send({ error: 'forbidden', message: 'Vous ne jouez pas dans cette partie' });
          }
          nationId = p.nationId;
        }
        ctx.fingerprints.record(state.user.id, req);
        (req as FastifyRequest & { wsIdentity?: WsIdentity }).wsIdentity = {
          userId: state.user.id,
          userName: state.user.displayName,
          nationId,
          gameId: q.data.gameId,
          spectator,
        };
      },
    },
    (socket, req) => {
      const ident = (req as FastifyRequest & { wsIdentity?: WsIdentity }).wsIdentity!;
      const conn = new WsConnection(
        socket,
        ident.userId,
        ident.nationId,
        ident.spectator,
        ident.userName,
        { perSecond: ctx.options.wsMessagesPerSecond, burst: ctx.options.wsBurst },
        ctx.metrics,
      );
      sockets.add(conn);
      let game: HostedGame | null = null;
      let closed = false;
      const queue: [RawData, boolean][] = [];

      const fail = (err: unknown) => {
        log.error({ err, gameId: ident.gameId }, 'erreur de traitement d’un message WS');
        conn.send({ t: 'error', code: 'internal', message: 'Erreur interne' });
      };

      const handle = (raw: RawData, isBinary: boolean) => {
        if (!conn.take()) return;
        if (!isBinary) {
          conn.send({ t: 'error', code: 'bad_message', message: 'MessagePack binaire attendu' });
          return;
        }
        let decoded: unknown;
        try {
          decoded = decodeMessage(toBytes(raw));
        } catch {
          conn.send({ t: 'error', code: 'bad_message', message: 'Message illisible' });
          return;
        }
        const parsed = ClientMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          const id = (decoded as { t?: unknown; id?: unknown } | null)?.id;
          if ((decoded as { t?: unknown } | null)?.t === 'order' && typeof id === 'number') {
            conn.send({
              t: 'orderResult',
              id,
              ok: false,
              error: 'not_allowed',
              message: 'Ordre invalide',
            });
          } else {
            conn.send({ t: 'error', code: 'bad_message', message: 'Message invalide' });
          }
          return;
        }
        const msg = parsed.data;
        try {
          if (msg.t === 'ping') {
            conn.send({ t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
          } else if (!game || !host.games.has(game.id)) {
            conn.send({ t: 'error', code: 'game_unavailable', message: 'Partie indisponible' });
          } else if (msg.t === 'order') {
            host.handleOrder(game, conn, msg);
          } else if (msg.t === 'control') {
            host.handleControl(game, conn, msg);
          } else if (msg.t === 'chat') {
            ctx.chat.handle(game, conn, msg).catch(fail);
          } else {
            ctx.chat.markRead(game, conn, msg).catch(fail);
          }
        } catch (err) {
          fail(err);
        }
      };

      // Les gestionnaires sont attachés tout de suite : les messages reçus pendant le chargement
      // de la partie sont mis en attente.
      socket.on('message', (raw, isBinary) => {
        if (game) handle(raw, isBinary);
        else if (queue.length < 100) queue.push([raw, isBinary]);
      });
      socket.on('pong', () => {
        conn.alive = true;
      });
      socket.on('close', () => {
        closed = true;
        sockets.delete(conn);
        host.detach(ident.gameId, conn);
      });
      socket.on('error', (err) => log.debug({ err }, 'erreur de socket WS'));

      void (async () => {
        try {
          const g = await host.attach(ident.gameId, conn);
          if (closed) {
            host.detach(ident.gameId, conn);
            return;
          }
          if (!g) {
            conn.send({
              t: 'error',
              code: 'game_unavailable',
              message: 'Partie momentanément indisponible, réessayez dans quelques secondes.',
            });
            conn.close(1013, 'Partie indisponible');
            return;
          }
          game = g;
          if (!conn.spectator) await ctx.chat.sendHistory(g, conn);
          for (const [raw, bin] of queue.splice(0)) handle(raw, bin);
        } catch (err) {
          log.error({ err, gameId: ident.gameId }, 'échec de l’abonnement WS');
          conn.send({ t: 'error', code: 'internal', message: 'Erreur interne' });
          conn.close(1011, 'Erreur interne');
        }
      })();
    },
  );
}
