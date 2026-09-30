/**
 * `pnpm --filter @redline/server catalog:reset` : force la resynchronisation du catalogue de la base
 * avec les fichiers data/catalog/*.json (écrase les modifications du back-office, avec historique).
 * Les fiches présentes en base mais absentes du dépôt sont conservées.
 */
import pino from 'pino';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { loadGameData } from '../data/loader.js';
import { syncRepoCatalog } from '../data/catalog-store.js';

const log = pino({ level: 'info' });
const config = loadConfig();
const dbh = createDb(config.databaseUrl, { max: 2 });
try {
  const data = await loadGameData(config.dataDir, log);
  if (data.catalogErrors.length) {
    log.error({ errors: data.catalogErrors }, 'catalogue du dépôt invalide : abandon');
    process.exitCode = 1;
  } else {
    const r = await syncRepoCatalog(dbh.db, data.repoCatalog, { force: true });
    log.info(
      { inserted: r.inserted.length, updated: r.updated.length, releaseId: r.releaseId },
      'catalogue resynchronisé depuis le dépôt',
    );
  }
} finally {
  await dbh.close();
}
