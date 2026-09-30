// Point d'entrée du moteur. Les implémentations sont exportées sous les noms exacts du contrat
// (types dans api.ts) : buildWorld, createGame, applyOrder, advanceTo, nextEventTime,
// viewFor, diffViews, notificationsFor, serializeState, deserializeState, stateHash.
export * from './api.js';

import type {
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
import { applyOrderImpl } from './orders/orders.js';
import { advanceImpl, nextEventTimeImpl } from './sim/advance.js';
import { viewForImpl } from './view/view.js';
import { diffViewsImpl } from './view/diff.js';
import { notificationsForImpl } from './view/notify.js';
import { deserializeImpl, serializeImpl, stateHashImpl } from './state/serialize.js';

const S = (s: unknown): EngineState => s as EngineState;

export const buildWorld: BuildWorld = (map, catalog, balance) => buildWorldImpl(map, catalog, balance);
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

// Utilitaires géométriques exacts (réutilisables par le client et les tests).
export { legZoneIntervals } from './geo/sphere.js';
export { CAPTURE_RADIUS_KM } from './state/world.js';
export type { EngineState } from './state/types.js';
