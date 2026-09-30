import type postgres from 'postgres';

/**
 * Bail de partie (colonnes games.lease_owner / games.lease_until + battement de cœur).
 * Un processus ne simule que les parties dont il détient le bail. Pendant un déploiement Render,
 * l'ancienne instance relâche ses baux à l'arrêt et la nouvelle les reprend au battement suivant ;
 * si l'ancienne meurt sans relâcher, le bail expire au bout de `ttlS` secondes.
 */
export class LeaseManager {
  constructor(
    private readonly sql: postgres.Sql,
    readonly owner: string,
    readonly ttlS: number,
  ) {}

  async tryAcquire(gameId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE games SET lease_owner = ${this.owner},
        lease_until = now() + make_interval(secs => ${this.ttlS})
      WHERE id = ${gameId}
        AND status IN ('running', 'paused', 'ended')
        AND (lease_owner IS NULL OR lease_owner = ${this.owner} OR lease_until < now())
      RETURNING id`;
    return rows.length === 1;
  }

  /** Renouvelle les baux ; renvoie les parties dont on détient toujours le bail. */
  async heartbeat(gameIds: string[]): Promise<Set<string>> {
    if (gameIds.length === 0) return new Set();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE games SET lease_until = now() + make_interval(secs => ${this.ttlS})
      WHERE lease_owner = ${this.owner} AND id = ANY(${gameIds}::uuid[])
      RETURNING id`;
    return new Set(rows.map((r) => r.id));
  }

  async release(gameIds: string[]): Promise<void> {
    if (gameIds.length === 0) return;
    await this.sql`
      UPDATE games SET lease_owner = NULL, lease_until = NULL
      WHERE lease_owner = ${this.owner} AND id = ANY(${gameIds}::uuid[])`;
  }

  /** Parties actives sans bail valide (orphelines) — à adopter. */
  async orphans(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM games
      WHERE status IN ('running', 'paused')
        AND (lease_owner IS NULL OR lease_owner = ${this.owner} OR lease_until < now())
      ORDER BY created_at`;
    return rows.map((r) => r.id);
  }

  async holds(gameId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM games WHERE id = ${gameId} AND lease_owner = ${this.owner} AND lease_until > now()`;
    return rows.length === 1;
  }
}
