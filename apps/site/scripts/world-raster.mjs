// Version matricielle de la carte « matrice de points » (apps/client/public/world.svg) : l'image vectorielle
// (des milliers de points) coûte cher à rastériser sur le fil principal ; le WebP se décode hors du fil
// principal. Produit apps/client/public/world.webp (jeu et pages publiques), à committer.
// Usage : node apps/site/scripts/world-raster.mjs [largeur=2160]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('@playwright/test');

const width = Number(process.argv[2] ?? 2160);
const svg = readFileSync(join(repo, 'apps/client/public/world.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const b64 = await page.evaluate(
  async ([src, w]) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(src)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((w * 140) / 360);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.8).split(',')[1];
  },
  [svg, width],
);
await browser.close();
const out = join(repo, 'apps/client/public/world.webp');
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`${out} : ${(Buffer.from(b64, 'base64').length / 1024).toFixed(1)} Kio`);
