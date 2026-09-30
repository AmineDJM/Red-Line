import { asc, desc, eq, sql } from 'drizzle-orm';
import type { WeaponSystem } from '@redline/shared';
import type { Db } from '../db/client.js';
import { catalogChanges, catalogReleases, weaponSystems } from '../db/schema.js';

export interface SyncReport {
  inserted: string[];
  updated: string[];
  releaseId: number | null;
}

/** JSON canonique (clés triées) : jsonb ne conserve pas l'ordre des clés. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbOrTx = Db | Tx;

/**
 * Charge les fiches du dépôt dans la base.
 * - Par défaut : insère seulement les fiches absentes (jamais d'écrasement d'une modification du back-office).
 * - `force` (catalog:reset) : réécrit aussi les fiches existantes qui diffèrent du dépôt, avec historique.
 */
export async function syncRepoCatalog(
  db: Db,
  systems: WeaponSystem[],
  opts: { force?: boolean } = {},
): Promise<SyncReport> {
  const report: SyncReport = { inserted: [], updated: [], releaseId: null };
  await db.transaction(async (tx) => {
    const existing = new Map(
      (await tx.select().from(weaponSystems)).map((r) => [r.id, r] as const),
    );
    for (const s of systems) {
      const cur = existing.get(s.id);
      if (!cur) {
        await tx
          .insert(weaponSystems)
          .values({ id: s.id, data: s, enabled: s.enabled, revision: 1, source: 'repo' })
          .onConflictDoNothing();
        report.inserted.push(s.id);
      } else if (opts.force && !sameJson(cur.data, s)) {
        const revision = cur.revision + 1;
        await tx
          .update(weaponSystems)
          .set({ data: s, enabled: s.enabled, revision, source: 'repo', updatedAt: new Date() })
          .where(eq(weaponSystems.id, s.id));
        await tx.insert(catalogChanges).values({
          systemId: s.id,
          revision,
          before: cur.data,
          after: s,
          message: 'catalog:reset (resynchronisation depuis le dépôt)',
          scope: 'new_games',
        });
        report.updated.push(s.id);
      }
    }
    const hasRelease = (await tx.select({ id: catalogReleases.id }).from(catalogReleases).limit(1))
      .length;
    if (report.inserted.length || report.updated.length || !hasRelease) {
      report.releaseId = await createRelease(
        tx,
        null,
        opts.force ? 'catalog:reset' : 'Chargement du catalogue du dépôt',
      );
    }
  });
  return report;
}

export async function listSystems(db: DbOrTx): Promise<(typeof weaponSystems.$inferSelect)[]> {
  return db.select().from(weaponSystems).orderBy(asc(weaponSystems.id));
}

export async function createRelease(
  db: DbOrTx,
  authorId: string | null,
  message: string,
): Promise<number> {
  const rows = await listSystems(db);
  const [r] = await db
    .insert(catalogReleases)
    .values({ authorId, message, snapshot: rows.map((x) => x.data) })
    .returning({ id: catalogReleases.id });
  return r!.id;
}

export async function latestReleaseId(db: DbOrTx): Promise<number | null> {
  const [r] = await db
    .select({ id: catalogReleases.id })
    .from(catalogReleases)
    .orderBy(desc(catalogReleases.id))
    .limit(1);
  return r?.id ?? null;
}

export async function releaseSnapshot(db: DbOrTx, id: number): Promise<WeaponSystem[] | null> {
  const [r] = await db
    .select({ snapshot: catalogReleases.snapshot })
    .from(catalogReleases)
    .where(eq(catalogReleases.id, id));
  return r?.snapshot ?? null;
}

export async function countSystems(db: DbOrTx): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(weaponSystems);
  return r?.n ?? 0;
}
