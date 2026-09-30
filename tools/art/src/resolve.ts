// Étape 1 : choisit une photo sous licence libre pour chaque système du catalogue.
//
//   pnpm --filter @redline/tools-art resolve              # tous les systèmes
//   pnpm --filter @redline/tools-art resolve -- us.f-16   # seulement ceux-ci (les autres sont conservés)
//
// Ordre de priorité : surcharge manuelle (overrides.json) → recherche Commons ciblée (sources.json « search »)
// → image principale de l'article Wikipedia → autres images de l'article. Seules les licences domaine public,
// CC0, CC BY et CC BY-SA sont retenues. Résultat : selection.json (verrou, commité), lu par build.ts.
import { articleImages, pageImages, searchCommons, usable } from './gather.js';
import {
  type FileInfo,
  type Focus,
  type Override,
  OVERRIDES,
  SELECTION,
  SOURCES,
  type Selection,
  type SourceSpec,
  catalog,
  fileInfos,
  fileTitle,
  readJson,
  writeJson,
} from './lib.js';

type SelectionFile = Record<string, Selection | { none: string }>;

const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')));
const systems = (await catalog()).filter((s) => only.size === 0 || only.has(s.id));
const sources = await readJson<Record<string, SourceSpec>>(SOURCES);
const overrides = await readJson<Record<string, Override | null>>(OVERRIDES, {});
const previous = await readJson<SelectionFile>(SELECTION, {});
const result: SelectionFile = only.size ? { ...previous } : {};

const wikiTitles = systems.map((s) => sources[s.id]?.wiki).filter((t): t is string => !!t);
const mains = await pageImages(wikiTitles);
const ovTitle = (o: Override) => fileTitle(typeof o === 'string' ? o : o.file);
const ovInfos = await fileInfos(
  systems
    .map((s) => overrides[s.id])
    .filter((o): o is Override => !!o)
    .map(ovTitle),
  undefined,
  true,
);

let found = 0;
for (const sys of systems) {
  const src = sources[sys.id] ?? {};
  const ov = overrides[sys.id];
  const generic = !!src.generic;
  if (src.none && ov == null) {
    result[sys.id] = { none: src.none };
    console.log(`∅ ${sys.id} : ${src.none}`);
    continue;
  }
  let pick: { info: FileInfo; via: Selection['via']; focus: Focus; zoom?: number } | null = null;

  if (ov) {
    const file = ovTitle(ov);
    const info = ovInfos.get(file);
    if (!info) {
      console.warn(`✗ ${sys.id} : surcharge ${file} introuvable ou licence refusée`);
    } else {
      pick = {
        info: typeof ov === 'object' && ov.credit ? { ...info, credit: ov.credit } : info,
        via: 'override',
        focus: (typeof ov === 'object' && ov.focus) || 'centre',
        ...(typeof ov === 'object' && ov.zoom ? { zoom: ov.zoom } : {}),
      };
    }
  }

  if (!pick && src.search) {
    const titles = await searchCommons(src.search, 15);
    const infos = await fileInfos(titles);
    const words = src.search.toLowerCase().split(/\s+/);
    const hit = titles
      .map((t) => infos.get(t))
      .find(
        (i) =>
          usable(i) &&
          words.every((w) =>
            i.title.toLowerCase().replace(/[\s_]/g, '').includes(w.replace(/\s/g, '')),
          ),
      );
    if (hit) pick = { info: hit, via: 'search', focus: 'centre' };
  }

  if (!pick && src.wiki) {
    const main = mains.get(src.wiki);
    if (main) {
      const info = (await fileInfos([main])).get(main);
      if (usable(info)) pick = { info, via: 'pageimage', focus: 'centre' };
    }
    if (!pick) {
      const titles = await articleImages(src.wiki);
      const infos = await fileInfos(titles);
      const ranked = titles
        .map((t) => infos.get(t))
        .filter((i) => usable(i))
        .sort((a, b) => Math.min(b.width, 2400) - Math.min(a.width, 2400));
      if (ranked[0]) pick = { info: ranked[0], via: 'page', focus: 'centre' };
    }
  }

  if (pick) {
    result[sys.id] = {
      systemId: sys.id,
      generic,
      ...pick.info,
      focus: pick.focus,
      ...(pick.zoom ? { zoom: pick.zoom } : {}),
      via: pick.via,
    };
    found++;
    console.log(`✓ ${sys.id} [${pick.via}] ${pick.info.title} — ${pick.info.license}`);
  } else {
    result[sys.id] = { none: src.none ?? 'aucune photo sous licence libre trouvée' };
    console.log(`✗ ${sys.id} : aucune photo retenue`);
  }
}

// Ordre stable (ordre du catalogue) pour des diffs lisibles.
const order = (await catalog()).map((s) => s.id);
const sorted: SelectionFile = {};
for (const id of order) if (result[id]) sorted[id] = result[id]!;
await writeJson(SELECTION, sorted);
console.log(`\n${found}/${systems.length} systèmes résolus → ${SELECTION}`);
