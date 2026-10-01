import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Tests de bout en bout contre le vrai serveur (build de production) et une vraie base PostgreSQL.
// Prérequis : `pnpm build` et une base (en local : `pnpm --filter @redline/server db:dev`).
// Chromium préinstallé : PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (ne jamais lancer `playwright install`).
if (existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/redline_e2e';

const webgl = {
  launchOptions: {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'fr-FR',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'ordinateur',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...webgl },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        ...webgl,
      },
    },
  ],
  webServer: {
    command: 'node apps/server/dist/main.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'development',
      DATABASE_URL,
      MIGRATE_ON_START: 'true',
      LOG_LEVEL: 'warn',
      // Vitesse d'essai (1 h réelle = 3 600 h de jeu), refusée par le serveur en production.
      REDLINE_EXTRA_SPEEDS: '3600',
      // Super-admin de la base d'essai, en mode illimité d'office (e2e/unlimited.spec.ts, E2E_ADMIN).
      ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL ?? 'admin@redline.test',
      ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD ?? 'motdepasse-e2e-admin',
    },
  },
});
