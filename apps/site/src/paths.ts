import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du paquet apps/site. */
export const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Racine du dépôt. */
export const REPO = resolve(SITE_ROOT, '../..');
/** Contenus éditoriaux par langue (content/<langue>/site.json et content/<langue>/legal/*.md). */
export const CONTENT_DIR = join(SITE_ROOT, 'content');
/** Sortie du build (servie par apps/server, variable SITE_DIST). */
export const DIST_DIR = join(SITE_ROOT, 'dist');
