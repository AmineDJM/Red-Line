import {
  frLe,
  loc,
  type GovOffice,
  type LocParam,
  type LocText,
  type NationId,
} from '@redline/shared';
import { notify } from '../../state/access.js';
import { noteLoc } from '../../state/loc.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { govBal, govNation } from './state.js';

/**
 * Comptes rendus du gouvernement : journal de chaque poste (clés `engine.gov.j.<id>` + paramètres,
 * traduits par le client ; un paramètre `cost` est une somme en dollars) et notifications au joueur
 * pour ce qui demande son attention (mission accomplie, démission). Une entrée identique à la
 * précédente n'est pas répétée : elle est remise à l'heure.
 */

type Tone = 'info' | 'good' | 'warn' | 'bad';

export function journal(
  state: EngineState,
  n: NationId,
  office: GovOffice,
  id: string,
  params: Record<string, LocParam> = {},
  tone: Tone = 'info',
  missionId?: string,
): LocText {
  const text = loc(`engine.gov.j.${id}`, params);
  const gn = govNation(state, n);
  const list = (gn.journal[office] ??= []);
  const last = list[list.length - 1];
  if (
    last &&
    last.missionId === missionId &&
    last.text.key === text.key &&
    JSON.stringify(last.text.params ?? {}) === JSON.stringify(text.params ?? {})
  ) {
    last.t = state.time;
    return text;
  }
  list.push({ t: state.time, text, tone, ...(missionId ? { missionId } : {}) });
  const max = govBal(state).journalMax;
  if (list.length > max) list.splice(0, list.length - max);
  return text;
}

/** Textes français de repli des notifications (le client affiche la clé traduite). */
const FR: Record<string, [string, string]> = {
  resigned: ['Démission', '{{name}} démissionne : son poste n’est plus payé.'],
  missionDone: ['Mission accomplie', '{{mission}} : objectif atteint.'],
};

function frText(state: EngineState, s: string, params: Record<string, LocParam>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if ('nation' in v) {
      const d = wi(state.world).nationById.get(v.nation);
      return d ? frLe(d.name, d.article) : v.nation;
    }
    if ('key' in v) return FR_MISSIONS[v.key.split('.').pop() ?? ''] ?? '';
    return '';
  });
}

/** Noms français des missions (repli des notifications). */
const FR_MISSIONS: Record<string, string> = {
  air_bases: 'Bases aériennes',
  military_bases: 'Bases militaires',
  upgrade_bases: 'Modernisation des bases',
  logistics: 'Logistique militaire',
  fortify: 'Fortification des frontières',
  air_defense: 'Défense antiaérienne du territoire',
  coastal: 'Défense côtière',
  research_next: 'Prochaine génération',
  research_branch: 'Recherche par domaine',
  research_labs: 'Laboratoires',
  produce: 'Commande de matériel',
  stockpile: 'Stocks',
  arms_industry: 'Industrie d’armement',
  counterintel: 'Contre-espionnage',
  protect_sites: 'Protection des sites',
  watch: 'Surveillance',
  map_defenses: 'Cartographie des défenses',
  economic_intel: 'Renseignement économique',
  resource: 'Production de ressources',
  industry: 'Industrie',
  revenue: 'Revenus',
  war_economy: 'Économie de guerre',
  reserves: 'Réserves',
  repair: 'Reconstruction',
};

export function notifyOwner(
  state: EngineState,
  n: NationId,
  id: string,
  params: Record<string, LocParam>,
  severity: 'info' | 'warn' | 'critical',
): void {
  const [title, text] = FR[id] ?? ['Gouvernement', ''];
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at: null,
      category: 'government',
      title,
      text: frText(state, text, params),
      severity,
      loc: noteLoc(`gov_${id}`, params),
    },
    [n],
  );
}
