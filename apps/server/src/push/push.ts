import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import {
  frForms,
  frPlural,
  type GameNotification,
  type Locale,
  type NationId,
} from '@redline/shared';
import type { Db } from '../db/client.js';
import { pushSubscriptions, serverSettings, users } from '../db/schema.js';
import { accountLocale, placeName, serverT } from '../i18n/index.js';
import type { Engine } from '../engine.js';
import type { GameHost, HostedGame } from '../host/game-host.js';
import type { DataStore } from '../data/store.js';
import type { ProcessMetrics } from '../metrics.js';
import type { Auth } from '../auth/auth.js';
import { checkRole } from '../auth/auth.js';
import { parseBody } from '../http/util.js';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Envoi effectif (web-push en production ; faux émetteur dans les tests). */
export interface PushSender {
  send(
    target: PushTarget,
    payload: string,
    vapid: VapidKeys & { subject: string },
  ): Promise<{ statusCode: number }>;
}

export const webPushSender: PushSender = {
  async send(target, payload, vapid) {
    const r = await webpush.sendNotification(target, payload, {
      vapidDetails: vapid,
      TTL: 6 * 3600,
      urgency: 'high',
    });
    return { statusCode: r.statusCode };
  },
};

export type PushCategory = 'attack' | 'capture' | 'intel' | 'council' | 'endgame';

export interface PushPayload {
  title: string;
  body: string;
  gameId: string;
  category: PushCategory;
  url: string;
}

/**
 * Services de notification des navigateurs (Chrome/Edge/Opera/Samsung : FCM ; Firefox : Mozilla ;
 * Safari : Apple ; anciens Edge : WNS). Toute autre adresse est refusée : le serveur ne doit jamais
 * envoyer de requête vers une adresse choisie par un utilisateur (SSRF vers le réseau interne).
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

export function pushEndpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const SubscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine(pushEndpointAllowed, 'Service de notification non reconnu'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
  expirationTime: z.number().nullable().optional(),
});

/**
 * Notifications Web Push (VAPID). Clés générées au premier démarrage et stockées en base
 * (server_settings), sauf si VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY sont fournies.
 * Envoi quand un événement majeur survient pour un joueur NON connecté à la partie :
 * attaque, capture, flash de renseignement, vote du Conseil, fin de partie.
 */
export class PushService {
  keys: VapidKeys | null = null;
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly deps: {
      db: Db;
      host: GameHost;
      engine: Engine | null;
      store: DataStore;
      log: FastifyBaseLogger;
      metrics: ProcessMetrics;
      sender: PushSender;
      subject: string;
      envKeys: VapidKeys | null;
      throttleMs: number;
    },
  ) {}

  async init(): Promise<void> {
    if (this.deps.envKeys) {
      this.keys = this.deps.envKeys;
      return;
    }
    const read = async () => {
      const [r] = await this.deps.db
        .select()
        .from(serverSettings)
        .where(eq(serverSettings.key, 'vapid'));
      return (r?.value as VapidKeys | undefined) ?? null;
    };
    let keys = await read();
    if (!keys) {
      const gen = webpush.generateVAPIDKeys();
      // Plusieurs instances au démarrage : la première écriture gagne, les autres la relisent.
      await this.deps.db
        .insert(serverSettings)
        .values({ key: 'vapid', value: gen })
        .onConflictDoNothing();
      keys = await read();
      this.deps.log.info('clés VAPID générées et enregistrées');
    }
    this.keys = keys;
  }

  /** Traduit les notifications brutes en alertes push pour chaque joueur absent. */
  onNotes(g: HostedGame, notes: GameNotification[]): void {
    const engine = this.deps.engine;
    if (!engine || !this.keys) return;
    const absent = g.players.filter((p) => p.userId && !this.deps.host.isConnected(g, p.userId));
    if (absent.length === 0) return;
    const major = notes.filter((n) =>
      [
        'war_declared',
        'province_capture_started',
        'province_captured',
        'unit_destroyed',
        'intel_report',
        'council',
        'victory',
        'nation_defeated',
      ].includes(n.kind),
    );
    if (major.length === 0) return;
    const data = this.deps.store.current();
    // Français : noms accordés (« Le Maroc vous déclare la guerre », « Les États-Unis attaquent… »).
    const nation = (id: string) => {
      const d = data.nationsById.get(id);
      return { ...frForms(d?.name ?? id, d?.article), pl: frPlural(d?.article) };
    };
    const provinceFr = (id: string) => data.map?.provinces.find((p) => p.id === id)?.name ?? id;
    // Autres langues : gabarits traduits (apps/server/src/i18n) et noms localisés.
    const nationIn = (l: Locale, id: string) =>
      placeName(l, 'nations', id, data.nationsById.get(id)?.name ?? id);
    const provinceIn = (l: Locale, id: string) => placeName(l, 'provinces', id, provinceFr(id));
    let owners: Record<string, NationId> | null = null;
    const ownerOf = (pid: string) => {
      if (!engine.ownersFrame) return null;
      owners ??= engine.ownersFrame(g.state);
      return owners[pid] ?? null;
    };
    const out: { userId: string; cat: PushCategory; body: (l: Locale) => string }[] = [];
    for (const p of absent) {
      const me = p.nationId;
      let mine: GameNotification[];
      try {
        mine = engine.notificationsFor(g.state, me, major);
      } catch {
        continue;
      }
      for (const n of mine) {
        let cat: PushCategory | null = null;
        let body: ((l: Locale) => string) | null = null;
        switch (n.kind) {
          case 'war_declared':
            if (n.against === me) {
              cat = 'attack';
              body = (l) =>
                l === 'fr'
                  ? `${nation(n.by).NationLe} ${nation(n.by).pl ? 'vous déclarent' : 'vous déclare'} la guerre.`
                  : serverT(l, 'push.war', { nation: nationIn(l, n.by) });
            }
            break;
          case 'province_capture_started':
            if (n.by !== me && ownerOf(n.provinceId) === me) {
              cat = 'attack';
              body = (l) =>
                l === 'fr'
                  ? `${nation(n.by).NationLe} ${nation(n.by).pl ? 'attaquent' : 'attaque'} ${provinceFr(n.provinceId)}.`
                  : serverT(l, 'push.attack', {
                      nation: nationIn(l, n.by),
                      province: provinceIn(l, n.provinceId),
                    });
            }
            break;
          case 'unit_destroyed':
            if (n.owner === me) {
              cat = 'attack';
              body = (l) => serverT(l, 'push.losses');
            }
            break;
          case 'province_captured':
            if (n.from === me) {
              cat = 'capture';
              body = (l) =>
                l === 'fr'
                  ? `${provinceFr(n.provinceId)} : capture par ${nation(n.by).nationLe}.`
                  : serverT(l, 'push.provinceLost', {
                      nation: nationIn(l, n.by),
                      province: provinceIn(l, n.provinceId),
                    });
            } else if (n.by === me) {
              cat = 'capture';
              body = (l) =>
                serverT(l, 'push.provinceTaken', { province: provinceIn(l, n.provinceId) });
            }
            break;
          case 'intel_report':
            if (n.flash) {
              cat = 'intel';
              body = (l) => serverT(l, 'push.flash');
            }
            break;
          case 'council':
            cat = 'council';
            body = (l) =>
              l === 'fr'
                ? `Conseil de sécurité : ${n.text}`.slice(0, 180)
                : serverT(l, 'push.council');
            break;
          case 'victory':
            cat = 'endgame';
            body = (l) =>
              n.winner === me
                ? serverT(l, 'push.victory')
                : l === 'fr'
                  ? `Victoire ${nation(n.winner).deNation}. La partie est terminée.`
                  : serverT(l, 'push.victoryOf', { nation: nationIn(l, n.winner) });
            break;
          case 'nation_defeated':
            if (n.nationId === me) {
              cat = 'endgame';
              body = (l) => serverT(l, 'push.defeated');
            }
            break;
        }
        if (cat && body) out.push({ userId: p.userId!, cat, body });
      }
    }
    if (out.length) void this.sendLocalized(g, out);
  }

  /** Rédige chaque alerte dans la langue du compte destinataire, puis l'envoie. */
  private async sendLocalized(
    g: HostedGame,
    out: { userId: string; cat: PushCategory; body: (l: Locale) => string }[],
  ): Promise<void> {
    const ids = [...new Set(out.map((o) => o.userId))];
    const rows = await this.deps.db
      .select({ id: users.id, locale: users.locale })
      .from(users)
      .where(inArray(users.id, ids))
      .catch(() => []);
    const localeOf = new Map(rows.map((r) => [r.id, accountLocale(r.locale)]));
    for (const o of out) {
      const l = localeOf.get(o.userId) ?? 'fr';
      void this.notifyUser(o.userId, {
        title: serverT(l, 'push.title', { game: g.meta.name }),
        body: o.body(l),
        gameId: g.id,
        category: o.cat,
        url: `/?partie=${g.id}`,
      });
    }
  }

  /** Envoie une alerte à tous les appareils de l'utilisateur (limitée par catégorie et partie). */
  async notifyUser(userId: string, payload: PushPayload, now = Date.now()): Promise<number> {
    if (!this.keys) return 0;
    const key = `${userId}|${payload.gameId}|${payload.category}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.deps.throttleMs) return 0;
    this.lastSent.set(key, now);
    if (this.lastSent.size > 50_000) this.lastSent.clear();
    const subs = await this.deps.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    let sent = 0;
    const gone: number[] = [];
    const vapid = { ...this.keys, subject: this.deps.subject };
    await Promise.all(
      subs.map(async (s) => {
        if (!pushEndpointAllowed(s.endpoint)) {
          gone.push(s.id);
          return;
        }
        try {
          const r = await this.deps.sender.send(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            vapid,
          );
          if (r.statusCode >= 200 && r.statusCode < 300) sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) gone.push(s.id);
          else this.deps.log.debug({ err }, 'notification push en échec');
        }
      }),
    );
    if (gone.length) {
      await this.deps.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
    }
    if (sent) {
      this.deps.metrics.count('push', sent);
      await this.deps.db
        .update(pushSubscriptions)
        .set({ lastSentAt: new Date(now) })
        .where(eq(pushSubscriptions.userId, userId));
    }
    return sent;
  }

  routes(app: FastifyInstance, auth: Auth): void {
    app.get('/api/push/key', async () => {
      if (!this.keys) {
        return { publicKey: null };
      }
      return { publicKey: this.keys.publicKey };
    });

    app.post('/api/push/subscribe', async (req, reply) => {
      const { user } = checkRole(await auth.authenticate(req, reply), 'player');
      const body = parseBody(SubscribeSchema, req.body);
      await this.deps.db
        .insert(pushSubscriptions)
        .values({
          userId: user.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth },
        });
      return { ok: true };
    });

    app.delete('/api/push/subscribe', async (req, reply) => {
      const { user } = checkRole(await auth.authenticate(req, reply), 'player');
      const body = parseBody(z.object({ endpoint: z.string().max(1000).optional() }), req.body);
      const rows = await this.deps.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, user.id));
      const ids = rows
        .filter((r) => !body.endpoint || r.endpoint === body.endpoint)
        .map((r) => r.id);
      if (ids.length) {
        await this.deps.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, ids));
      }
      return { ok: true };
    });
  }
}
