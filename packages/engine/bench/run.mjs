// Lance un banc d'essai compilé comme en production (bundle esbuild, sans `keepNames` : c'est ainsi que
// apps/server/build.mjs intègre le moteur), puis l'exécute dans ce processus. Les options de node
// (--cpu-prof, --expose-gc…) s'appliquent donc au banc lui-même.
//   node --expose-gc bench/run.mjs real            (bench/real.ts)
//   node --cpu-prof bench/run.mjs step <instantané.bin> 24 6
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? 'real';
const out = join(here, '../node_modules/.cache/redline-bench', `${name}.mjs`);
mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [join(here, `${name}.ts`)],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  // Paquets du dépôt (@redline/*) intégrés comme dans apps/server/build.mjs ; dépendances externes.
  external: ['h3-js', '@msgpack/msgpack'],
  logLevel: 'warning',
});
process.argv.splice(2, 1);
await import(pathToFileURL(out).href);
