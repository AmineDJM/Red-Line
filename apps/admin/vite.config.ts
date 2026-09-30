import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect } from 'vite';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.REDLINE_API ?? 'http://localhost:3000';
const root = resolve(import.meta.dirname, '../..');

/**
 * Développement et aperçu sans serveur (?mock=1) : sert les fichiers publics que le serveur réel expose
 * sur la même origine (géométrie des provinces, drapeaux et photos du client).
 */
function staticFromRepo(): Plugin {
  const routes: [RegExp, (m: RegExpExecArray) => string, string][] = [
    [
      /^\/api\/map\/provinces\.geojson$/,
      () => resolve(root, 'data/map/provinces.geojson'),
      'application/geo+json',
    ],
    [
      /^\/flags\/([a-z0-9-]+\.svg)$/,
      (m) => resolve(root, 'apps/client/public/flags', m[1]!),
      'image/svg+xml',
    ],
    [
      /^\/art\/photos\/([\w.-]+\.webp)$/,
      (m) => resolve(root, 'apps/client/public/art/photos', m[1]!),
      'image/webp',
    ],
  ];
  const mw: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? '').split('?')[0]!;
    for (const [re, file, type] of routes) {
      const m = re.exec(url);
      if (!m) continue;
      const path = file(m);
      if (!existsSync(path)) break;
      res.setHeader('content-type', type);
      res.setHeader('content-length', statSync(path).size);
      createReadStream(path).pipe(res);
      return;
    }
    next();
  };
  return {
    name: 'redline-static-from-repo',
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
  };
}

export default defineConfig({
  base: '/admin/',
  plugins: [react(), ...(process.env.REDLINE_API ? [] : [staticFromRepo()])],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/admin/api': { target, changeOrigin: false },
      '/api': { target, changeOrigin: false },
    },
  },
  preview: { port: 5174 },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
