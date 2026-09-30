/** Téléchargement des sources Natural Earth avec cache local (tools/map/.cache, ignoré par git). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NE_BASE } from './config.js';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(TOOL_DIR, '..', '..');
export const CACHE_DIR = join(TOOL_DIR, '.cache');

export interface Feature<P = Record<string, unknown>> {
  type: 'Feature';
  properties: P;
  geometry: { type: string; coordinates: unknown } | null;
}
export interface FeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Feature<P>[];
}

export async function loadNE<P = Record<string, unknown>>(
  name: string,
): Promise<FeatureCollection<P>> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${name}.geojson`);
  if (!existsSync(file)) {
    const url = `${NE_BASE}/${name}.geojson`;
    console.log(`  téléchargement ${url}`);
    await download(url, file);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as FeatureCollection<P>;
}

/** curl d'abord (respecte HTTPS_PROXY), sinon fetch. */
export async function download(url: string, file: string): Promise<void> {
  try {
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', `${file}.part`, url], {
      stdio: 'inherit',
    });
    execFileSync('mv', [`${file}.part`, file]);
    return;
  } catch {
    // repli sur fetch
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
