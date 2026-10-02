/**
 * Anciens noms de provinces (avant la fusion, consolidate.ts) → province fusionnée qui les contient :
 * data/map/aliases.json, écrit par build.ts. Les désignations par nom (resources-data.ts) restent
 * valides après une fusion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR } from './sources.js';

const FILE = join(REPO_DIR, 'data', 'map', 'aliases.json');

/** « nation:Ancien nom » → identifiant de province ({} si le fichier est absent). */
export const MAP_ALIASES: Record<string, string> = existsSync(FILE)
  ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>)
  : {};
