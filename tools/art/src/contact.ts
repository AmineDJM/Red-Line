// Planches contact des photos produites (miniatures finales), pour la relecture visuelle.
//
//   pnpm --filter @redline/tools-art contact -- <dossier de sortie> [catégorie ou systemId…]
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MANIFEST, PHOTO_DIR, catalog, chunks, readJson } from './lib.js';
import { contactSheet } from './sheet.js';

const [outDir = '.', ...cats] = process.argv.slice(2).filter((a) => a !== '--');
const manifest = await readJson<Record<string, { license: string; credit: string }>>(MANIFEST);
const systems = (await catalog()).filter(
  (s) => cats.length === 0 || cats.includes(s.category) || cats.includes(s.id),
);
const perSheet = 30;
for (const [n, group] of chunks(systems, perSheet).entries()) {
  const tiles = [];
  for (const s of group) {
    const m = manifest[s.id];
    tiles.push({
      image: m ? await readFile(join(PHOTO_DIR, `${s.id}.thumb.webp`)) : null,
      label: s.id,
      sub: m ? `${m.license} · ${m.credit}` : 'SANS PHOTO',
    });
  }
  const out = resolve(outDir, `planche-${String(n + 1).padStart(2, '0')}.jpg`);
  await contactSheet(tiles, out, { cols: 6, w: 300, h: 188 });
  console.log(out);
}
