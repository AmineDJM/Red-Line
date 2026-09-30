/** Routage par fragment (#/…) : aucune réécriture côté serveur nécessaire sous /admin/. */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'catalog' }
  | { name: 'new' }
  | { name: 'system'; id: string }
  | { name: 'history'; id: string }
  | { name: 'import' }
  | { name: 'games' }
  | { name: 'metrics' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'systems':
      if (parts[1] === 'new' && !parts[2]) return { name: 'new' };
      if (parts[1] && parts[2] === 'history') return { name: 'history', id: parts[1] };
      if (parts[1]) return { name: 'system', id: parts[1] };
      return { name: 'catalog' };
    case 'import':
      return { name: 'import' };
    case 'games':
      return { name: 'games' };
    case 'metrics':
      return { name: 'metrics' };
    default:
      return { name: 'catalog' };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'catalog':
      return '#/catalog';
    case 'new':
      return '#/systems/new';
    case 'system':
      return `#/systems/${encodeURIComponent(r.id)}`;
    case 'history':
      return `#/systems/${encodeURIComponent(r.id)}/history`;
    default:
      return `#/${r.name}`;
  }
}

export function navigate(r: Route) {
  window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
