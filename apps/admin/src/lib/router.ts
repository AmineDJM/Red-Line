/** Routage par fragment (#/…) : aucune réécriture côté serveur nécessaire sous /admin/. */
import { useEffect, useState } from 'react';

export type MapTab = 'nations' | 'provinces' | 'disputed';
export type ShopTab = 'packs' | 'promotions' | 'purchases';

export type Route =
  | { name: 'catalog' }
  | { name: 'new' }
  | { name: 'system'; id: string }
  | { name: 'history'; id: string }
  | { name: 'import' }
  | { name: 'rules'; section?: string }
  | { name: 'research'; id?: string }
  | { name: 'orbat'; set?: string; nation?: string }
  | { name: 'scenarios'; id?: string }
  | { name: 'map'; tab: MapTab; id?: string }
  | { name: 'games'; id?: string }
  | { name: 'chat'; gameId?: string }
  | { name: 'security' }
  | { name: 'users'; id?: string }
  | { name: 'shop'; tab: ShopTab }
  | { name: 'audit' }
  | { name: 'metrics' }
  | { name: 'data' };

export type RouteName = Route['name'];

const MAP_TABS: MapTab[] = ['nations', 'provinces', 'disputed'];
const SHOP_TABS: ShopTab[] = ['packs', 'promotions', 'purchases'];

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  switch (a) {
    case 'systems':
      if (b === 'new' && !c) return { name: 'new' };
      if (b && c === 'history') return { name: 'history', id: b };
      if (b) return { name: 'system', id: b };
      return { name: 'catalog' };
    case 'catalog':
      return { name: 'catalog' };
    case 'import':
      return { name: 'import' };
    case 'rules':
      return b ? { name: 'rules', section: b } : { name: 'rules' };
    case 'research':
      return b ? { name: 'research', id: b } : { name: 'research' };
    case 'orbat':
      return { name: 'orbat', ...(b ? { set: b } : {}), ...(c ? { nation: c } : {}) };
    case 'scenarios':
      return b ? { name: 'scenarios', id: b } : { name: 'scenarios' };
    case 'map':
      return {
        name: 'map',
        tab: MAP_TABS.includes(b as MapTab) ? (b as MapTab) : 'nations',
        ...(c ? { id: c } : {}),
      };
    case 'games':
      return b ? { name: 'games', id: b } : { name: 'games' };
    case 'chat':
      return b ? { name: 'chat', gameId: b } : { name: 'chat' };
    case 'users':
      return b ? { name: 'users', id: b } : { name: 'users' };
    case 'shop':
      return { name: 'shop', tab: SHOP_TABS.includes(b as ShopTab) ? (b as ShopTab) : 'packs' };
    case 'security':
    case 'audit':
    case 'metrics':
    case 'data':
      return { name: a };
    default:
      return { name: 'catalog' };
  }
}

const e = encodeURIComponent;

export function href(r: Route): string {
  switch (r.name) {
    case 'catalog':
      return '#/catalog';
    case 'new':
      return '#/systems/new';
    case 'system':
      return `#/systems/${e(r.id)}`;
    case 'history':
      return `#/systems/${e(r.id)}/history`;
    case 'rules':
      return r.section ? `#/rules/${e(r.section)}` : '#/rules';
    case 'research':
      return r.id ? `#/research/${e(r.id)}` : '#/research';
    case 'orbat':
      return `#/orbat${r.set ? `/${e(r.set)}` : ''}${r.set && r.nation ? `/${e(r.nation)}` : ''}`;
    case 'scenarios':
      return r.id ? `#/scenarios/${e(r.id)}` : '#/scenarios';
    case 'map':
      return `#/map/${r.tab}${r.id ? `/${e(r.id)}` : ''}`;
    case 'games':
      return r.id ? `#/games/${e(r.id)}` : '#/games';
    case 'chat':
      return r.gameId ? `#/chat/${e(r.gameId)}` : '#/chat';
    case 'users':
      return r.id ? `#/users/${e(r.id)}` : '#/users';
    case 'shop':
      return `#/shop/${r.tab}`;
    default:
      return `#/${r.name}`;
  }
}

export function navigate(r: Route, replace = false) {
  if (replace) {
    window.history.replaceState(null, '', href(r));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
