/**
 * Ressources des pages publiques, copiées sous dist/site/ avec une empreinte dans le nom (cache d'un an) :
 * polices JetBrains Mono (sous-ensembles), carte « matrice de points », image de partage, capture du jeu.
 * La feuille de style (jetons + site.css, ~12 Kio) est minifiée puis insérée dans chaque page : aucune
 * requête bloquante avant le premier rendu.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { REPO, SITE_ROOT } from './paths.js';

export interface ImageAsset {
  src: string;
  width: number;
  height: number;
}

export interface Assets {
  css: string;
  /** Polices à précharger (sous-ensemble latin). */
  preload: string[];
  world: string;
  og: Record<string, ImageAsset>;
  shot: { srcset: string; src: string; width: number; height: number } | null;
}

/** Minification sûre : commentaires et blancs retirés hors chaînes. */
export function minifyCss(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      while (i < css.length && /\s/.test(css[i]!)) i++;
      const prev = out[out.length - 1] ?? '';
      const next = css[i] ?? '';
      if (!/[{};,>:(]/.test(prev) && !/[{};,>)!]/.test(next) && prev !== '') out += ' ';
      continue;
    }
    if (c === ';' && css[i + 1] === '}') {
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/;}/g, '}');
}

function hashOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

/** Copie `src` dans dist/site/<dossier>/<nom>.<empreinte><ext> ; renvoie l'URL publique. */
export function emit(src: string, outDir: string, sub = '', name?: string): string {
  const buf = readFileSync(src);
  const ext = extname(src);
  const base = name ?? basename(src, ext);
  const file = `${base}.${hashOf(buf)}${ext}`;
  const dir = join(outDir, 'site', sub);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, file));
  return `/site/${sub ? `${sub}/` : ''}${file}`;
}

const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'vietnamese'];
const WEIGHTS = [400, 700];

function fontFaces(outDir: string): { css: string; preload: string[] } {
  const require = createRequire(join(SITE_ROOT, 'package.json'));
  const pkgDir = dirname(require.resolve('@fontsource/jetbrains-mono/package.json'));
  const faces: string[] = [];
  const preload: string[] = [];
  for (const w of WEIGHTS) {
    for (const s of SUBSETS) {
      const cssFile = join(pkgDir, `${s}-${w}.css`);
      if (!existsSync(cssFile)) continue;
      const range = /unicode-range:\s*([^;]+);/.exec(readFileSync(cssFile, 'utf8'))?.[1];
      const woff2 = join(pkgDir, 'files', `jetbrains-mono-${s}-${w}-normal.woff2`);
      if (!existsSync(woff2)) continue;
      const url = emit(woff2, outDir, 'fonts', `jbm-${s}-${w}`);
      if (s === 'latin') preload.push(url);
      faces.push(
        `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:${w};font-display:swap;` +
          `src:url(${url}) format('woff2')${range ? `;unicode-range:${range.trim()}` : ''}}`,
      );
    }
  }
  return { css: faces.join(''), preload };
}

/** Dimensions d'une image PNG, JPEG ou WebP (lecture de l'en-tête). */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

function image(src: string, outDir: string, sub: string): ImageAsset {
  const size = imageSize(readFileSync(src));
  if (!size) throw new Error(`Dimensions illisibles : ${src}`);
  return { src: emit(src, outDir, sub), ...size };
}

export function buildAssets(outDir: string, codes: string[]): Assets {
  const fonts = fontFaces(outDir);
  const tokens = readFileSync(join(REPO, 'packages/ui/src/tokens.css'), 'utf8');
  const site = readFileSync(join(SITE_ROOT, 'src/site.css'), 'utf8');
  const css = minifyCss(fonts.css + tokens + site);

  // Carte matricielle (world-raster.mjs) : décodée hors du fil principal, contrairement au SVG.
  const worldSrc = join(REPO, 'apps/client/public/world.webp');
  const world = emit(worldSrc, outDir, '', 'world');

  // Image de partage par langue (static/og/og-<langue>.jpg), repli sur l'anglais puis le français.
  const og: Record<string, ImageAsset> = {};
  const ogDir = join(SITE_ROOT, 'static/og');
  for (const code of codes) {
    const p = join(ogDir, `og-${code}.jpg`);
    if (existsSync(p)) og[code] = image(p, outDir, 'og');
  }
  const fallback = og.en ?? og.fr ?? Object.values(og)[0];
  if (fallback) for (const code of codes) og[code] ??= fallback;

  // Capture réelle du jeu en deux largeurs (static/shots/game-<largeur>.webp).
  let shot: Assets['shot'] = null;
  const shots = [800, 1600]
    .map((w) => ({ w, p: join(SITE_ROOT, `static/shots/game-${w}.webp`) }))
    .filter((s) => existsSync(s.p))
    .map((s) => ({ w: s.w, img: image(s.p, outDir, 'shots') }));
  if (shots.length) {
    const big = shots[shots.length - 1]!.img;
    shot = {
      src: shots[0]!.img.src,
      srcset: shots.map((s) => `${s.img.src} ${s.img.width}w`).join(', '),
      width: big.width,
      height: big.height,
    };
  }
  return { css, preload: fonts.preload, world, og, shot };
}
