/** Recherche tolérante : sans accents ni casse, tous les mots de la requête doivent apparaître. */

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokens(q: string): string[] {
  return fold(q).split(/\s+/).filter(Boolean);
}

/** Vrai si chaque mot de la requête est contenu dans le texte. */
export function matches(haystack: string, q: string | string[]): boolean {
  const t = Array.isArray(q) ? q : tokens(q);
  if (t.length === 0) return true;
  const h = fold(haystack);
  return t.every((w) => h.includes(w));
}

/** Score de pertinence (0 = absent) : début de mot favorisé. */
export function score(haystack: string, q: string | string[]): number {
  const t = Array.isArray(q) ? q : tokens(q);
  if (t.length === 0) return 1;
  const h = fold(haystack);
  let s = 0;
  for (const w of t) {
    const i = h.indexOf(w);
    if (i < 0) return 0;
    s += 10 - Math.min(9, i / 4);
    if (i === 0 || /[\s.:/_(-]/.test(h[i - 1]!)) s += 6;
  }
  return s;
}

/** Filtre et trie une liste selon une requête (ordre d'origine si la requête est vide). */
export function rank<T>(
  items: readonly T[],
  q: string,
  text: (x: T) => string,
  limit = Infinity,
): T[] {
  const t = tokens(q);
  if (t.length === 0) return items.slice(0, limit);
  const scored: [T, number, number][] = [];
  items.forEach((x, i) => {
    const s = score(text(x), t);
    if (s > 0) scored.push([x, s, i]);
  });
  scored.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  return scored.slice(0, limit).map(([x]) => x);
}
