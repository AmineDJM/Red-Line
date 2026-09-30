import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { schema } from './schema.js';
import { MIGRATIONS_DIR } from '../paths.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { application_name: 'redline-server' },
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Applique les migrations SQL de apps/server/drizzle (idempotent). */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
