import { z } from 'zod';
import { encode, decode } from '@msgpack/msgpack';
import type { GameId, NationId } from './ids.js';
import type { ClockState, GameNotification, PlayerView, ViewDiff } from './view.js';

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const unitIds = z.array(z.string().max(32)).min(1).max(200);

/** Ordres de jeu : la seule chose qu'un client peut demander au moteur. */
export const OrderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), unitIds, to: lngLat }),
  z.object({ kind: z.literal('attack'), unitIds, targetId: z.string().max(32) }),
  z.object({ kind: z.literal('stop'), unitIds }),
  z.object({
    kind: z.literal('stance'),
    unitIds,
    stance: z.enum(['hold', 'defend', 'aggressive']),
  }),
  z.object({
    kind: z.literal('produce'),
    provinceId: z.string().max(64),
    systemId: z.string().max(64),
  }),
]);
export type Order = z.infer<typeof OrderSchema>;

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('order'), id: z.number().int(), order: OrderSchema }),
  /** Solo uniquement : vitesse ou pause. */
  z.object({
    t: z.literal('control'),
    speed: z.number().positive().optional(),
    paused: z.boolean().optional(),
  }),
  z.object({ t: z.literal('ping'), clientTime: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface GameMeta {
  id: GameId;
  name: string;
  mode: 'solo' | 'multi';
  scenarioId: string;
  status: 'lobby' | 'running' | 'paused' | 'ended';
  speeds: number[];
}

export type OrderErrorCode =
  | 'not_owner'
  | 'unknown_unit'
  | 'unreachable'
  | 'out_of_range'
  | 'insufficient_funds'
  | 'invalid_target'
  | 'not_allowed'
  | 'game_over';

export type ServerMessage =
  | { t: 'welcome'; game: GameMeta; me: NationId; clock: ClockState; view: PlayerView }
  | { t: 'diff'; diff: ViewDiff }
  | { t: 'clock'; clock: ClockState }
  | { t: 'notify'; items: GameNotification[] }
  | { t: 'orderResult'; id: number; ok: boolean; error?: OrderErrorCode; message?: string }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

export function encodeMessage(msg: ClientMessage | ServerMessage): Uint8Array {
  return encode(msg, { ignoreUndefined: true });
}

export function decodeMessage<T = unknown>(data: ArrayBuffer | Uint8Array): T {
  return decode(data instanceof Uint8Array ? data : new Uint8Array(data)) as T;
}
