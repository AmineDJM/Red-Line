import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.REDLINE_API ?? 'http://localhost:3000';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/admin/api': { target, changeOrigin: false },
      '/api': { target, changeOrigin: false },
    },
  },
  preview: { port: 5174 },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
