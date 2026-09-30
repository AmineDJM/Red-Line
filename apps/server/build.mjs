// Build de production : bundle esbuild de src/main.ts (et des outils CLI) avec les paquets @redline/*
// intégrés, les dépendances déclarées dans package.json restant externes (résolues dans node_modules).
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const external = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter(
  (d) => !d.startsWith('@redline/'),
);

rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    main: 'src/main.ts',
    migrate: 'src/db/migrate.ts',
    'catalog-reset': 'src/cli/catalog-reset.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Sous-chemins inclus (drizzle-orm/postgres-js, …).
  external: external.flatMap((d) => [d, `${d}/*`]),
  // Les dépendances CommonJS intégrées (via @redline/*) peuvent appeler require().
  banner: {
    js: "import { createRequire as __rlCreateRequire } from 'node:module'; const require = __rlCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Fichiers statiques précompressés (Brotli + gzip) servis tels quels par le serveur.
const { precompress } = await import('./scripts/precompress.mjs');
const repo = join(root, '..', '..');
const r = await precompress([
  join(repo, 'apps/client/dist'),
  join(repo, 'apps/admin/dist'),
  join(repo, 'data/basemap'),
]);
console.log(
  `précompression : ${r.files} fichiers, ${(r.before / 1048576).toFixed(1)} Mio → ${(r.after / 1048576).toFixed(1)} Mio (Brotli)`,
);
