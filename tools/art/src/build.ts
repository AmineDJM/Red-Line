// Étape 2 : télécharge les photos choisies (selection.json), les recadre en 16:10, les étalonne et produit
// les WebP du client, le manifeste data/art/photos.json et data/art/CREDITS.md.
//
//   pnpm --filter @redline/tools-art build
//
// Téléchargements mis en cache dans tools/art/.cache (ignoré par git) : relancer ne retélécharge rien.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  CACHE_DIR,
  CREDITS,
  type Focus,
  MANIFEST,
  PHOTO_DIR,
  SELECTION,
  type Selection,
  SOURCES,
  type SourceSpec,
  catalog,
  politeFetch,
  readJson,
  writeJson,
} from './lib.js';

const FULL = { width: 1280, height: 800, quality: 74 };
const THUMB = { width: 400, height: 250, quality: 70 };

type SelectionFile = Record<string, Selection | { none: string }>;
const selection = await readJson<SelectionFile>(SELECTION);
const sources = await readJson<Record<string, SourceSpec>>(SOURCES);
const systems = await catalog();
await mkdir(join(CACHE_DIR, 'dl'), { recursive: true });
await mkdir(PHOTO_DIR, { recursive: true });

async function download(sel: Selection): Promise<Buffer> {
  const key = createHash('sha1').update(sel.thumbUrl).digest('hex').slice(0, 16);
  const path = join(CACHE_DIR, 'dl', `${key}.img`);
  try {
    return await readFile(path);
  } catch {
    const res = await politeFetch(sel.thumbUrl);
    if (!res.ok) throw new Error(`${sel.systemId} : ${res.status} ${sel.thumbUrl}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path, buf);
    return buf;
  }
}

/** Rectangle 16:10 dans l'image source, centré sur le point d'intérêt (fractions 0..1) et borné. */
function cropBox(w: number, h: number, focus: Focus, zoom = 1) {
  const target = FULL.width / FULL.height;
  let cw = w;
  let ch = Math.round(w / target);
  if (ch > h) {
    ch = h;
    cw = Math.round(h * target);
  }
  cw = Math.round(cw / Math.max(zoom, 1));
  ch = Math.round(ch / Math.max(zoom, 1));
  const point: Record<string, [number, number]> = {
    centre: [0.5, 0.5],
    top: [0.5, 0],
    bottom: [0.5, 1],
    left: [0, 0.5],
    right: [1, 0.5],
  };
  const [fx, fy] = Array.isArray(focus) ? focus : (point[focus] ?? [0.5, 0.5]);
  const left = Math.min(Math.max(Math.round(fx * w - cw / 2), 0), w - cw);
  const top = Math.min(Math.max(Math.round(fy * h - ch / 2), 0), h - ch);
  return { left, top, width: cw, height: ch };
}

/**
 * Étalonnage commun, discret : léger contraste, saturation réduite, dominante froide à peine perceptible,
 * pour que des photos d'origines très diverses tiennent ensemble sur l'interface sombre.
 */
function grade(img: sharp.Sharp): sharp.Sharp {
  return img
    .modulate({ saturation: 0.84, brightness: 0.98 })
    .linear(1.07, -7)
    .recomb([
      [0.965, 0.025, 0.01],
      [0.01, 0.98, 0.01],
      [0.0, 0.03, 1.0],
    ])
    .sharpen({ sigma: 0.5 });
}

async function render(sel: Selection, src: Buffer): Promise<{ full: Buffer; thumb: Buffer }> {
  const base = sharp(src, { failOn: 'none' }).rotate();
  const meta = await base.clone().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = meta.info;
  let cropped: Buffer;
  if (sel.focus === 'fit') {
    // Image très allongée : entière, sur un fond flou et assombri tiré d'elle-même (pas de bandes noires).
    const bg = await sharp(meta.data)
      .resize(FULL.width, FULL.height, { fit: 'cover' })
      .blur(28)
      .modulate({ brightness: 0.55, saturation: 0.6 })
      .toBuffer();
    const fg = await sharp(meta.data)
      .resize(FULL.width, FULL.height, { fit: 'inside' })
      .toBuffer({ resolveWithObject: true });
    cropped = await sharp(bg)
      .composite([
        {
          input: fg.data,
          left: Math.round((FULL.width - fg.info.width) / 2),
          top: Math.round((FULL.height - fg.info.height) / 2),
        },
      ])
      .toBuffer();
  } else if (sel.focus === 'attention') {
    cropped = await sharp(meta.data)
      .resize(FULL.width, FULL.height, { fit: 'cover', position: sharp.strategy.attention })
      .toBuffer();
  } else {
    cropped = await sharp(meta.data)
      .extract(cropBox(w, h, sel.focus, sel.zoom))
      .resize(FULL.width, FULL.height, { fit: 'fill' })
      .toBuffer();
  }
  const full = await grade(sharp(cropped))
    .webp({ quality: FULL.quality, effort: 6, smartSubsample: true })
    .toBuffer();
  const thumb = await grade(sharp(cropped).resize(THUMB.width, THUMB.height))
    .webp({ quality: THUMB.quality, effort: 6, smartSubsample: true })
    .toBuffer();
  return { full, thumb };
}

interface ManifestEntry {
  file: string;
  thumb: string;
  credit: string;
  license: string;
  sourceUrl: string;
  title: string;
  generic?: boolean;
  note?: string;
}

const manifest: Record<string, ManifestEntry> = {};
const missing: { id: string; reason: string }[] = [];
let bytes = 0;
for (const sys of systems) {
  const sel = selection[sys.id];
  if (!sel || 'none' in sel) {
    missing.push({ id: sys.id, reason: sel && 'none' in sel ? sel.none : 'non résolu' });
    continue;
  }
  const { full, thumb } = await render(sel, await download(sel));
  await writeFile(join(PHOTO_DIR, `${sys.id}.webp`), full);
  await writeFile(join(PHOTO_DIR, `${sys.id}.thumb.webp`), thumb);
  bytes += full.length + thumb.length;
  const note = sources[sys.id]?.note;
  manifest[sys.id] = {
    file: `/art/photos/${sys.id}.webp`,
    thumb: `/art/photos/${sys.id}.thumb.webp`,
    credit: sel.credit,
    license: sel.license,
    sourceUrl: sel.descriptionUrl,
    title: sel.title.replace(/^File:/, ''),
    ...(sel.generic ? { generic: true } : {}),
    ...(note ? { note } : {}),
  };
  if (process.stdout.isTTY) process.stdout.write(`\r${Object.keys(manifest).length} photos`);
}

// Supprime les fichiers orphelins (système retiré ou photo abandonnée).
for (const f of await readdir(PHOTO_DIR)) {
  const id = f.replace(/(\.thumb)?\.webp$/, '');
  if (!manifest[id]) await rm(join(PHOTO_DIR, f));
}

await writeJson(MANIFEST, manifest);

const byLicense = new Map<string, number>();
for (const e of Object.values(manifest))
  byLicense.set(e.license, (byLicense.get(e.license) ?? 0) + 1);

const names = new Map(systems.map((s) => [s.id, s.name]));
const lines = [
  '# Crédits photographiques — Red Line',
  '',
  'Photographies réelles issues de Wikimedia Commons, sous licences libres permettant un usage commercial :',
  'domaine public, CC0, CC BY et CC BY-SA. Chaque image a été recadrée (16:10), redimensionnée et légèrement',
  'étalonnée ; les versions modifiées des images CC BY-SA sont diffusées sous la même licence.',
  '',
  'Textes des licences : [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/),',
  '[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),',
  '[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),',
  '[CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/),',
  '[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),',
  '[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),',
  '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),',
  '[Licence Ouverte](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) (État français, compatible CC BY ;',
  'utilisée seulement faute de photo CC ou domaine public).',
  '',
  `Généré par \`tools/art\` (${Object.keys(manifest).length} photos). Ne pas modifier à la main.`,
  '',
  'Format : **système** (`identifiant`) — auteur — licence — fichier source sur Commons.',
  '',
];
const md = (s: string) => s.replace(/([\\`*_[\]<>])/g, '\\$1');
for (const [id, e] of Object.entries(manifest)) {
  const extra = [e.generic ? 'photo représentative' : '', e.note ?? ''].filter(Boolean).join(' ; ');
  lines.push(
    `- **${md(names.get(id) ?? id)}** (\`${id}\`) — ${md(e.credit)} — ${e.license} — ` +
      `[${md(e.title)}](<${e.sourceUrl}>)${extra ? ` — _${md(extra)}_` : ''}`,
  );
}
if (missing.length) {
  lines.push('', '## Systèmes sans photo', '');
  for (const m of missing) lines.push(`- \`${m.id}\` (${names.get(m.id)}) : ${m.reason}`);
}
await writeFile(CREDITS, lines.join('\n') + '\n');

let disk = 0;
for (const f of await readdir(PHOTO_DIR)) disk += (await stat(join(PHOTO_DIR, f))).size;
console.log(
  `\n${Object.keys(manifest).length}/${systems.length} photos, ${missing.length} sans photo, ` +
    `${(disk / 1048576).toFixed(1)} Mio sur disque (${(bytes / 1048576).toFixed(1)} Mio écrits)`,
);
console.log([...byLicense].map(([l, n]) => `${l} : ${n}`).join(' · '));
