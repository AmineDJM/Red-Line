import type { Branch, OpCategory } from '@redline/shared';
import type { IconName } from '@redline/ui';

/** Icône de chaque objectif d'opération (catalogue du QG, tableau de bord, liste). */
export const GOAL_ICON: Record<string, IconName> = {
  attrition: 'bolt',
  air_control: 'radio',
  conquest: 'flag',
  decapitation: 'crown',
  strategic: 'factory',
  sead: 'missile',
  blockade: 'anchor',
  defend_border: 'shield',
  occupy: 'mapPin',
  counteroffensive: 'replay',
  liberation: 'unlock',
  encircle: 'encircle',
  breakthrough: 'breach',
  raid: 'route',
  siege: 'building',
  defense_depth: 'layers',
  defend_capital: 'home',
  pacify: 'handshake',
  show_of_force: 'eye',
  interdiction: 'truck',
  cas: 'crosshair',
  strategic_bombing: 'oil',
  air_defense_territory: 'plane',
  air_redeploy: 'arrowRight',
  armed_recon: 'search',
  naval_supremacy: 'ship',
  antiship: 'target',
  convoy_escort: 'box',
  amphibious: 'flag',
  port_blockade: 'lock',
  naval_strikes: 'missile',
  missile_shield: 'shield',
  ad_umbrella: 'umbrella',
  missile_campaign: 'bolt',
  blitz: 'forward',
  combined_landing: 'link',
  ally_support: 'users',
};

export const BRANCH_ICON: Record<Branch, IconName> = {
  land: 'army',
  air: 'plane',
  sea: 'ship',
  ad: 'shield',
};

/** Catégories du catalogue. */
export const CAT_ICON: Record<OpCategory, IconName> = {
  land: 'army',
  air: 'plane',
  sea: 'ship',
  ad: 'missile',
  joint: 'link',
};
