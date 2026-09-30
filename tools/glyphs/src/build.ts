/**
 * Glyphes SDF MapLibre pour Red Line : data/glyphs/{fontstack}/{start}-{end}.pbf
 *
 * Polices : paquets npm @fontsource (licence SIL OFL 1.1). Rastérisation dans le Chromium de
 * Playwright avec @mapbox/tiny-sdf (24 px, marge 3, rayon 8, seuil 0,25 : les réglages de
 * MapLibre), puis encodage protobuf au format « glyphs.proto » de Mapbox.
 *
 *   pnpm --filter @redline/tools-glyphs build
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import * as fontkit from 'fontkit';
import { PbfWriter } from 'pbf';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', '..', 'data', 'glyphs');

/** Plages exportées : latin, latin étendu, ponctuation générale (« », –, …). */
export const RANGES: [number, number][] = [
  [0, 255],
  [256, 511],
  [512, 767],
  [8192, 8447],
];

interface FontStackDef {
  name: string;
  pkg: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
}

export const STACKS: FontStackDef[] = [
  {
    name: 'Barlow Condensed Bold',
    pkg: '@fontsource/barlow-condensed',
    family: 'barlow-condensed',
    weight: 700,
    style: 'normal',
  },
  {
    name: 'IBM Plex Sans Regular',
    pkg: '@fontsource/ibm-plex-sans',
    family: 'ibm-plex-sans',
    weight: 400,
    style: 'normal',
  },
  {
    name: 'IBM Plex Sans SemiBold',
    pkg: '@fontsource/ibm-plex-sans',
    family: 'ibm-plex-sans',
    weight: 600,
    style: 'normal',
  },
  {
    name: 'IBM Plex Sans Italic',
    pkg: '@fontsource/ibm-plex-sans',
    family: 'ibm-plex-sans',
    weight: 400,
    style: 'italic',
  },
];

/** Décalage vertical de MapLibre entre TinySDF et les glyphes serveur (voir glyph_manager). */
const TOP_ADJUST = 27;
const SDF = { fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25 };

interface SubsetFile {
  file: string;
  codepoints: number[];
}

function subsetFiles(def: FontStackDef): SubsetFile[] {
  const dir = join(dirname(require.resolve(`${def.pkg}/package.json`)), 'files');
  const subsets = [
    'latin',
    'latin-ext',
    'vietnamese',
    'greek',
    'greek-ext',
    'cyrillic',
    'cyrillic-ext',
  ];
  const out: SubsetFile[] = [];
  for (const s of subsets) {
    const file = join(dir, `${def.family}-${s}-${def.weight}-${def.style}.woff2`);
    let font: fontkit.Font;
    try {
      font = fontkit.openSync(file) as fontkit.Font;
    } catch {
      continue;
    }
    const cps = (font.characterSet as number[]).filter((c) =>
      RANGES.some(([a, b]) => c >= a && c <= b),
    );
    if (cps.length) out.push({ file, codepoints: cps });
  }
  return out;
}

function unicodeRange(cps: number[]): string {
  const s = [...cps].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    const hex = (v: number) => v.toString(16).toUpperCase();
    parts.push(i === j ? `U+${hex(s[i]!)}` : `U+${hex(s[i]!)}-${hex(s[j]!)}`);
    i = j + 1;
  }
  return parts.join(', ');
}

interface Glyph {
  id: number;
  bitmap: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export function encodeRange(name: string, range: string, glyphs: Glyph[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (_: unknown, p: PbfWriter) => {
      p.writeStringField(1, name);
      p.writeStringField(2, range);
      for (const g of glyphs)
        p.writeMessage(
          3,
          (gl: Glyph, q: PbfWriter) => {
            q.writeVarintField(1, gl.id);
            if (gl.bitmap.length) q.writeBytesField(2, gl.bitmap);
            q.writeVarintField(3, gl.width);
            q.writeVarintField(4, gl.height);
            q.writeSVarintField(5, gl.left);
            q.writeSVarintField(6, gl.top);
            q.writeVarintField(7, gl.advance);
          },
          g,
        );
    },
    null,
  );
  return pbf.finish();
}

async function main() {
  const tinySrc = readFileSync(require.resolve('@mapbox/tiny-sdf'), 'utf8').replace(
    'export default class TinySDF',
    'window.TinySDF = class TinySDF',
  );
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  await page.addScriptTag({ content: tinySrc });
  let total = 0;
  for (const [si, def] of STACKS.entries()) {
    const family = `rlglyph${si}`;
    const files = subsetFiles(def);
    const css = files
      .map(
        (
          f,
        ) => `@font-face { font-family: '${family}'; font-style: ${def.style}; font-weight: ${def.weight};
  src: url(data:font/woff2;base64,${readFileSync(f.file).toString('base64')}) format('woff2');
  unicode-range: ${unicodeRange(f.codepoints)}; }`,
      )
      .join('\n');
    await page.addStyleTag({ content: css });
    const cps = [...new Set(files.flatMap((f) => f.codepoints))].sort((a, b) => a - b);
    const rendered = (await page.evaluate(
      async ({ family, def, cps, sdf }) => {
        const text = String.fromCodePoint(...cps);
        await document.fonts.load(`${def.style} ${def.weight} ${sdf.fontSize}px '${family}'`, text);
        const w = window as unknown as {
          TinySDF: new (o: object) => { draw(c: string): Record<string, unknown> };
        };
        const t = new w.TinySDF({
          ...sdf,
          fontFamily: `'${family}'`,
          fontWeight: String(def.weight),
          fontStyle: def.style,
        });
        return cps.map((cp) => {
          const g = t.draw(String.fromCodePoint(cp));
          return {
            id: cp,
            data: Array.from(g.data as Uint8ClampedArray),
            glyphWidth: g.glyphWidth as number,
            glyphHeight: g.glyphHeight as number,
            glyphLeft: g.glyphLeft as number,
            glyphTop: g.glyphTop as number,
            glyphAdvance: g.glyphAdvance as number,
          };
        });
      },
      { family, def, cps, sdf: SDF },
    )) as {
      id: number;
      data: number[];
      glyphWidth: number;
      glyphHeight: number;
      glyphLeft: number;
      glyphTop: number;
      glyphAdvance: number;
    }[];
    const dir = join(OUT, def.name);
    mkdirSync(dir, { recursive: true });
    for (const [a, b] of RANGES) {
      const glyphs: Glyph[] = rendered
        .filter((g) => g.id >= a && g.id <= b)
        .map((g) => {
          const empty = g.glyphWidth === 0 || g.glyphHeight === 0;
          return {
            id: g.id,
            bitmap: empty ? new Uint8Array(0) : Uint8Array.from(g.data),
            width: empty ? 0 : g.glyphWidth,
            height: empty ? 0 : g.glyphHeight,
            left: Math.round(g.glyphLeft + 0.5),
            top: g.glyphTop - TOP_ADJUST,
            advance: Math.round(g.glyphAdvance),
          };
        });
      const buf = encodeRange(def.name, `${a}-${b}`, glyphs);
      writeFileSync(join(dir, `${a}-${b}.pbf`), buf);
      total++;
      console.log(
        `  ${def.name} ${a}-${b} : ${glyphs.length} glyphes, ${(buf.length / 1024).toFixed(1)} Ko`,
      );
    }
  }
  await browser.close();
  console.log(`OK : ${total} fichiers dans ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
