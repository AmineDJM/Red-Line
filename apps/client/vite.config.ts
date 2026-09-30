import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localData } from './vite/local-data.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const target = process.env.REDLINE_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.REDLINE_LOCAL_DATA
      ? [
          localData(
            path.join(repoRoot, 'data'),
            process.env.TILES_DIR ?? path.join(repoRoot, 'data/tiles'),
          ),
        ]
      : []),
  ],
  server: {
    port: 5173,
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
      '/tiles': { target, changeOrigin: true },
      '/basemap': { target, changeOrigin: true },
      '/glyphs': { target, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
      '/tiles': { target, changeOrigin: true },
      '/basemap': { target, changeOrigin: true },
      '/glyphs': { target, changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'maplibre',
              test: /node_modules[\\/](\.pnpm[\\/])?(maplibre-gl|@maplibre|pmtiles)/,
              priority: 30,
            },
            {
              name: 'react',
              test: /node_modules[\\/](\.pnpm[\\/])?(react|react-dom|scheduler)[@\\/]/,
              priority: 20,
            },
            { name: 'engine', test: /packages[\\/]engine[\\/]|h3-js/, priority: 25 },
          ],
        },
      },
    },
  },
});
