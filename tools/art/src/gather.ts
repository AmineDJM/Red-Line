// Recherche des images candidates d'un système : image principale de l'article Wikipedia,
// autres images de l'article, recherche dans l'espace « File: » de Commons.
import { BAD_NAME, type FileInfo, chunks, commonsApi, fileTitle, wikiApi } from './lib.js';

/** Image principale (pageimage) de chaque article, redirections suivies. */
export async function pageImages(titles: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const batch of chunks([...new Set(titles)], 50)) {
    const data = await wikiApi({
      action: 'query',
      titles: batch.join('|'),
      prop: 'pageimages',
      piprop: 'name',
      redirects: '1',
    });
    const alias = new Map<string, string>();
    for (const n of data.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of data.query?.redirects ?? []) alias.set(r.from, r.to);
    const byTitle = new Map<string, string | null>();
    for (const p of data.query?.pages ?? [])
      byTitle.set(p.title, p.pageimage ? fileTitle(p.pageimage) : null);
    for (const t of batch) {
      let k = t;
      for (let i = 0; i < 3 && alias.has(k); i++) k = alias.get(k)!;
      out.set(t, byTitle.get(k) ?? null);
    }
  }
  return out;
}

/** Toutes les images (JPEG) d'un article, dans l'ordre alphabétique de l'API. */
export async function articleImages(title: string): Promise<string[]> {
  const data = await wikiApi({
    action: 'query',
    titles: title,
    prop: 'images',
    imlimit: 'max',
    redirects: '1',
  });
  const out: string[] = [];
  for (const p of data.query?.pages ?? [])
    for (const im of p.images ?? [])
      if (/\.(jpe?g|tiff?|webp)$/i.test(im.title)) out.push(fileTitle(im.title));
  return out;
}

/** Fichiers d'une catégorie Commons (« Category:… »). */
export async function categoryFiles(category: string, limit = 60): Promise<string[]> {
  const data = await commonsApi({
    action: 'query',
    list: 'categorymembers',
    cmtitle: category,
    cmtype: 'file',
    cmlimit: String(limit),
  });
  return (data.query?.categorymembers ?? []).map((m: any) => fileTitle(m.title));
}

/**
 * Recherche plein texte dans les fichiers Commons (photos uniquement). Une requête « Category:… » liste
 * les fichiers de cette catégorie, plus précise que la recherche plein texte.
 */
export async function searchCommons(query: string, limit = 30): Promise<string[]> {
  if (query.startsWith('Category:')) return categoryFiles(query, limit * 2);
  const data = await commonsApi({
    action: 'query',
    list: 'search',
    srsearch: `${query} filetype:bitmap`,
    srnamespace: '6',
    srlimit: String(limit),
  });
  return (data.query?.search ?? []).map((s: any) => fileTitle(s.title));
}

/** Filtre de qualité minimal : photo matricielle, assez grande, cadrage compatible 16:10, nom sans indice de schéma. */
export function usable(info: FileInfo | null | undefined, strict = true): info is FileInfo {
  if (!info) return false;
  if (!/^image\/(jpeg|tiff|webp|png)$/.test(info.mime)) return false;
  if (info.width < 960) return false;
  const aspect = info.width / info.height;
  if (aspect < (strict ? 1.15 : 0.9) || aspect > 2.6) return false;
  if (strict && BAD_NAME.test(info.title.replace(/[_\-.,()]/g, ' '))) return false;
  if (strict && info.mime === 'image/png') return false;
  return true;
}
