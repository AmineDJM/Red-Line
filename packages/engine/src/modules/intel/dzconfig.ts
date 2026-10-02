import type { DetaineeKind, NationId, Regime } from '@redline/shared';
import type { EngineState } from '../../state/types.js';

/**
 * Réglages des détenus (agents capturés), des décisions et des négociations : valeurs par défaut du
 * moteur, identiques à data/balance/default.json (section `intel.detainees`), surchargées champ par champ.
 */

/** Conséquences de base d'une décision (avant type d'agent, régime, guerre). */
export interface ActionEffects {
  /** Relations bilatérales avec le pays d'origine (−100..100). */
  relations: number;
  /** Réputation internationale du pays qui décide (0..100). */
  reputation: number;
  /** Stabilité (opinion intérieure) du pays qui décide. */
  stability: number;
  /** Risque de représailles du pays d'origine (0..1, avant relations et régime). */
  retaliation: number;
  /** Affaiblissement du service adverse contre nous (réussite × (1 − x)) et sa durée. */
  serviceHit: number;
  serviceDays: number;
}

/** Règles d'un régime politique. */
export interface RegimeRule {
  /** Exécution : jamais, seulement en guerre, toujours possible. */
  execute: 'never' | 'war' | 'always';
  /** Exécution : réputation, stabilité, relations avec les démocraties, chance d'un vote au Conseil. */
  reputation: number;
  stability: number;
  worldRelations: number;
  council: number;
  /** Propension aux représailles quand ce régime est le pays d'origine (×). */
  retaliation: number;
  /** IA : chance d'exécuter un détenu quand c'est possible et que la relation est hostile. */
  aiExecute: number;
}

export type ActionKey =
  | 'arrest'
  | 'interrogate'
  | 'expel'
  | 'return'
  | 'jail'
  | 'execute'
  | 'turn'
  | 'release'
  | 'exchange';

export interface DetaineeConfig {
  /** Délai de décision (jours de jeu) ; au-delà : détention provisoire. */
  decisionDays: number;
  /** Interrogatoire : durée (heures), chance d'obtenir des aveux exploitables, part d'intoxication. */
  interrogateHours: number;
  interrogateYield: Record<DetaineeKind, number>;
  interrogateFalse: Record<DetaineeKind, number>;
  /** Agents du même réseau identifiés au plus par un interrogatoire réussi. */
  revealAgents: number;
  /** Durées de peine proposées (jours de jeu), la plus longue sert aux représailles. */
  sentenceDays: number[];
  /** Retournement : chance de base par type (× (0,5 + qualité de la sécurité intérieure)). */
  turnChance: Record<DetaineeKind, number>;
  /** Poids du type dans les relations (une source locale compte moins qu'un officier). */
  kindRelations: Record<DetaineeKind, number>;
  /** Valeur d'échange par type, × (1 + accessValue × niveau d'accès). */
  value: Record<DetaineeKind, number>;
  accessValue: number;
  actions: Record<ActionKey, ActionEffects>;
  /** Peine : relations supplémentaires par année de prison prononcée. */
  jailPerYear: number;
  /** Violation de l'immunité diplomatique (prison, exécution, interrogatoire d'un diplomate). */
  immunityReputation: number;
  immunityRelations: number;
  /** Exécution en temps de paix : relations et réputation × ce facteur. */
  peaceFactor: number;
  regimes: Record<Regime, RegimeRule>;
  /** Régimes des nations (absentes : régime hybride). */
  nations: { democracy: NationId[]; authoritarian: NationId[] };
  /** Pression diplomatique quotidienne tant qu'un agent est détenu, plancher des relations dû à la pression. */
  pressurePerDay: number;
  pressureFloor: number;
  /** Retour quotidien des relations vers 0. */
  relationsDecayPerDay: number;
  // ——— Négociations ———
  /** Validité d'une proposition (jours), délai de réponse d'une IA (heures). */
  swapDays: number;
  aiAnswerHours: number;
  /** Dollars par point de valeur d'agent. */
  usdPerValue: number;
  /** Valeur d'un jour d'accord de non-ingérence, d'un allègement de sanctions. */
  accordValuePerDay: number;
  sanctionsValue: number;
  /** Valeur d'un détenu cédé par rapport à celle d'un agent récupéré (on préfère récupérer les siens). */
  holdFactor: number;
  /** Exigence supplémentaire d'une IA : relations hostiles (× −relations/100), guerre. */
  hostilePremium: number;
  warPremium: number;
  /** Contre-proposition si le déficit ne dépasse pas ce multiple de la valeur en jeu ; surenchère. */
  counterMax: number;
  raise: number;
  /** IA : une initiative d'échange par paire au plus tous les N jours ; relations minimales. */
  aiSwapEveryDays: number;
  aiSwapMinRelations: number;
}

const FX = (
  relations: number,
  reputation: number,
  stability: number,
  retaliation: number,
  serviceHit: number,
  serviceDays: number,
): ActionEffects => ({ relations, reputation, stability, retaliation, serviceHit, serviceDays });

export const DZ_DEFAULTS: DetaineeConfig = {
  decisionDays: 3,
  interrogateHours: 48,
  interrogateYield: { diplomat: 0.25, illegal: 0.45, source: 0.6, double: 0.85 },
  interrogateFalse: { diplomat: 0.1, illegal: 0.25, source: 0.15, double: 0.05 },
  revealAgents: 2,
  sentenceDays: [30, 90, 365],
  turnChance: { diplomat: 0.1, illegal: 0.25, source: 0.5, double: 0 },
  kindRelations: { diplomat: 1, illegal: 1, source: 0.6, double: 0.8 },
  value: { diplomat: 3, illegal: 4, source: 1.5, double: 1 },
  accessValue: 0.5,
  actions: {
    arrest: FX(-3, 0, 0, 0.1, 0.05, 15),
    interrogate: FX(-2, 0, 0, 0.05, 0, 0),
    expel: FX(-6, 0, 0, 0.5, 0.15, 30),
    return: FX(-4, 0, 0, 0.2, 0.1, 20),
    jail: FX(-12, -0.5, 1, 0.35, 0.2, 60),
    execute: FX(-40, -6, 0, 0.8, 0.35, 90),
    // Retournement réussi : vu du propriétaire, c'est une libération (mêmes effets visibles).
    turn: FX(6, 1, -1, 0, 0, 0),
    release: FX(6, 1, -1, 0, 0, 0),
    exchange: FX(8, 1, 1, 0, 0, 0),
  },
  jailPerYear: -10,
  immunityReputation: -5,
  immunityRelations: -10,
  peaceFactor: 1.5,
  regimes: {
    democracy: {
      execute: 'war',
      reputation: -12,
      stability: -6,
      worldRelations: -10,
      council: 0.6,
      retaliation: 0.8,
      aiExecute: 0,
    },
    hybrid: {
      execute: 'always',
      reputation: -6,
      stability: -2,
      worldRelations: -4,
      council: 0.2,
      retaliation: 1,
      aiExecute: 0.15,
    },
    authoritarian: {
      execute: 'always',
      reputation: -3,
      stability: 1,
      worldRelations: -2,
      council: 0.1,
      retaliation: 1.2,
      aiExecute: 0.35,
    },
  },
  nations: { democracy: [], authoritarian: [] },
  pressurePerDay: 1,
  pressureFloor: -60,
  relationsDecayPerDay: 0.5,
  swapDays: 5,
  aiAnswerHours: 6,
  usdPerValue: 25_000_000,
  accordValuePerDay: 0.05,
  holdFactor: 0.85,
  sanctionsValue: 4,
  hostilePremium: 0.5,
  warPremium: 0.25,
  counterMax: 1.5,
  raise: 0.2,
  aiSwapEveryDays: 5,
  aiSwapMinRelations: -70,
};

const cache = new WeakMap<object, DetaineeConfig>();

function merge<T>(d: T, v: unknown): T {
  if (v === undefined || v === null) return d;
  if (Array.isArray(d)) return (Array.isArray(v) ? [...v] : d) as T;
  if (d && typeof d === 'object' && typeof v === 'object') {
    const out = { ...(d as Record<string, unknown>) };
    for (const k of Object.keys(v as object)) {
      const dv = (d as Record<string, unknown>)[k];
      out[k] =
        dv === undefined
          ? (v as Record<string, unknown>)[k]
          : merge(dv, (v as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return v as T;
}

export function dzcfg(state: EngineState): DetaineeConfig {
  const bal = state.world.balance;
  let c = cache.get(bal);
  if (!c) {
    const src = (bal.intel as { detainees?: unknown } | undefined)?.detainees;
    c = merge(DZ_DEFAULTS, src);
    cache.set(bal, c);
  }
  return c;
}

const regimeCache = new WeakMap<object, Map<NationId, Regime>>();

/** Régime politique d'une nation (données ; hybride par défaut). */
export function regimeOf(state: EngineState, n: NationId): Regime {
  const c = dzcfg(state);
  let m = regimeCache.get(c);
  if (!m) {
    m = new Map();
    for (const x of c.nations.democracy) m.set(x, 'democracy');
    for (const x of c.nations.authoritarian) m.set(x, 'authoritarian');
    regimeCache.set(c, m);
  }
  return m.get(n) ?? 'hybrid';
}
