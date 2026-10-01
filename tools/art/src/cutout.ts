// Étape 2 bis : détourage du sujet de chaque photo (suppression de l'arrière-plan), pour une présentation
// homogène façon « fiche » : matériel isolé sur un fond uniforme (voir build.ts).
//
//   pnpm --filter @redline/tools-art cutout              # tous les systèmes
//   pnpm --filter @redline/tools-art cutout -- us.f-16   # seulement ceux-ci (les autres décisions sont conservées)
//   pnpm --filter @redline/tools-art cutout -- --sheet /tmp/dir   # + planches de contrôle (découpe sur fond)
//
// La photo reste une VRAIE photo : seul l'arrière-plan est retiré (masque), aucun pixel n'est généré.
// Service : API Recraft `removeBackground` (l'authentification est ajoutée par le proxy de l'environnement ;
// lancer avec NODE_USE_ENV_PROXY=1, déjà fait par le script pnpm). Seule l'image (publique, issue de Commons)
// est envoyée. Résultats en cache dans .cache/cutout (un PNG par photo source) : relancer ne rappelle pas l'API.
//
// Décision par système → cutouts.json (verrou commité, lu par build) :
//   - sources.json `cutout: false` : photo d'origine conservée (refus au contrôle visuel), pas d'appel ;
//   - catégories où le détourage n'a pas de sens (lancements spatiaux) : photo conservée, pas d'appel ;
//   - sinon détourage, retenu si les contrôles automatiques passent (sujet présent, non coupé par le cadre,
//     arrière-plan effectivement retiré), ou imposé par `cutout: true`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  CUTOUTS,
  CUTOUT_DIR,
  type CutoutDecision,
  SELECTION,
  SOURCES,
  type Selection,
  type SourceSpec,
  catalog,
  downloadSource,
  readJson,
  sourceKey,
  writeJson,
} from './lib.js';
import { composeCutout, keepBox, prepareSubject } from './compose.js';
import { contactSheet } from './sheet.js';

const ENDPOINT = 'https://external.api.recraft.ai/v1/images/removeBackground';
/** Intervalle minimal entre deux appels au service (politesse, ≈ 1 appel toutes les 1,5 s). */
const MIN_INTERVAL_MS = 1500;
/** Catégories jamais détourées (photos de lancement : le sujet est la fusée et son panache). */
const SKIP_CATEGORIES = new Set(['space']);

const args = process.argv.slice(2).filter((a) => a !== '--');
const sheetIdx = args.indexOf('--sheet');
const sheetDir = sheetIdx >= 0 ? args.splice(sheetIdx, 2)[1] : undefined;
const only = new Set(args.filter((a) => !a.startsWith('-')));

type SelectionFile = Record<string, Selection | { none: string }>;
const selection = await readJson<SelectionFile>(SELECTION);
const sources = await readJson<Record<string, SourceSpec>>(SOURCES);
const previous = await readJson<Record<string, CutoutDecision>>(CUTOUTS, {});
const systems = await catalog();
await mkdir(CUTOUT_DIR, { recursive: true });

let last = 0;
async function pace(): Promise<void> {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

/** Appel au service avec reprise (429, 5xx, erreurs réseau), délai croissant ou `Retry-After`. */
async function removeBackground(jpeg: Buffer, label: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    await pace();
    try {
      const form = new FormData();
      form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `${label}.jpg`);
      const res = await fetch(ENDPOINT, { method: 'POST', body: form });
      if (res.status === 429 || res.status >= 500) {
        const retry = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
        await res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { retry });
      }
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status} ${await res.text()}`), { fatal: true });
      const body = (await res.json()) as { image?: { url?: string } };
      const url = body.image?.url;
      if (!url) throw Object.assign(new Error('réponse sans image'), { fatal: true });
      const img = await fetch(url);
      if (!img.ok) throw new Error(`téléchargement ${img.status}`);
      return Buffer.from(await img.arrayBuffer());
    } catch (e) {
      const err = e as Error & { retry?: number; fatal?: boolean };
      if (err.fatal || attempt >= 4) throw err;
      const wait = (err.retry ?? 5 * (attempt + 1)) * 1000;
      console.warn(`  ↻ ${label} : ${err.message}, nouvel essai dans ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Image envoyée au service : la photo source, orientée, en JPEG (sans métadonnées). */
async function inputFor(sel: Selection): Promise<Buffer> {
  return sharp(await downloadSource(sel), { failOn: 'none' })
    .rotate()
    .flatten({ background: '#808080' })
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Découpe en cache (PNG RGBA à la taille de l'image envoyée), calculée si absente. */
async function cutoutFor(sel: Selection): Promise<Buffer> {
  const path = join(CUTOUT_DIR, `${sourceKey(sel)}.png`);
  try {
    return await readFile(path);
  } catch {
    const raw = await removeBackground(await inputFor(sel), sel.systemId);
    const png = await sharp(raw).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
    await writeFile(path, png);
    return png;
  }
}

export interface AlphaStats {
  coverage: number;
  /** Part de chaque bord occupée par le sujet (haut, droite, bas, gauche). */
  edges: [number, number, number, number];
  bbox: { left: number; top: number; width: number; height: number } | null;
}

/** Statistiques du masque : part couverte, contact avec les bords, boîte englobante. */
export async function alphaStats(png: Buffer): Promise<AlphaStats> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let n = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  const edge = [0, 0, 0, 0];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.004));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x]! < 128) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (y < band) edge[0]!++;
      if (x >= w - band) edge[1]!++;
      if (y >= h - band) edge[2]!++;
      if (x < band) edge[3]!++;
    }
  }
  return {
    coverage: n / (w * h),
    edges: [
      edge[0]! / (w * band),
      edge[1]! / (h * band),
      edge[2]! / (w * band),
      edge[3]! / (h * band),
    ],
    bbox: x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
  };
}

/** Contrôles automatiques : null si la découpe est exploitable, sinon la raison du refus. */
function autoCheck(s: AlphaStats): string | null {
  if (!s.bbox || s.coverage < 0.015) return 'sujet non détecté';
  if (s.coverage > 0.8) return 'arrière-plan non retiré';
  const names = ['haut', 'droite', 'bas', 'gauche'];
  // Le bas est toléré davantage (véhicule posé au sol, coque coupée à la ligne de flottaison).
  const limits = [0.06, 0.06, 0.25, 0.06];
  const cut = s.edges.map((v, i) => (v > limits[i]! ? names[i] : null)).filter(Boolean);
  if (cut.length) return `sujet coupé par le cadre (${cut.join(', ')})`;
  return null;
}

const result: Record<string, CutoutDecision> = only.size ? { ...previous } : {};
const tiles: { image: Buffer | null; label: string; sub?: string }[] = [];
let calls = 0;
let used = 0;
for (const sys of systems) {
  if (only.size && !only.has(sys.id)) continue;
  const sel = selection[sys.id];
  if (!sel || 'none' in sel) continue;
  const src = sources[sys.id] ?? {};
  const title = sel.title;
  let decision: CutoutDecision;
  if (src.cutout === false) {
    decision = { title, use: false, reason: src.cutoutWhy ?? 'refusé au contrôle visuel' };
  } else if (SKIP_CATEGORIES.has(sys.category) && src.cutout !== true) {
    decision = { title, use: false, reason: 'catégorie non détourée (lancement, vue orbitale)' };
  } else {
    let png: Buffer;
    try {
      const cached = join(CUTOUT_DIR, `${sourceKey(sel)}.png`);
      const had = await readFile(cached).then(
        () => true,
        () => false,
      );
      png = await keepBox(await cutoutFor(sel), src.cutoutBox, src.cutoutErase);
      if (!had) calls++;
    } catch (e) {
      console.warn(`✗ ${sys.id} : détourage impossible (${(e as Error).message})`);
      decision = { title, use: false, reason: `détourage impossible : ${(e as Error).message}` };
      result[sys.id] = decision;
      continue;
    }
    const stats = await alphaStats(png);
    const refused = autoCheck(stats);
    const coverage = Math.round(stats.coverage * 1000) / 1000;
    const extra = {
      coverage,
      ...(src.cutoutBox ? { box: src.cutoutBox } : {}),
      ...(src.cutoutErase ? { erase: src.cutoutErase } : {}),
    };
    if (src.cutout === true)
      decision = {
        title,
        use: true,
        reason: src.cutoutWhy ?? 'détourage validé au contrôle visuel',
        ...extra,
      };
    else if (refused) decision = { title, use: false, reason: refused, ...extra };
    else
      decision = {
        title,
        use: true,
        reason: src.cutoutWhy ?? 'contrôles automatiques passés',
        ...extra,
      };
    if (sheetDir && stats.bbox) {
      // Planche de contrôle : la fiche telle qu'elle sera composée (restes de décor visibles sur le fond).
      const preview = await (
        await composeCutout(await prepareSubject(png), 600, 375)
      )
        .jpeg()
        .toBuffer();
      tiles.push({
        image: preview,
        label: `${decision.use ? '✓' : '✗'} ${sys.id}`,
        sub: `${coverage} ${decision.reason}`,
      });
    }
  }
  if (decision.use) used++;
  result[sys.id] = decision;
  console.log(`${decision.use ? '✓' : '·'} ${sys.id} : ${decision.reason}`);
}

const order = systems.map((s) => s.id);
const sorted: Record<string, CutoutDecision> = {};
for (const id of order) if (result[id]) sorted[id] = result[id]!;
await writeJson(CUTOUTS, sorted);
if (sheetDir && tiles.length) {
  await mkdir(sheetDir, { recursive: true });
  for (let i = 0; i < tiles.length; i += 30) {
    const out = join(sheetDir, `detourage-${String(i / 30 + 1).padStart(2, '0')}.jpg`);
    await contactSheet(tiles.slice(i, i + 30), out, { cols: 6, w: 300, h: 188, fit: 'contain' });
    console.log(out);
  }
}
console.log(`\n${used} détourages retenus, ${calls} appels au service → ${CUTOUTS}`);
