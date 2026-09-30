/**
 * Vérifie les glyphes générés : décodage protobuf, tailles des bitmaps, caractères essentiels.
 *   pnpm --filter @redline/tools-glyphs check
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PbfReader } from 'pbf';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'glyphs');
const STACKS = [
  'Barlow Condensed Bold',
  'IBM Plex Sans Regular',
  'IBM Plex Sans SemiBold',
  'IBM Plex Sans Italic',
];
const RANGES = ['0-255', '256-511', '512-767', '8192-8447'];
const BUFFER = 3;

export interface DecodedGlyph {
  id: number;
  bitmap?: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export function decode(buf: Uint8Array): { name: string; range: string; glyphs: DecodedGlyph[] }[] {
  const stacks: { name: string; range: string; glyphs: DecodedGlyph[] }[] = [];
  new PbfReader(buf).readFields((tag, _obj, pbf) => {
    if (tag !== 1 || !pbf) return;
    const st = { name: '', range: '', glyphs: [] as DecodedGlyph[] };
    pbf.readMessage((t, s, p) => {
      if (!p) return;
      if (t === 1) s.name = p.readString();
      else if (t === 2) s.range = p.readString();
      else if (t === 3) {
        const g: DecodedGlyph = { id: 0, width: 0, height: 0, left: 0, top: 0, advance: 0 };
        p.readMessage((k, gl, q) => {
          if (!q) return;
          if (k === 1) gl.id = q.readVarint();
          else if (k === 2) gl.bitmap = q.readBytes();
          else if (k === 3) gl.width = q.readVarint();
          else if (k === 4) gl.height = q.readVarint();
          else if (k === 5) gl.left = q.readSVarint();
          else if (k === 6) gl.top = q.readSVarint();
          else if (k === 7) gl.advance = q.readVarint();
        }, g);
        s.glyphs.push(g);
      }
    }, st);
    stacks.push(st);
  }, null);
  return stacks;
}

function main() {
  let errors = 0;
  const must: Record<string, number[]> = {
    '0-255': [...'AZaz09 éèàçÉ«»'].map((c) => c.codePointAt(0)!),
    '256-511': [...'ŒœŁąęśž'].map((c) => c.codePointAt(0)!),
    '8192-8447': [...'–—…’“”'].map((c) => c.codePointAt(0)!),
  };
  for (const s of STACKS)
    for (const r of RANGES) {
      const f = join(OUT, s, `${r}.pbf`);
      if (!existsSync(f)) {
        console.error(`manquant : ${f}`);
        errors++;
        continue;
      }
      const [st] = decode(readFileSync(f));
      if (!st || st.name !== s || st.range !== r) {
        console.error(`en-tête incorrect : ${f}`);
        errors++;
        continue;
      }
      for (const g of st.glyphs) {
        const expected = g.width && g.height ? (g.width + 2 * BUFFER) * (g.height + 2 * BUFFER) : 0;
        if ((g.bitmap?.length ?? 0) !== expected) {
          console.error(
            `${s} ${r} U+${g.id.toString(16)} : bitmap ${g.bitmap?.length} ≠ ${expected}`,
          );
          errors++;
        }
      }
      const ids = new Set(st.glyphs.map((g) => g.id));
      for (const cp of must[r] ?? [])
        if (!ids.has(cp)) {
          console.error(`${s} ${r} : caractère absent ${String.fromCodePoint(cp)}`);
          errors++;
        }
      const a = st.glyphs.find((g) => g.id === 65);
      console.log(
        `${s.padEnd(24)} ${r.padEnd(10)} ${String(st.glyphs.length).padStart(4)} glyphes` +
          (a
            ? `  « A » ${a.width}×${a.height} left ${a.left} top ${a.top} advance ${a.advance}`
            : ''),
      );
    }
  if (errors) {
    console.error(`${errors} erreur(s)`);
    process.exit(1);
  }
  console.log('OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
