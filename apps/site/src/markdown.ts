/**
 * Markdown minimal et sûr pour les pages prérendues : titres, paragraphes, gras, italique, code, liens,
 * listes (à puces et numérotées), citations, tableaux et filets. Tout le texte est échappé : aucun HTML
 * du contenu n'est recopié. Les commentaires <!-- … --> sont retirés (notes internes non publiées).
 * Les jetons {{…}} (origine, mentions légales) traversent intacts : le serveur les remplace à l'envoi.
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Identifiant d'ancre stable (minuscules ASCII, tirets). */
export function slugify(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/[^a-z0-9Ѐ-ӿ؀-ۿ一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/** Résout une cible de lien (« page:… » vers une URL du site) ; null = texte simple. */
export type LinkResolver = (href: string) => string | null;

const defaultResolver: LinkResolver = (href) =>
  /^(https?:|mailto:|\/|#)/.test(href) ? href : null;

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(«])_([^_]+)_(?=[\s.,;:!?)»]|$)/g, '$1<em>$2</em>');
}

/** Texte en ligne → HTML (échappé). */
export function inline(s: string, resolve: LinkResolver = defaultResolver): string {
  const out: string[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push(emphasis(esc(s.slice(last, m.index))));
    const href = resolve(m[2]!);
    const text = emphasis(esc(m[1]!));
    if (href) {
      const ext = /^https?:/.test(href);
      out.push(`<a href="${esc(href)}"${ext ? ' rel="noopener" target="_blank"' : ''}>${text}</a>`);
    } else out.push(text);
    last = m.index + m[0].length;
  }
  out.push(emphasis(esc(s.slice(last))));
  return out.join('');
}

export interface Rendered {
  html: string;
  /** Titres de niveau 2 (sommaire). */
  toc: { id: string; text: string }[];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

export function markdown(src: string, resolve: LinkResolver = defaultResolver): Rendered {
  const text = src.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  const out: string[] = [];
  const toc: Rendered['toc'] = [];
  const ids = new Set<string>();
  let i = 0;
  const uniqueId = (t: string) => {
    let id = slugify(t);
    for (let n = 2; ids.has(id); n++) id = `${slugify(t)}-${n}`;
    ids.add(id);
    return id;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const level = Math.min(h[1]!.length + (h[1]!.length === 1 ? 1 : 0), 4);
      const id = uniqueId(h[2]!);
      if (level === 2) toc.push({ id, text: h[2]! });
      out.push(`<h${level} id="${id}">${inline(h[2]!, resolve)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (t.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const r = lines[i]!.trim();
        if (!/^\|?\s*:?-{2,}/.test(r)) rows.push(cells(r));
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        '<div class="table"><table>' +
          (head
            ? `<thead><tr>${head.map((c) => `<th scope="col">${inline(c, resolve)}</th>`).join('')}</tr></thead>`
            : '') +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, resolve)}</td>`).join('')}</tr>`).join('')}</tbody>` +
          '</table></div>',
      );
      continue;
    }
    if (t.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        q.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${markdown(q.join('\n'), resolve).html}</blockquote>`);
      continue;
    }
    const ul = /^[-*]\s+/;
    const ol = /^\d+[.)]\s+/;
    if (ul.test(t) || ol.test(t)) {
      const ordered = ol.test(t);
      const marker = ordered ? ol : ul;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const lt = l.trim();
        if (marker.test(lt)) items.push(lt.replace(marker, ''));
        else if (lt && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${lt}`;
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it, resolve)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const lt = lines[i]!.trim();
      if (!lt || /^(#{1,4}\s|[-*]\s|\d+[.)]\s|>|\|)/.test(lt)) break;
      para.push(lt);
      i++;
    }
    out.push(`<p>${inline(para.join(' '), resolve)}</p>`);
  }
  return { html: out.join('\n'), toc };
}
