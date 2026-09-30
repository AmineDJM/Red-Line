import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Résolution des chemins indépendante de process.cwd() : on remonte depuis l'emplacement de CE fichier
 * (src/paths.ts en dev, dist/main.js une fois bundlé).
 */
const here = dirname(fileURLToPath(import.meta.url));

function findUp(start: string, test: (dir: string) => boolean): string | null {
  let dir = resolve(start);
  for (;;) {
    if (test(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isServerPackage(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@redline/server';
  } catch {
    return false;
  }
}

/** Dossier apps/server. */
export const SERVER_ROOT: string = findUp(here, isServerPackage) ?? resolve(here, '..');

/** Racine du monorepo (dossier contenant pnpm-workspace.yaml). */
export const REPO_ROOT: string =
  findUp(SERVER_ROOT, (d) => existsSync(join(d, 'pnpm-workspace.yaml'))) ??
  resolve(SERVER_ROOT, '..', '..');

/** Dossier des migrations SQL générées par drizzle-kit. */
export const MIGRATIONS_DIR: string = join(SERVER_ROOT, 'drizzle');
