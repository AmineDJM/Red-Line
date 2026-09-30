// Aperçu des images sources (avant recadrage) de quelques systèmes, pour régler « focus » et « zoom ».
//
//   pnpm --filter @redline/tools-art preview -- <dossier> us.f-16 ru.su-57 …
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CACHE_DIR, SELECTION, type Selection, readJson } from './lib.js';
import { contactSheet } from './sheet.js';

const [outDir = '.', ...ids] = process.argv.slice(2).filter((a) => a !== '--');
const selection = await readJson<Record<string, Selection | { none: string }>>(SELECTION);
const tiles = [];
for (const id of ids) {
  const sel = selection[id];
  if (!sel || 'none' in sel) continue;
  const key = createHash('sha1').update(sel.thumbUrl).digest('hex').slice(0, 16);
  const image = await readFile(join(CACHE_DIR, 'dl', `${key}.img`)).catch(() => null);
  tiles.push({ image, label: id, sub: `${sel.width}×${sel.height} ${sel.title.slice(5, 50)}` });
}
const out = resolve(outDir, 'preview.jpg');
await contactSheet(tiles, out, { cols: 3, w: 600, h: 400, fit: 'contain' });
console.log(out);
