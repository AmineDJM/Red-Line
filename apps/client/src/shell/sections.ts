import type { IconName } from '@redline/ui';
import type { WindowId } from '../store/ui.js';

export interface SectionDef {
  id: WindowId;
  icon: IconName;
  /** Touche qui ouvre la fenêtre (ordinateur). */
  key: string;
  /** Rangée de la barre latérale : haut (domaines), bas (outils). */
  group: 'main' | 'tools';
  /** Présent dans la barre de navigation mobile (sinon dans « Plus »). */
  mobile?: boolean;
}

/** Domaines de la coque de jeu, dans l'ordre de la barre latérale. */
export const SECTIONS: SectionDef[] = [
  { id: 'army', icon: 'army', key: 'A', group: 'main', mobile: true },
  { id: 'production', icon: 'production', key: 'P', group: 'main', mobile: true },
  { id: 'research', icon: 'research', key: 'R', group: 'main' },
  { id: 'economy', icon: 'economy', key: 'E', group: 'main' },
  { id: 'intel', icon: 'intel', key: 'I', group: 'main', mobile: true },
  { id: 'diplomacy', icon: 'diplomacy', key: 'D', group: 'main' },
  { id: 'council', icon: 'council', key: 'C', group: 'main' },
  { id: 'news', icon: 'news', key: 'N', group: 'main' },
  { id: 'battles', icon: 'battle', key: 'B', group: 'main' },
  { id: 'encyclopedia', icon: 'encyclopedia', key: 'Y', group: 'main' },
  { id: 'chat', icon: 'chat', key: 'M', group: 'tools' },
  { id: 'shop', icon: 'shop', key: 'O', group: 'tools' },
  { id: 'settings', icon: 'settings', key: ',', group: 'tools' },
];

export function sectionOf(id: WindowId): SectionDef {
  return SECTIONS.find((s) => s.id === id)!;
}
