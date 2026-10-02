// Régénère apps/client/public/world.svg (fond « matrice de points » de l'accueil et des pages publiques)
// à partir de data/map/provinces.geojson. Usage : pnpm --filter @redline/site world
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './paths.js';
import { worldDotsSvg, type FeatureCollection } from './world.js';

const fc = JSON.parse(
  readFileSync(join(REPO, 'data/map/provinces.geojson'), 'utf8'),
) as FeatureCollection;
const svg = worldDotsSvg(fc);
const out = join(REPO, 'apps/client/public/world.svg');
writeFileSync(out, svg);
console.log(`${out} : ${(svg.length / 1024).toFixed(1)} Kio`);
