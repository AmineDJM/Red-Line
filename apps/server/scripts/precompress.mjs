// Précompression des fichiers statiques (jeu, back-office, fond de carte) : à côté de chaque fichier texte,
// une version Brotli (.br) et gzip (.gz). Le serveur les sert tels quels (@fastify/static, preCompressed)
// selon l'en-tête Accept-Encoding du navigateur, sans compresser à la volée.
// Appelé par build.mjs après la construction du client et du back-office ; sans effet si un dossier manque.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zc } from 'node:zlib';

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const EXT = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.svg',
  '.json',
  '.webmanifest',
  '.geojson',
  '.txt',
  '.wasm',
]);
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(name)) && st.size >= MIN_BYTES) yield p;
  }
}

export async function precompress(dirs) {
  let files = 0;
  let before = 0;
  let after = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const list = [...walk(dir)];
    // Par lots : les compressions tournent dans le pool de threads de libuv.
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(
        list.slice(i, i + 8).map(async (p) => {
          const body = readFileSync(p);
          const [b, g] = await Promise.all([
            br(body, {
              params: {
                [zc.BROTLI_PARAM_QUALITY]: 10,
                [zc.BROTLI_PARAM_SIZE_HINT]: body.length,
              },
            }),
            gz(body, { level: 9 }),
          ]);
          // Inutile si le gain est négligeable (fichier déjà compressé).
          if (g.length > body.length * 0.9) return;
          writeFileSync(`${p}.br`, b);
          writeFileSync(`${p}.gz`, g);
          files++;
          before += body.length;
          after += b.length;
        }),
      );
    }
  }
  return { files, before, after };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await precompress(process.argv.slice(2));
  console.log(
    `précompression : ${r.files} fichiers, ${(r.before / 1048576).toFixed(1)} Mio → ${(r.after / 1048576).toFixed(1)} Mio (Brotli)`,
  );
}
