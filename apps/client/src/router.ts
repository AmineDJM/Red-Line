import { useSyncExternalStore } from 'react';
import type { LegalDocRef } from '@redline/shared';
import { IS_MOCK } from './config.js';

/** Routeur minimal (History API). */
export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'game'; id: string }
  | { name: 'spectate'; id: string }
  | { name: 'end'; id: string }
  | { name: 'lobby' }
  | { name: 'lobbyCreate' }
  | { name: 'lobbyJoin'; id: string }
  | { name: 'lobbyRoom'; id: string }
  | { name: 'games' }
  | { name: 'shop' }
  | { name: 'rankings' }
  | { name: 'legal'; doc: LegalDocRef['id'] }
  | { name: 'sandbox' }
  | { name: 'notFound' };

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') window.addEventListener('popstate', emit);

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(): string {
  return window.location.pathname + window.location.search;
}

const LEGAL = new Set(['cgu', 'cgv', 'privacy', 'withdrawal']);

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/new') return { name: 'new' };
  if (p === '/sandbox') return { name: 'sandbox' };
  if (p === '/lobby') return { name: 'lobby' };
  if (p === '/lobby/new') return { name: 'lobbyCreate' };
  if (p === '/games') return { name: 'games' };
  if (p === '/shop') return { name: 'shop' };
  if (p === '/rankings') return { name: 'rankings' };
  let m = /^\/legal\/([a-z]+)$/.exec(p);
  if (m?.[1] && LEGAL.has(m[1])) return { name: 'legal', doc: m[1] as LegalDocRef['id'] };
  m = /^\/lobby\/([^/]+)\/room$/.exec(p);
  if (m?.[1]) return { name: 'lobbyRoom', id: decodeURIComponent(m[1]) };
  m = /^\/lobby\/([^/]+)$/.exec(p);
  if (m?.[1]) return { name: 'lobbyJoin', id: decodeURIComponent(m[1]) };
  m = /^\/game\/([^/]+)\/end$/.exec(p);
  if (m?.[1]) return { name: 'end', id: decodeURIComponent(m[1]) };
  m = /^\/spectate\/([^/]+)$/.exec(p);
  if (m?.[1]) return { name: 'spectate', id: decodeURIComponent(m[1]) };
  m = /^\/game\/([^/]+)$/.exec(p);
  if (m?.[1]) return { name: 'game', id: decodeURIComponent(m[1]) };
  return { name: 'notFound' };
}

export function useRoute(): Route {
  const s = useSyncExternalStore(subscribe, snapshot, () => '/');
  return parseRoute(s.split('?')[0] ?? '/');
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, window.location.origin);
  if (IS_MOCK && !url.searchParams.has('mock')) url.searchParams.set('mock', '1');
  const target = url.pathname + url.search;
  if (opts.replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  emit();
}
