import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PublicUser } from '@redline/shared';
import type { Api } from './api/client';
import { errorMessage } from './lib/errors';

/**
 * Cache partagé des listes de référence (catalogue, nations, recherche…) : chargées une fois,
 * réutilisées par les écrans, les sélecteurs et la palette de commandes ; invalidées après écriture.
 */
export class DataCache {
  private entries = new Map<string, Promise<unknown>>();
  private listeners = new Set<(key: string) => void>();
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.entries.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.entries.set(key, p);
      p.catch(() => this.entries.delete(key));
    }
    return p;
  }
  invalidate(...keys: string[]) {
    for (const k of keys) {
      this.entries.delete(k);
      for (const l of this.listeners) l(k);
    }
  }
  subscribe(fn: (key: string) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

export interface Session {
  api: Api;
  user: PublicUser;
  mock: boolean;
  cache: DataCache;
}
export const SessionCtx = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('Session absente');
  return s;
}

/** Donnée de référence partagée (clé de cache) ; se recharge si la clé est invalidée. */
export function useCached<T>(key: string | null, load: () => Promise<T>) {
  const { cache } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!key) return;
    return cache.subscribe((k) => k === key && setTick((t) => t + 1));
  }, [cache, key]);
  useEffect(() => {
    if (!key) return;
    let live = true;
    cache
      .get(key, () => loadRef.current())
      .then(
        (d) => {
          if (live) {
            setData(d as T);
            setError(null);
          }
        },
        (e: unknown) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [cache, key, tick]);
  const reload = useCallback(() => key && cache.invalidate(key), [cache, key]);
  return { data, error, reload };
}
