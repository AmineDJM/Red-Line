import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { GameStats } from '@redline/engine';
import type { RankingEntry, SeasonView } from '@redline/shared';
import type { Db } from '../db/client.js';
import { gameResults, rankings, seasons, userCosmetics, users } from '../db/schema.js';
import type { HostedGame } from '../host/game-host.js';
import { HttpError } from '../auth/auth.js';
import type { ShopConfig } from '../shop/config.js';

type SeasonRow = typeof seasons.$inferSelect;

const toSeasonView = (s: SeasonRow): SeasonView => ({
  id: s.id,
  name: s.name,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  rewards: s.rewards,
});

/** Points d'une nation en fin de partie (barème de shop/config.json). */
export function pointsFor(
  cfg: ShopConfig['points'],
  won: boolean,
  s: GameStats['nations'][string] | undefined,
): number {
  let p = cfg.participation + (won ? cfg.win : 0);
  if (s) p += s.conquered * cfg.perProvinceConquered + s.kills * cfg.perKill;
  return Math.max(0, Math.round(p));
}

/**
 * Classements par saison : résultats de fin de partie (moteur.stats), points, récompenses cosmétiques
 * attribuées à la clôture de la saison. Seules les parties multijoueurs avec au moins
 * `points.minHumanPlayers` joueurs humains rapportent des points (pas de points en solo contre l'IA).
 */
export class RankingService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: ShopConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.maintain().catch(() => {}), 3600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Clôt les saisons échues (récompenses) et ouvre la saison courante si besoin. Idempotent. */
  async maintain(now = new Date()): Promise<SeasonRow> {
    const ended = await this.db
      .select()
      .from(seasons)
      .where(and(lte(seasons.endsAt, now), isNull(seasons.closedAt)));
    for (const s of ended) await this.close(s.id, now);
    return this.current(now);
  }

  async current(now = new Date()): Promise<SeasonRow> {
    const [cur] = await this.db
      .select()
      .from(seasons)
      .where(and(lte(seasons.startsAt, now), gt(seasons.endsAt, now)))
      .orderBy(desc(seasons.startsAt))
      .limit(1);
    if (cur) return cur;
    const count =
      (await this.db.select({ n: sql<number>`count(*)::int` }).from(seasons))[0]?.n ?? 0;
    const s = {
      id: `s${count + 1}`,
      name: `Saison ${count + 1}`,
      startsAt: now,
      endsAt: new Date(now.getTime() + this.cfg.seasons.lengthDays * 86_400_000),
      rewards: this.cfg.seasons.rewards,
    };
    await this.db.insert(seasons).values(s).onConflictDoNothing();
    const [row] = await this.db.select().from(seasons).where(eq(seasons.id, s.id));
    this.log.info({ season: s.id }, 'nouvelle saison ouverte');
    return row!;
  }

  /** Clôture : une seule instance gagne (UPDATE … WHERE closed_at IS NULL), puis récompenses. */
  async close(seasonId: string, now = new Date()): Promise<boolean> {
    const [s] = await this.db
      .update(seasons)
      .set({ closedAt: now })
      .where(and(eq(seasons.id, seasonId), isNull(seasons.closedAt)))
      .returning();
    if (!s) return false;
    const top = await this.entries(seasonId, Math.max(0, ...s.rewards.map((r) => r.rank)));
    for (const e of top) {
      // Récompense du meilleur palier atteint (rang <= palier), et de tous les paliers inférieurs.
      for (const r of s.rewards) {
        if (e.rank <= r.rank) {
          await this.db
            .insert(userCosmetics)
            .values({ userId: e.userId, cosmeticId: r.cosmeticId, source: 'season' })
            .onConflictDoNothing();
        }
      }
    }
    this.log.info({ season: seasonId, rewarded: top.length }, 'saison clôturée');
    return true;
  }

  async entries(seasonId: string, limit = 100): Promise<RankingEntry[]> {
    const rows = await this.db
      .select({ r: rankings, name: users.displayName })
      .from(rankings)
      .innerJoin(users, eq(users.id, rankings.userId))
      .where(eq(rankings.seasonId, seasonId))
      .orderBy(desc(rankings.points), desc(rankings.wins), asc(rankings.updatedAt))
      .limit(limit);
    return rows.map((x, i) => ({
      rank: i + 1,
      userId: x.r.userId,
      name: x.name,
      points: x.r.points,
      wins: x.r.wins,
      games: x.r.games,
    }));
  }

  /** Fin de partie : résultats par joueur (idempotent) et points de saison. */
  async onGameEnded(g: HostedGame, stats: GameStats | null): Promise<void> {
    const humans = g.players.filter((p) => p.userId);
    if (humans.length === 0) return;
    const ranked = g.meta.mode === 'multi' && humans.length >= this.cfg.points.minHumanPlayers;
    const season = ranked ? await this.current() : null;
    for (const p of humans) {
      const won = g.winner === p.nationId;
      const points = ranked ? pointsFor(this.cfg.points, won, stats?.nations[p.nationId]) : 0;
      const inserted = await this.db
        .insert(gameResults)
        .values({
          gameId: g.id,
          userId: p.userId!,
          nationId: p.nationId,
          seasonId: season?.id ?? null,
          won,
          points,
        })
        .onConflictDoNothing()
        .returning({ id: gameResults.gameId });
      if (!inserted.length || !season) continue;
      await this.db
        .insert(rankings)
        .values({ seasonId: season.id, userId: p.userId!, points, wins: won ? 1 : 0, games: 1 })
        .onConflictDoUpdate({
          target: [rankings.seasonId, rankings.userId],
          set: {
            points: sql`${rankings.points} + ${points}`,
            wins: sql`${rankings.wins} + ${won ? 1 : 0}`,
            games: sql`${rankings.games} + 1`,
            updatedAt: new Date(),
          },
        });
    }
  }

  routes(app: FastifyInstance): void {
    app.get('/api/seasons', async () => {
      await this.current();
      const rows = await this.db.select().from(seasons).orderBy(desc(seasons.startsAt)).limit(50);
      return { seasons: rows.map(toSeasonView) };
    });

    app.get('/api/rankings', async (req) => {
      const q = req.query as { season?: string };
      let season: SeasonRow | undefined;
      if (q.season) {
        [season] = await this.db
          .select()
          .from(seasons)
          .where(eq(seasons.id, String(q.season)));
        if (!season) throw new HttpError(404, 'not_found', 'Saison introuvable');
      } else season = await this.current();
      return { season: toSeasonView(season), entries: await this.entries(season.id) };
    });
  }
}
