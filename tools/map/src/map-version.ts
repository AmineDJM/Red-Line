/**
 * Version de la carte (data/map/version.json). Une partie épingle la version de la carte à sa
 * création (games.map_version) : quand les identifiants de province ou les cellules H3 changent
 * (fusion, redécoupage), l'ancienne carte est copiée telle quelle dans data/map/archive/<version>/
 * et la version est incrémentée ; le serveur recharge les parties anciennes avec leur carte.
 *
 * L'empreinte (`fingerprint`) couvre les identifiants de province et l'attribution des cellules :
 * test/map.test.ts échoue si la carte générée ne correspond plus à version.json (changement
 * d'identifiants sans nouvelle version). Les autres champs (noms, ressources, rendements) peuvent
 * évoluer sans nouvelle version.
 *   pnpm --filter @redline/tools-map map-version    (affiche l'empreinte de data/map)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_DIR } from './sources.js';

export interface MapVersionFile {
  version: number;
  provinces: number;
  fingerprint: string;
  /** Empreinte de chaque carte archivée (data/map/archive/<version>/, jamais modifiée). */
  archives: Record<string, string>;
}

/** Empreinte des identifiants de province et de l'attribution des cellules. */
export function mapFingerprint(provinceIds: string[], cells: Record<string, string>): string {
  const h = createHash('sha1');
  h.update([...provinceIds].sort().join(','));
  for (const c of Object.keys(cells).sort()) h.update(`${c}=${cells[c]};`);
  return h.digest('hex').slice(0, 16);
}

export function fingerprintOf(mapDir: string): { provinces: number; fingerprint: string } {
  const provs = JSON.parse(readFileSync(join(mapDir, 'provinces.json'), 'utf8')) as {
    id: string;
  }[];
  const cells = (
    JSON.parse(readFileSync(join(mapDir, 'cells.json'), 'utf8')) as {
      cells: Record<string, string>;
    }
  ).cells;
  return {
    provinces: provs.length,
    fingerprint: mapFingerprint(
      provs.map((p) => p.id),
      cells,
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join(REPO_DIR, 'data', 'map');
  const cur = fingerprintOf(dir);
  const file = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')) as MapVersionFile;
  console.log(JSON.stringify({ ...file, ...cur }, null, 2));
  if (cur.fingerprint !== file.fingerprint)
    console.log(
      `\nEmpreinte différente de version.json (${file.fingerprint}) : copier l'ancienne carte dans ` +
        `data/map/archive/${file.version}/ puis passer à la version ${file.version + 1}.`,
    );
}
