/**
 * Photos réelles des systèmes d'armes : champ `system.photo` du catalogue, sinon manifeste
 * `data/art/photos.json` (systemId → { file, credit, license, sourceUrl }) servi avec le client.
 * Fichiers : /art/photos/<systemId>.webp et vignette <systemId>.thumb.webp.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { WeaponSystem } from '@redline/shared';
import type { WeaponPhotoInfo } from '@redline/ui';
import { bundledPhotoManifest } from './staticData.js';

export interface PhotoEntry {
  file: string;
  credit: string;
  license: string;
  sourceUrl?: string;
  thumb?: string;
}

type Manifest = Record<string, PhotoEntry>;

function normalize(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  // Formes acceptées : { id: entry }, { photos: { id: entry } }, { photos: [{ systemId, ... }] }.
  const inner = (obj.photos ?? obj) as unknown;
  const out: Manifest = {};
  if (Array.isArray(inner)) {
    for (const e of inner as (PhotoEntry & { systemId?: string; id?: string })[]) {
      const id = e.systemId ?? e.id;
      if (id && e.file) out[id] = e;
    }
  } else if (inner && typeof inner === 'object') {
    for (const [id, e] of Object.entries(inner as Record<string, PhotoEntry>))
      if (e && typeof e === 'object' && typeof e.file === 'string') out[id] = e;
  }
  return out;
}

function resolveUrl(file: string): string {
  if (/^(https?:)?\/\//.test(file) || file.startsWith('/')) return file;
  if (file.startsWith('art/') || file.startsWith('public/'))
    return `/${file.replace(/^public\//, '')}`;
  return `/art/photos/${file}`;
}

function thumbOf(url: string): string {
  return url.replace(/(\.thumb)?\.(webp|jpe?g|png)$/i, '.thumb.webp');
}

interface PhotoStore {
  manifest: Manifest;
  status: 'idle' | 'loading' | 'ready';
  load(): Promise<void>;
}

export const usePhotoStore = create<PhotoStore>((set, get) => ({
  manifest: {},
  status: 'idle',
  async load() {
    if (get().status !== 'idle') return;
    set({ status: 'loading' });
    let manifest = normalize(await bundledPhotoManifest().catch(() => null));
    if (!Object.keys(manifest).length) {
      try {
        const res = await fetch('/art/photos.json');
        if (res.ok && (res.headers.get('content-type') ?? '').includes('json'))
          manifest = normalize(await res.json());
      } catch {
        /* pas de manifeste servi */
      }
    }
    set({ manifest, status: 'ready' });
  },
}));

/** Photo d'un système (null : afficher le pictogramme). */
export function photoFor(
  system: Pick<WeaponSystem, 'id' | 'photo'> | undefined,
  manifest: Manifest,
): WeaponPhotoInfo | null {
  if (!system) return null;
  const e: PhotoEntry | undefined = system.photo ?? manifest[system.id];
  if (!e?.file) return null;
  const src = resolveUrl(e.file);
  return {
    src,
    thumb: e.thumb ? resolveUrl(e.thumb) : thumbOf(src),
    credit: e.credit,
    license: e.license,
    sourceUrl: e.sourceUrl,
  };
}

/** Manifeste des photos (chargé une fois). */
export function usePhotos(): Manifest {
  const manifest = usePhotoStore((s) => s.manifest);
  const load = usePhotoStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return manifest;
}
