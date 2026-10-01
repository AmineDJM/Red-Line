// Point d'entrée du moteur. Les implémentations sont exportées sous les noms exacts du contrat
// (types dans api.ts) : buildWorld, createGame, applyOrder, advanceTo, nextEventTime,
// viewFor, diffViews, notificationsFor, serializeState, deserializeState, stateHash.
export * from './api.js';

import { battleReportForImpl } from './modules/mil/battles.js';
import type {
  ApplySystem,
  IsDormant,
  UnlimitedNations,
  BattleReportFor,
  GameStats,
  OwnersFrame,
  PublicView,
  Stats,
  AdvanceTo,
  ApplyOrder,
  BuildWorld,
  CreateGame,
  DeserializeState,
  DiffViews,
  NextEventTime,
  NotificationsFor,
  SerializeState,
  StateHash,
  ViewFor,
} from './api.js';
import type { EngineState } from './state/types.js';
import { buildWorld as buildWorldImpl } from './state/world.js';
import { createGameImpl } from './state/create.js';
import { applyOrderImpl, applySystemImpl } from './orders/orders.js';
import { advanceImpl, nextEventTimeImpl } from './sim/advance.js';
import { ownersFrameImpl, publicViewImpl, viewForImpl } from './view/view.js';
import { moduleStats } from './modules/registry.js';
import { board } from './modules/kit.js';
import { diffViewsImpl } from './view/diff.js';
import { notificationsForImpl } from './view/notify.js';
import { deserializeImpl, serializeImpl, stateHashImpl } from './state/serialize.js';

const S = (s: unknown): EngineState => s as EngineState;

export const buildWorld: BuildWorld = (map, catalog, balance, extras) =>
  buildWorldImpl(map, catalog, balance, extras);
export const createGame: CreateGame = (world, setup) => createGameImpl(world, setup);
export const applyOrder: ApplyOrder = (state, nationId, order) =>
  applyOrderImpl(S(state), nationId, order);
export const advanceTo: AdvanceTo = (state, t) => advanceImpl(S(state), t);
export const nextEventTime: NextEventTime = (state) => nextEventTimeImpl(S(state));
export const viewFor: ViewFor = (state, nationId) => viewForImpl(S(state), nationId);
export const diffViews: DiffViews = (prev, next) => diffViewsImpl(prev, next);
export const notificationsFor: NotificationsFor = (state, nationId, items) =>
  notificationsForImpl(S(state), nationId, items);
export const serializeState: SerializeState = (state) => serializeImpl(S(state));
export const deserializeState: DeserializeState = (world, bytes) => deserializeImpl(world, bytes);
export const stateHash: StateHash = (state) => stateHashImpl(S(state));

// ——— Phases 2+ ———
export const applySystem: ApplySystem = (state, cmd) => applySystemImpl(S(state), cmd);
export const isDormant: IsDormant = (state) => !!board(S(state)).dormancy;
export const unlimitedNations: UnlimitedNations = (state) => Object.keys(S(state).unl ?? {}).sort();
export const publicView: PublicView = (state) => publicViewImpl(S(state));
export const ownersFrame: OwnersFrame = (state) => ownersFrameImpl(S(state));
export const stats: Stats = (state) => {
  const st = S(state);
  const out: GameStats = { nations: {}, alertLevel: 5 };
  for (const n of st.nationIds) {
    const ns = st.nations[n]!;
    out.nations[n] = {
      provincesStart: 0,
      provincesEnd: ns.provinceCount,
      conquered: 0,
      kills: 0,
      losses: 0,
      spentUsd: 0,
      bestUnits: [],
    };
  }
  moduleStats(st, out);
  return out;
};
export const battleReportFor: BattleReportFor = (state, nationId, reportId) =>
  battleReportForImpl(S(state), nationId, reportId);
export type { EngineModule, ModEvent, ModuleId } from './modules/types.js';

// Utilitaires géométriques exacts (réutilisables par le client et les tests).
export { legZoneIntervals } from './geo/sphere.js';
export { CAPTURE_RADIUS_KM } from './state/world.js';
export type { EngineState } from './state/types.js';
