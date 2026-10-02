import { frLe, loc, type LngLat, type LocParam, type NationId } from '@redline/shared';
import { notify } from '../../state/access.js';
import { noteLoc } from '../../state/loc.js';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { cmdBal, type ArmySt } from './state.js';

/**
 * Comptes rendus du général : journal de l'armée (clés `engine.cmd.j.<id>` + paramètres, traduits par
 * le client) et notifications au joueur pour ce qui demande son attention (autorisation, renforts,
 * mission réussie ou échouée, général blessé, tué ou démissionnaire). Le moteur ne porte que des clés
 * et des paramètres ; le texte français des notifications sert de repli.
 */

type Tone = 'info' | 'good' | 'warn' | 'bad';

/** Comptes rendus d'action qu'une relance identique ne duplique pas. */
const REPEATABLE = new Set([
  'offensive',
  'landing',
  'counter',
  'counterFront',
  'blockade',
  'strike',
  'noReinforcements',
]);

export function journal(
  state: EngineState,
  a: ArmySt,
  id: string,
  params: Record<string, LocParam> = {},
  tone: Tone = 'info',
): void {
  const text = loc(`engine.cmd.j.${id}`, params);
  // Une action relancée à l'identique (nouvel assaut sur la même province…) ne répète pas l'entrée :
  // la dernière est simplement remise à l'heure.
  const last = a.journal[a.journal.length - 1];
  if (
    last &&
    REPEATABLE.has(id) &&
    last.text.key === text.key &&
    JSON.stringify(last.text.params ?? {}) === JSON.stringify(text.params ?? {})
  ) {
    last.t = state.time;
    return;
  }
  a.journal.push({ t: state.time, text, tone });
  const max = cmdBal(state).journalMax;
  if (a.journal.length > max) a.journal.splice(0, a.journal.length - max);
}

/** Textes français de repli des notifications (le client affiche la clé traduite). */
const FR: Record<string, [string, string]> = {
  generalResigned: ['Démission', '{{general}} démissionne : sa solde n’est plus payée.'],
  generalUnpaid: [
    'Solde impayée',
    '{{general}} n’a pas été payé ({{days}}/{{max}} jours avant démission).',
  ],
  generalKilled: ['Général tué', '{{general}} a été tué lors d’une frappe sur le QG de {{army}}.'],
  generalWounded: ['Général blessé', '{{general}} est blessé : {{army}} attend son retour.'],
  missionSuccess: ['Mission accomplie', '{{army}} : mission accomplie.'],
  missionFailed: ['Mission échouée', '{{army}} : la mission a échoué.'],
  askWar: [
    'Autorisation demandée',
    '{{army}} : {{general}} demande l’autorisation d’entrer en guerre contre {{nation}}.',
  ],
  askStrike: [
    'Autorisation demandée',
    '{{army}} : {{general}} demande l’autorisation de frapper l’arrière de {{nation}}.',
  ],
  askReinforce: ['Renforts demandés', '{{army}} : {{general}} demande {{count}} piles en renfort.'],
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
    if ('province' in v) {
      const d = wi(state.world).provById.get(v.province);
      return d?.cityName ?? d?.name ?? v.province;
    }
    return '';
  });
}

export function notifyOwner(
  state: EngineState,
  n: NationId,
  id: string,
  params: Record<string, LocParam>,
  severity: 'info' | 'warn' | 'critical',
  at: LngLat | null = null,
): void {
  const [title, text] = FR[id] ?? ['Centre de commandement', ''];
  notify(
    state,
    {
      kind: 'generic',
      time: state.time,
      at,
      category: 'command',
      title,
      text: frText(state, text, params),
      severity,
      loc: noteLoc(`cmd_${id}`, params),
    },
    [n],
  );
}
