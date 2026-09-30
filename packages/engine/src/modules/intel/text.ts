import {
  DAY,
  HOUR,
  MINUTE,
  bearing,
  distanceKm,
  type Category,
  type Department,
  type LngLat,
  type NationId,
  type ProvinceId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { wi } from '../../state/world.js';
import { pick, roll } from './levels.js';

/**
 * Textes des rapports (français, style note de service). Générés au moment de la publication avec le
 * PRNG de l'état : déterministes, stockés tels quels (la vue ne tire jamais au sort).
 */

export const DEPT_LABEL: Record<Department, string> = {
  interior: 'Sécurité intérieure',
  exterior: 'Renseignement extérieur',
  military: 'Renseignement militaire',
};

export const DEPT_CODE: Record<Department, string> = {
  interior: 'SI',
  exterior: 'RE',
  military: 'RM',
};

export const CATEGORY_LABEL: Record<Category, string> = {
  fighter: 'avions de combat',
  bomber: 'bombardiers',
  air_support: 'appareils de soutien',
  helicopter: 'hélicoptères',
  drone: 'drones',
  tank: 'chars',
  ifv: 'véhicules blindés',
  artillery: "pièces d'artillerie",
  air_defense: 'systèmes sol-air',
  strike_missile: 'lanceurs de missiles',
  nuclear: 'vecteurs nucléaires',
  surface_ship: 'bâtiments de surface',
  submarine: 'sous-marins',
  infantry: "bataillons d'infanterie",
  space: 'satellites',
  logistics: 'convois logistiques',
};

const CODENAMES = [
  'ALBATROS',
  'BASILIC',
  'CORMORAN',
  'DAUPHIN',
  'ÉPERVIER',
  'FAUCON',
  'GYPAÈTE',
  'HÉRON',
  'IBIS',
  'JAGUAR',
  'LYNX',
  'MARTRE',
  'NARVAL',
  'ORQUE',
  'PÉLICAN',
  'RENARD',
  'SITTELLE',
  'TOUCAN',
  'VAUTOUR',
  'ZIBELINE',
  'MISTRAL',
  'SIROCCO',
  'TRAMONTANE',
  'BORÉE',
];

export function codename(state: EngineState): string {
  return `${pick(state, CODENAMES)}-${10 + Math.floor(roll(state) * 90)}`;
}

export function nationName(state: EngineState, n: NationId): string {
  return wi(state.world).nationById.get(n)?.name ?? n.toUpperCase();
}

export function provinceName(state: EngineState, pid: ProvinceId): string {
  return wi(state.world).provById.get(pid)?.name ?? pid;
}

/** Province dont la ville est la plus proche d'un point (parcours trié : déterministe). */
export function nearestProvince(
  state: EngineState,
  at: LngLat,
): { pid: ProvinceId; name: string; d: number } | null {
  const w = wi(state.world);
  let best: { pid: ProvinceId; name: string; d: number } | null = null;
  for (const pid of w.provIds) {
    if (!state.provinces[pid]) continue;
    const def = w.provById.get(pid)!;
    const d = distanceKm(def.cityPoint, at);
    if (!best || d < best.d) best = { pid, name: def.name, d };
  }
  return best;
}

export function sectorOf(state: EngineState, at: LngLat): string {
  const p = nearestProvince(state, at);
  if (!p) return 'secteur non identifié';
  return p.d < 60 ? `secteur ${p.name}` : `à ${Math.round(p.d)} km de ${p.name}`;
}

export function fmtTime(t: number): string {
  const day = Math.floor(t / DAY) + 1;
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / MINUTE);
  return `J${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const CARDINALS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

export function cardinal(from: LngLat, to: LngLat): string {
  const b = (bearing(from, to) + 360 + 22.5) % 360;
  return CARDINALS[Math.floor(b / 45)]!;
}

/**
 * Estimation bruitée d'un effectif : erreur relative ∝ (1 − qualité), arrondie comme le ferait un
 * analyste (≈ 12, ≈ 40, ≈ 150).
 */
export function approx(state: EngineState, n: number, q: number): string {
  if (n <= 0) return 'aucun';
  const e = (1 - q) * 0.6;
  const v = Math.max(1, n * (1 + (roll(state) * 2 - 1) * e));
  if (q >= 0.85 && n < 20) return String(n);
  const mag = v < 10 ? 1 : v < 50 ? 5 : v < 200 ? 10 : v < 1000 ? 50 : 100;
  return `≈ ${Math.max(1, Math.round(v / mag) * mag)}`;
}

/** Première ligne d'un rapport : référence, heure, émetteur. */
export function header(
  ref: string,
  t: number,
  dept: Department,
  rel: string,
  cred: number,
): string {
  return `Réf. ${DEPT_CODE[dept]}-${ref} · ${fmtTime(t)} · ${DEPT_LABEL[dept]} · Cotation ${rel}${cred}`;
}

export const OPENINGS: Record<Department, string[]> = {
  interior: [
    'Situation sur le territoire national :',
    'Point de situation de la sécurité intérieure :',
    'Bilan des dernières 24 heures sur le territoire :',
  ],
  exterior: [
    'Synthèse des sources extérieures :',
    'Point des postes à l’étranger :',
    'Remontées des réseaux extérieurs :',
  ],
  military: [
    'Appréciation de situation militaire :',
    'Synthèse SIGINT et imagerie :',
    'Ordre de bataille et activité adverse :',
  ],
};

export const NOTHING: string[] = [
  'Rien de significatif à signaler.',
  'Aucune activité notable relevée.',
  'Situation calme, pas d’indice d’activité hostile.',
];

export const HEDGES_LOW: string[] = [
  'Information non recoupée.',
  'À confirmer par une seconde source.',
  'Source d’accès indirect, prudence.',
];

export const HEDGES_HIGH: string[] = [
  'Information recoupée par plusieurs capteurs.',
  'Confirmé par imagerie.',
  'Source d’accès direct, fiable.',
];

export function hedge(state: EngineState, q: number): string {
  return q >= 0.65 ? pick(state, HEDGES_HIGH) : pick(state, HEDGES_LOW);
}
