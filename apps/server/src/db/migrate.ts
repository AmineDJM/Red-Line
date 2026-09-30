/** `pnpm --filter @redline/server db:migrate` : applique les migrations sur DATABASE_URL. */
import { runMigrations } from './client.js';
import { MIGRATIONS_DIR } from '../paths.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL est obligatoire');
  process.exit(1);
}
try {
  await runMigrations(url);
  console.log(`Migrations appliquées (${MIGRATIONS_DIR}).`);
} catch (err) {
  console.error('Échec des migrations :', err);
  process.exit(1);
}
