/** Listes de référence partagées (mises en cache) : catalogue, nations, recherche, photos, provinces. */
import { useMemo } from 'react';
import { hasRole, type AdminSystem, type NationDef } from '@redline/shared';
import { useCached, useSession } from '../context';
import type { PhotoEntry } from '../api/types';

export function useSystems(enabled = true) {
  const { api } = useSession();
  return useCached<AdminSystem[]>(enabled ? 'systems' : null, () =>
    api.listSystems().then((r) => r.systems),
  );
}

/** Nations : liste admin (données effectives) si le rôle le permet, sinon la liste publique. */
export function useNations() {
  const { api, user } = useSession();
  const admin = hasRole(user.role, 'balance');
  return useCached<NationDef[]>(admin ? 'nations' : 'nations-public', () =>
    (admin ? api.listNations() : api.publicNations()).then((r) => r.nations),
  );
}

export function useNationMap(): Map<string, NationDef> {
  const { data } = useNations();
  return useMemo(() => new Map((data ?? []).map((n) => [n.id, n])), [data]);
}

export function useResearch(enabled = true) {
  const { api } = useSession();
  return useCached(enabled ? 'research' : null, () => api.listResearch().then((r) => r.nodes));
}

export function useProvinces(enabled = true) {
  const { api } = useSession();
  return useCached(enabled ? 'provinces' : null, () =>
    api.listProvinces().then((r) => r.provinces),
  );
}

/** Manifeste des photos (absent : dictionnaire vide, jamais d'erreur bloquante). */
export function usePhotos() {
  const { api } = useSession();
  return useCached<Record<string, PhotoEntry>>('photos', () =>
    api.photos().then(
      (r) => r.photos ?? {},
      () => ({}),
    ),
  );
}

/** URL d'une photo du manifeste (fichier relatif → /art/photos/…). */
export function photoUrl(file: string, thumb = false): string {
  if (/^(data:|https?:|\/)/.test(file)) {
    return thumb && !file.startsWith('data:') ? file.replace(/\.webp$/, '.thumb.webp') : file;
  }
  const f = thumb ? file.replace(/\.webp$/, '.thumb.webp') : file;
  // « art/photos/x.webp » (chemin public du client) ou « x.webp » (nom seul).
  return f.includes('/') ? `/${f.replace(/^(public\/)?/, '')}` : `/art/photos/${f}`;
}
