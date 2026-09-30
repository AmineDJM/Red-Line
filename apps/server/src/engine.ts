import type {
  AdvanceTo,
  ApplyOrder,
  ApplySystem,
  BuildWorld,
  CreateGame,
  DeserializeState,
  DiffViews,
  GameState,
  NextEventTime,
  NotificationsFor,
  OwnersFrame,
  PublicView,
  SerializeState,
  StateHash,
  Stats,
  ViewFor,
} from '@redline/engine';
import type { BattleReport, NationId } from '@redline/shared';
import * as engineModule from '@redline/engine';

/** Rapport de bataille détaillé vu par une nation (null si inconnu ou non autorisé). */
export type BattleReportFor = (
  state: GameState,
  nationId: NationId,
  reportId: string,
) => BattleReport | null;

/**
 * Le moteur tel que le serveur le consomme : un objet injecté (le vrai `@redline/engine` en production,
 * un faux moteur dans les tests). Les signatures sont celles du contrat figé packages/engine/src/api.ts.
 */
export interface Engine {
  buildWorld: BuildWorld;
  createGame: CreateGame;
  applyOrder: ApplyOrder;
  advanceTo: AdvanceTo;
  nextEventTime: NextEventTime;
  viewFor: ViewFor;
  diffViews: DiffViews;
  notificationsFor: NotificationsFor;
  serializeState: SerializeState;
  deserializeState: DeserializeState;
  stateHash: StateHash;
  // ——— Phases 2+ (facultatifs : fonctionnalités dégradées proprement s'ils manquent) ———
  applySystem?: ApplySystem;
  publicView?: PublicView;
  ownersFrame?: OwnersFrame;
  stats?: Stats;
  battleReportFor?: BattleReportFor;
  /**
   * Facultatif (hors contrat) : statistiques pour le back-office. À défaut, le serveur essaie de lire
   * `state.units` et `state.queue` par introspection.
   */
  stateStats?: (state: GameState) => { unitCount: number; queueSize: number };
}

export const ENGINE_FUNCTIONS = [
  'buildWorld',
  'createGame',
  'applyOrder',
  'advanceTo',
  'nextEventTime',
  'viewFor',
  'diffViews',
  'notificationsFor',
  'serializeState',
  'deserializeState',
  'stateHash',
] as const satisfies readonly (keyof Engine)[];

export const OPTIONAL_ENGINE_FUNCTIONS = [
  'applySystem',
  'publicView',
  'ownersFrame',
  'stats',
  'battleReportFor',
  'stateStats',
] as const satisfies readonly (keyof Engine)[];

/** Construit l'objet Engine à partir d'un module ; renvoie la liste des fonctions manquantes sinon. */
export function engineFromModule(mod: Record<string, unknown>): Engine | { missing: string[] } {
  const missing = ENGINE_FUNCTIONS.filter((k) => typeof mod[k] !== 'function');
  if (missing.length > 0) return { missing };
  const e = {} as Record<string, unknown>;
  for (const k of ENGINE_FUNCTIONS) e[k] = mod[k];
  for (const k of OPTIONAL_ENGINE_FUNCTIONS) if (typeof mod[k] === 'function') e[k] = mod[k];
  return e as unknown as Engine;
}

/** Le vrai moteur (`@redline/engine`), ou null s'il n'exporte pas encore toutes les fonctions du contrat. */
export function loadRealEngine(): { engine: Engine | null; missing: string[] } {
  const r = engineFromModule(engineModule as unknown as Record<string, unknown>);
  if ('missing' in r) return { engine: null, missing: r.missing };
  return { engine: r, missing: [] };
}

/** Introspection prudente pour le back-office (queueSize, unitCount). */
export function stateStats(
  engine: Engine,
  state: GameState,
): { unitCount: number; queueSize: number } {
  if (engine.stateStats) {
    try {
      return engine.stateStats(state);
    } catch {
      /* repli ci-dessous */
    }
  }
  const s = state as unknown as { units?: unknown; queue?: unknown };
  let unitCount = 0;
  if (s.units instanceof Map) unitCount = s.units.size;
  else if (s.units && typeof s.units === 'object') unitCount = Object.keys(s.units).length;
  let queueSize = 0;
  const q = s.queue as { size?: unknown; length?: unknown; heap?: unknown } | undefined;
  if (Array.isArray(q)) queueSize = q.length;
  else if (q && typeof q === 'object') {
    if (typeof q.size === 'number') queueSize = q.size;
    else if (typeof q.size === 'function')
      queueSize = Number((q.size as () => number).call(q)) || 0;
    else if (typeof q.length === 'number') queueSize = q.length;
    else if (Array.isArray(q.heap)) queueSize = q.heap.length;
  }
  return { unitCount, queueSize };
}
