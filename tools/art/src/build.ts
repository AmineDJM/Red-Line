// Étape 3 : compose les fiches photo (sujet détouré sur fond « terminal tactique », ou photo recadrée en
// 16:10), les étalonne et produit les WebP du client, le manifeste data/art/photos.json et data/art/CREDITS.md.
//
//   pnpm --filter @redline/tools-art build
//   pnpm --filter @redline/tools-art build -- eu.f-16   # ne recompose que ces systèmes (manifeste complet)
//
// Téléchargements et découpes en cache dans tools/art/.cache (ignoré par git) : relancer ne retélécharge rien.
// Les décisions de détourage viennent de cutouts.json (étape `cutout`).
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { FRAME_TIGHTEN, composeCutout, composeFramed, keepBox, prepareSubject } from './compose.js';
import {
  CACHE_DIR,
  CREDITS,
  CUTOUTS,
  CUTOUT_DIR,
  type CutoutDecision,
  type Focus,
  MANIFEST,
  PHOTO_DIR,
  SELECTION,
  type Selection,
  SOURCES,
  type SourceSpec,
  catalog,
  downloadSource,
  readJson,
  sourceKey,
  writeJson,
} from './lib.js';

const FULL = { width: 1280, height: 800, quality: 76 };
const THUMB = { width: 400, height: 250, quality: 74 };

type SelectionFile = Record<string, Selection | { none: string }>;
const selection = await readJson<SelectionFile>(SELECTION);
const sources = await readJson<Record<string, SourceSpec>>(SOURCES);
const cutouts = await readJson<Record<string, CutoutDecision>>(CUTOUTS, {});
const systems = await catalog();
const only = new Set(process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('-')));
await mkdir(join(CACHE_DIR, 'dl'), { recursive: true });
await mkdir(PHOTO_DIR, { recursive: true });

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

/** Photo non détourée, recadrée en 16:10 selon `focus` / `zoom` et resserrée de FRAME_TIGHTEN. */
async function cropFramed(sel: Selection, src: Buffer): Promise<Buffer> {
  const meta = await sharp(src, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = meta.info;
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
    return sharp(bg)
      .composite([
        {
          input: fg.data,
          left: Math.round((FULL.width - fg.info.width) / 2),
          top: Math.round((FULL.height - fg.info.height) / 2),
        },
      ])
      .toBuffer();
  }
  if (sel.focus === 'attention') {
    return sharp(meta.data)
      .resize(FULL.width, FULL.height, { fit: 'cover', position: sharp.strategy.attention })
      .toBuffer();
  }
  return sharp(meta.data)
    .extract(cropBox(w, h, sel.focus, (sel.zoom ?? 1) * FRAME_TIGHTEN))
    .resize(FULL.width, FULL.height, { fit: 'fill', kernel: 'lanczos3' })
    .toBuffer();
}

const webp = (img: sharp.Sharp, quality: number) =>
  img.webp({ quality, effort: 6, smartSubsample: true }).toBuffer();

async function render(
  sel: Selection,
  cut: CutoutDecision | undefined,
): Promise<{ full: Buffer; thumb: Buffer; cutout: boolean }> {
  if (cut?.use && cut.title === sel.title) {
    let png: Buffer;
    try {
      png = await readFile(join(CUTOUT_DIR, `${sourceKey(sel)}.png`));
    } catch {
      throw new Error(
        `${sel.systemId} : découpe absente du cache, lancer d'abord « pnpm --filter @redline/tools-art cutout »`,
      );
    }
    const subject = await prepareSubject(await keepBox(png, cut.box));
    const full = await webp(await composeCutout(subject, FULL.width, FULL.height), FULL.quality);
    const thumb = await webp(
      await composeCutout(subject, THUMB.width, THUMB.height),
      THUMB.quality,
    );
    return { full, thumb, cutout: true };
  }
  const cropped = await cropFramed(sel, await downloadSource(sel));
  const full = await webp(await composeFramed(cropped, FULL.width, FULL.height), FULL.quality);
  const thumb = await webp(await composeFramed(cropped, THUMB.width, THUMB.height), THUMB.quality);
  return { full, thumb, cutout: false };
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
  /** Sujet détouré et posé sur le fond commun (sinon photo recadrée). */
  cutout?: boolean;
}

const manifest: Record<string, ManifestEntry> = {};
const previous = await readJson<Record<string, ManifestEntry>>(MANIFEST, {});
const failed: string[] = [];
const missing: { id: string; reason: string }[] = [];
let bytes = 0;
let detoured = 0;
for (const sys of systems) {
  const sel = selection[sys.id];
  if (!sel || 'none' in sel) {
    missing.push({ id: sys.id, reason: sel && 'none' in sel ? sel.none : 'non résolu' });
    continue;
  }
  const cut = cutouts[sys.id];
  let cutout = !!cut?.use && cut.title === sel.title;
  if (only.size === 0 || only.has(sys.id)) {
    let r: Awaited<ReturnType<typeof render>>;
    try {
      r = await render(sel, cut);
    } catch (e) {
      // Téléchargement impossible (limite de débit) : on garde la fiche précédente si elle porte sur la
      // même photo, sinon le système est signalé ; relancer ensuite « build -- <id> ».
      const prev = previous[sys.id];
      console.warn(`\n✗ ${sys.id} : ${(e as Error).message}`);
      failed.push(sys.id);
      if (prev && prev.title === sel.title.replace(/^File:/, '')) manifest[sys.id] = prev;
      continue;
    }
    cutout = r.cutout;
    await writeFile(join(PHOTO_DIR, `${sys.id}.webp`), r.full);
    await writeFile(join(PHOTO_DIR, `${sys.id}.thumb.webp`), r.thumb);
    bytes += r.full.length + r.thumb.length;
  }
  if (cutout) detoured++;
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
    ...(cutout ? { cutout: true } : {}),
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
  'étalonnée ; quand le sujet a été détouré, son arrière-plan a été remplacé par un fond uniforme (le sujet',
  'reste la photo d’origine, aucun pixel n’est généré). Les versions modifiées des images CC BY-SA sont',
  'diffusées sous la même licence.',
  '',
  'Textes des licences : [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/),',
  '[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),',
  '[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),',
  '[CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/),',
  '[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),',
  '[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),',
  '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),',
  '[Licence Ouverte](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) (État français) et',
  '[OGL v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) (Royaume-Uni), toutes deux',
  'compatibles CC BY et utilisées seulement faute de photo CC ou domaine public.',
  '',
  '## Licences étendues (validées par Amine le 2026-10-01)',
  '',
  'Les photos sous Licence Ouverte (Etalab 2.0) et sous Open Government Licence v3.0 ont été validées par Amine',
  'le 2026-10-01. Mentions exigées :',
  '',
  '- **Licence Ouverte 2.0** : mention de la paternité (« Ministère des Armées » ou l’auteur indiqué) et de la',
  '  date de dernière mise à jour, avec lien vers la source ; modifications signalées (recadrage, étalonnage,',
  '  détourage). La licence n’accorde aucun droit sur les marques et insignes.',
  '- **OGL v3** : « Contains public sector information licensed under the Open Government Licence v3.0. »,',
  '  avec l’attribution fournie par la source (« UK MOD © Crown copyright »). L’OGL n’autorise pas l’usage',
  '  des insignes militaires (cadrage excluant tout insigne mis en avant) ni n’implique l’approbation du',
  '  fournisseur des données.',
  '',
  `Généré par \`tools/art\` (${Object.keys(manifest).length} photos, dont ${detoured} détourées). Ne pas modifier à la main.`,
  '',
  'Format : **système** (`identifiant`) — auteur — licence — fichier source sur Commons.',
  '',
];
const md = (s: string) => s.replace(/([\\`*_[\]<>])/g, '\\$1');
const ogl = 'Contains public sector information licensed under the Open Government Licence v3.0.';
for (const [id, e] of Object.entries(manifest)) {
  const extra = [
    e.generic ? 'photo représentative' : '',
    e.note ?? '',
    e.license === 'OGL v3' ? ogl : '',
    e.license === 'Licence Ouverte' || e.license === 'OGL v3'
      ? 'licence validée par Amine le 2026-10-01'
      : '',
  ]
    .filter(Boolean)
    .join(' ; ');
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
  `\n${Object.keys(manifest).length}/${systems.length} photos (${detoured} détourées), ${missing.length} sans photo, ` +
    `${(disk / 1048576).toFixed(1)} Mio sur disque (${(bytes / 1048576).toFixed(1)} Mio écrits)`,
);
console.log([...byLicense].map(([l, n]) => `${l} : ${n}`).join(' · '));
if (failed.length) {
  console.error(
    `\n${failed.length} photo(s) non composée(s), relancer : build -- ${failed.join(' ')}`,
  );
  process.exitCode = 1;
}
