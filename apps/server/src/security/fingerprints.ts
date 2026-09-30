import { createHash, createHmac } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { gamePlayers, userFingerprints, users } from '../db/schema.js';

/** Enregistrement d'une même empreinte au plus toutes les 10 minutes. */
const THROTTLE_MS = 10 * 60_000;

export interface SuspiciousPair {
  users: { id: string; name: string; email: string | null; isGuest: boolean; banned: boolean }[];
  score: number;
  reasons: string[];
  /** Parties où les deux comptes jouent ensemble. */
  sharedGames: string[];
}

function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 24; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Empreintes de connexion pour la détection des multi-comptes et de la triche :
 * IP hachée (HMAC avec le secret de session : aucune IP en clair n'est stockée), user-agent haché,
 * histogramme d'activité horaire, comptes liés jouant dans la même partie.
 */
export class Fingerprints {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  hashIp(ip: string): string {
    return createHmac('sha256', this.secret).update(`ip:${ip}`).digest('base64url').slice(0, 22);
  }

  private hashUa(ua: string): string {
    return createHash('sha256').update(ua).digest('base64url').slice(0, 16);
  }

  /** Enregistre l'empreinte de la requête (asynchrone, jamais bloquant). */
  record(userId: string, req: FastifyRequest, now = Date.now()): void {
    const ipHash = this.hashIp(req.ip ?? '');
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
    const uaHash = this.hashUa(ua);
    const key = `${userId}|${ipHash}|${uaHash}`;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < THROTTLE_MS) return;
    this.recent.set(key, now);
    if (this.recent.size > 50_000) this.recent.clear();
    const hour = new Date(now).getUTCHours();
    void (async () => {
      await this.db
        .insert(userFingerprints)
        .values({ userId, ipHash, uaHash, userAgent: ua || null })
        .onConflictDoUpdate({
          target: [userFingerprints.userId, userFingerprints.ipHash, userFingerprints.uaHash],
          set: { lastSeen: new Date(now), hits: sql`${userFingerprints.hits} + 1` },
        });
      await this.db.execute(sql`
        UPDATE users SET activity_hours = jsonb_set(
          COALESCE(activity_hours, '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb),
          ARRAY[${String(hour)}]::text[],
          to_jsonb(COALESCE((activity_hours->>(${hour}::int))::int, 0) + 1))
        WHERE id = ${userId}`);
    })().catch((err) => this.log.warn({ err }, 'empreinte non enregistrée'));
  }

  /**
   * Paires de comptes suspectes, triées par score :
   * IP partagée (+2), même navigateur (+1), horaires d'activité très proches (+1),
   * joueurs de la même partie (+3 : multi-compte pour se renforcer).
   */
  async suspicious(limit = 200): Promise<SuspiciousPair[]> {
    const shared = await this.db
      .select({
        ipHash: userFingerprints.ipHash,
        ids: sql<string[]>`array_agg(DISTINCT ${userFingerprints.userId})`,
      })
      .from(userFingerprints)
      .groupBy(userFingerprints.ipHash)
      .having(sql`count(DISTINCT ${userFingerprints.userId}) > 1`)
      .limit(2000);
    const pairKeys = new Map<string, [string, string]>();
    for (const row of shared) {
      const ids = [...row.ids].sort();
      if (ids.length > 30) continue; // IP de réseau partagé (école, opérateur) : trop large pour conclure
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          pairKeys.set(`${ids[i]}|${ids[j]}`, [ids[i]!, ids[j]!]);
    }
    if (pairKeys.size === 0) return [];
    const allIds = [...new Set([...pairKeys.values()].flat())];
    const [fps, us, gp] = await Promise.all([
      this.db.select().from(userFingerprints).where(inArray(userFingerprints.userId, allIds)),
      this.db.select().from(users).where(inArray(users.id, allIds)),
      this.db
        .select({ gameId: gamePlayers.gameId, userId: gamePlayers.userId })
        .from(gamePlayers)
        .where(inArray(gamePlayers.userId, allIds)),
    ]);
    const byUser = new Map(us.map((u) => [u.id, u]));
    const ipsOf = new Map<string, Set<string>>();
    const uasOf = new Map<string, Set<string>>();
    for (const f of fps) {
      (ipsOf.get(f.userId) ?? ipsOf.set(f.userId, new Set()).get(f.userId)!).add(f.ipHash);
      (uasOf.get(f.userId) ?? uasOf.set(f.userId, new Set()).get(f.userId)!).add(f.uaHash);
    }
    const gamesOf = new Map<string, Set<string>>();
    for (const p of gp) {
      if (!p.userId) continue;
      (gamesOf.get(p.userId) ?? gamesOf.set(p.userId, new Set()).get(p.userId)!).add(p.gameId);
    }
    const out: SuspiciousPair[] = [];
    for (const [a, b] of pairKeys.values()) {
      const ua = byUser.get(a);
      const ub = byUser.get(b);
      if (!ua || !ub) continue;
      const reasons: string[] = [];
      let score = 0;
      const sharedIps = [...(ipsOf.get(a) ?? [])].filter((x) => ipsOf.get(b)?.has(x)).length;
      score += 2;
      reasons.push(`IP partagée (${sharedIps})`);
      if ([...(uasOf.get(a) ?? [])].some((x) => uasOf.get(b)?.has(x))) {
        score += 1;
        reasons.push('même navigateur');
      }
      const sim = cosine(ua.activityHours ?? null, ub.activityHours ?? null);
      if (sim > 0.9) {
        score += 1;
        reasons.push(`horaires d'activité similaires (${Math.round(sim * 100)} %)`);
      }
      const sharedGames = [...(gamesOf.get(a) ?? [])].filter((g) => gamesOf.get(b)?.has(g));
      if (sharedGames.length) {
        score += 3;
        reasons.push(`jouent dans la même partie (${sharedGames.length})`);
      }
      out.push({
        users: [ua, ub].map((u) => ({
          id: u.id,
          name: u.displayName,
          email: u.email,
          isGuest: u.isGuest,
          banned: !!u.bannedAt,
        })),
        score,
        reasons,
        sharedGames,
      });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}
