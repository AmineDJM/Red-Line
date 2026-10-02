/**
 * Génère data/map/routes.json à partir de la carte déjà construite (aussi appelé par build.ts) :
 *   pnpm --filter @redline/tools-map routes
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CellsFileSchema,
  ProvinceDefSchema,
  RoutesFileSchema,
  StraitSchema,
} from '@redline/shared';
import { formatRoutes, generateRoutes } from './routes.js';
import { REPO_DIR } from './sources.js';

export function buildRoutesFile(mapDir = join(REPO_DIR, 'data', 'map')): number {
  const t0 = Date.now();
  const j = (n: string) => JSON.parse(readFileSync(join(mapDir, n), 'utf8')) as unknown;
  const { file, stats } = generateRoutes({
    provinces: ProvinceDefSchema.array().parse(j('provinces.json')),
    cells: CellsFileSchema.parse(j('cells.json')),
    straits: StraitSchema.array().parse(j('straits.json')),
  });
  const text = formatRoutes(RoutesFileSchema.parse(file));
  writeFileSync(join(mapDir, 'routes.json'), text);
  console.log(
    `Routes : ${file.nodes.length} nœuds (${Object.entries(stats.nodes)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}), ${stats.edges} arêtes, ${stats.points} points, ${stats.pruned} élaguées, ` +
      `${stats.repaired} réparations, ${stats.crossings} croisements, ${(Buffer.byteLength(text) / 1e6).toFixed(2)} Mo, ` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  return Buffer.byteLength(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildRoutesFile();
