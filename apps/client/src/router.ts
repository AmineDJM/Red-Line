import { useSyncExternalStore } from 'react';
import { IS_MOCK } from './config.js';

/** Routeur minimal (History API) : /, /new, /game/:id, /sandbox. */
export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'game'; id: string }
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

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/new') return { name: 'new' };
  if (p === '/sandbox') return { name: 'sandbox' };
  const m = /^\/game\/([^/]+)$/.exec(p);
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
