// Aide à la curation : liste les photos libres candidates pour un système et en fait une planche numérotée.
//
//   pnpm --filter @redline/tools-art candidates -- us.f-16                 # article + recherche de sources.json
//   pnpm --filter @redline/tools-art candidates -- us.f-16 "F-16 Viper"    # requêtes Commons supplémentaires
//   pnpm --filter @redline/tools-art candidates -- --batch lots.json <dossier>
//       (lots.json : [{ "id": "us.f-16", "q": ["F-16 Viper"], "noWiki": false }, …])
//   … --out /tmp/planche.jpg
//
// Recopier ensuite le titre retenu dans overrides.json (« systemId »: « File:… »).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { articleImages, pageImages, searchCommons, usable } from './gather.js';
import { SOURCES, type SourceSpec, fileInfos, politeFetch, readJson } from './lib.js';
import { contactSheet } from './sheet.js';

const sources = await readJson<Record<string, SourceSpec>>(SOURCES);

async function candidates(id: string, queries: string[], out: string, noWiki = false, max = 30) {
  const src = sources[id] ?? {};
  const titles: string[] = [];
  for (const q of queries) titles.push(...(await searchCommons(q, 30)));
  if (src.wiki && !noWiki) {
    const main = (await pageImages([src.wiki])).get(src.wiki);
    if (main) titles.push(main);
    titles.push(...(await articleImages(src.wiki)));
  }
  const uniq = [...new Set(titles)];
  const infos = await fileInfos(uniq, 330, true);
  const list = uniq.map((t) => infos.get(t)).filter((i) => usable(i, false));
  const shown = list.slice(0, max);
  const tiles = [];
  const lines: string[] = [];
  for (const [n, info] of shown.entries()) {
    const res = await politeFetch(info.thumbUrl);
    const image = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    tiles.push({
      image,
      label: `${n} ${info.title.slice(5)}`,
      sub: `${info.license} ${info.width}×${info.height}`,
    });
    lines.push(
      `${n}\t${info.title}\t${info.license}\t${info.width}x${info.height}\t${info.credit}`,
    );
  }
  await contactSheet(tiles, out, { cols: 6, w: 300, h: 188 });
  await writeFile(out.replace(/\.jpg$/, '.txt'), lines.join('\n') + '\n');
  console.log(`${id} → ${out} (${shown.length}/${list.length})`);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args[0] === '--batch') {
  const jobs = await readJson<{ id: string; q: string[]; noWiki?: boolean }[]>(args[1]!);
  const dir = args[2] ?? '.';
  await mkdir(dir, { recursive: true });
  for (const j of jobs) await candidates(j.id, j.q, join(dir, `${j.id}.jpg`), j.noWiki);
} else {
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1]! : 'candidates.jpg';
  const [id, ...queries] = args;
  if (!id) throw new Error('usage : candidates <systemId> [requête…] [--out fichier.jpg]');
  await candidates(id, [...(sources[id]?.search ? [sources[id]!.search!] : []), ...queries], out);
}
