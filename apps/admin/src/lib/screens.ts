/** Registre des écrans : barre latérale, invite de commande, palette et contrôle des rôles. */
import type { Role } from '@redline/shared';
import { T } from '../i18n';
import { O } from '../i18n/fr-ops';
import type { Route, RouteName } from './router';

export type Group = 'data' | 'ops' | 'system';

export interface ScreenDef {
  id: string;
  route: Route;
  /** Routes rattachées (sous-pages). */
  match: RouteName[];
  label: string;
  /** Segment d'invite PowerShell (sans accents ni espaces). */
  ps: string;
  /** Alias de la commande « goto ». */
  alias: string;
  icon: string;
  group: Group;
  role: Role;
}

export const SCREENS: ScreenDef[] = [
  {
    id: 'catalog',
    route: { name: 'catalog' },
    match: ['catalog', 'system', 'new', 'history'],
    label: T.nav.catalog,
    ps: 'Catalogue',
    alias: 'catalogue',
    icon: 'catalog',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'rules',
    route: { name: 'rules' },
    match: ['rules'],
    label: T.nav.rules,
    ps: 'Regles',
    alias: 'regles',
    icon: 'rules',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'research',
    route: { name: 'research' },
    match: ['research'],
    label: T.nav.research,
    ps: 'Recherche',
    alias: 'recherche',
    icon: 'research',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'orbat',
    route: { name: 'orbat' },
    match: ['orbat'],
    label: T.nav.orbat,
    ps: 'ORBAT',
    alias: 'orbat',
    icon: 'orbat',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'scenarios',
    route: { name: 'scenarios' },
    match: ['scenarios'],
    label: T.nav.scenarios,
    ps: 'Scenarios',
    alias: 'scenarios',
    icon: 'scenarios',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'map',
    route: { name: 'map', tab: 'nations' },
    match: ['map'],
    label: T.nav.map,
    ps: 'Carte',
    alias: 'carte',
    icon: 'map',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'import',
    route: { name: 'import' },
    match: ['import'],
    label: T.nav.importExport,
    ps: 'ImportExport',
    alias: 'import',
    icon: 'import',
    group: 'data',
    role: 'balance',
  },
  {
    id: 'games',
    route: { name: 'games' },
    match: ['games'],
    label: T.nav.games,
    ps: 'Parties',
    alias: 'parties',
    icon: 'games',
    group: 'ops',
    role: 'moderator',
  },
  {
    id: 'chat',
    route: { name: 'chat' },
    match: ['chat'],
    label: T.nav.chat,
    ps: 'Messagerie',
    alias: 'chat',
    icon: 'chat',
    group: 'ops',
    role: 'moderator',
  },
  {
    id: 'security',
    route: { name: 'security' },
    match: ['security'],
    label: T.nav.security,
    ps: 'Securite',
    alias: 'securite',
    icon: 'security',
    group: 'ops',
    role: 'moderator',
  },
  {
    id: 'users',
    route: { name: 'users' },
    match: ['users'],
    label: T.nav.users,
    ps: 'Utilisateurs',
    alias: 'utilisateurs',
    icon: 'users',
    group: 'ops',
    role: 'superadmin',
  },
  {
    id: 'shop',
    route: { name: 'shop', tab: 'packs' },
    match: ['shop'],
    label: T.nav.shop,
    ps: 'Boutique',
    alias: 'boutique',
    icon: 'shop',
    group: 'ops',
    role: 'superadmin',
  },
  {
    id: 'audit',
    route: { name: 'audit' },
    match: ['audit'],
    label: T.nav.audit,
    ps: 'Journal',
    alias: 'journal',
    icon: 'audit',
    group: 'system',
    role: 'superadmin',
  },
  {
    id: 'metrics',
    route: { name: 'metrics' },
    match: ['metrics'],
    label: T.nav.metrics,
    ps: 'Metriques',
    alias: 'metriques',
    icon: 'metrics',
    group: 'system',
    role: 'moderator',
  },
  {
    id: 'legal',
    route: { name: 'legal' },
    match: ['legal'],
    label: T.nav.legal,
    ps: 'Reglages\\Legal',
    alias: 'legal',
    icon: 'legal',
    group: 'system',
    role: 'moderator',
  },
  {
    id: 'data',
    route: { name: 'data' },
    match: ['data'],
    label: T.nav.data,
    ps: 'Donnees',
    alias: 'donnees',
    icon: 'data',
    group: 'system',
    role: 'balance',
  },
  // ——— Économie du service et gestion complète
  {
    id: 'economy',
    route: { name: 'economy', tab: 'dashboard' },
    match: ['economy'],
    label: O.nav.economy,
    ps: 'Economie',
    alias: 'economie',
    icon: 'coin',
    group: 'ops',
    role: 'superadmin',
  },
  {
    id: 'archive',
    route: { name: 'archive' },
    match: ['archive'],
    label: O.nav.archive,
    ps: 'Archives',
    alias: 'archives',
    icon: 'history',
    group: 'ops',
    role: 'moderator',
  },
  {
    id: 'announcements',
    route: { name: 'announcements' },
    match: ['announcements'],
    label: O.nav.announcements,
    ps: 'Annonces',
    alias: 'annonces',
    icon: 'megaphone',
    group: 'ops',
    role: 'superadmin',
  },
  {
    id: 'settings',
    route: { name: 'settings' },
    match: ['settings'],
    label: O.nav.settings,
    ps: 'Parametres',
    alias: 'parametres',
    icon: 'gear',
    group: 'system',
    role: 'moderator',
  },
];

export const GROUPS: Group[] = ['data', 'ops', 'system'];

export function screenOf(r: Route): ScreenDef | undefined {
  return SCREENS.find((s) => s.match.includes(r.name));
}

/** Chemin de l'invite pour une route : « Catalogue\eu.rafale ». */
export function promptPath(r: Route): string {
  const s = screenOf(r);
  const base = s?.ps ?? '';
  switch (r.name) {
    case 'system':
      return `${base}\\${r.id}`;
    case 'history':
      return `${base}\\${r.id}\\Historique`;
    case 'new':
      return `${base}\\Nouveau`;
    case 'rules':
      return r.section ? `${base}\\${r.section}` : base;
    case 'research':
      return r.id ? `${base}\\${r.id}` : base;
    case 'orbat':
      return [base, r.set, r.nation].filter(Boolean).join('\\');
    case 'scenarios':
      return r.id ? `${base}\\${r.id}` : base;
    case 'map':
      return [
        base,
        r.tab === 'nations' ? 'Nations' : r.tab === 'provinces' ? 'Provinces' : 'Disputes',
        r.id,
      ]
        .filter(Boolean)
        .join('\\');
    case 'games':
      return r.id ? `${base}\\${r.id.slice(0, 8)}` : base;
    case 'users':
      return r.id ? `${base}\\${r.id.slice(0, 8)}` : base;
    case 'shop':
      return `${base}\\${r.tab}`;
    case 'economy':
      return `${base}\\${r.tab}`;
    default:
      return base;
  }
}
