import { z } from 'zod';
import { encode, decode } from '@msgpack/msgpack';
import type { GameId, NationId, UserId } from './ids.js';
import type { ClockState, GameNotification, PlayerView, ViewDiff } from './view.js';
import { RESOURCES } from './catalog.js';
import { BUILDING_TYPES } from './map.js';
import { DEPARTMENTS } from './intel.js';
import { RESOLUTION_TYPES } from './diplomacy.js';

/** Opérations de renseignement (voir IntelOpKind). */
export const INTEL_OPS = [
  'infiltrate_spy',
  'recruit_source',
  'turn_agent',
  'exfiltrate',
  'steal_research',
  'sabotage_factory',
  'fund_rebels',
  'listen_area',
  'intercept_army',
  'jam_area',
  'cyber_radar',
  'cyber_production',
  'cyber_orders',
  'disinformation',
  'leak_plans',
  'plant_fake_report',
  'deploy_decoys',
  'fake_radio_traffic',
  'counterintel_sweep',
  'recon_economic',
  'recon_military',
] as const;

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const unitIds = z.array(z.string().max(32)).min(1).max(200);

const id = z.string().max(64);
const text = (max: number) => z.string().max(max);
const buildingType = z.enum(BUILDING_TYPES);
const strikeTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('point'), at: lngLat }),
  z.object({ type: z.literal('unit'), unitId: id }),
  z.object({ type: z.literal('building'), provinceId: id, building: buildingType }),
]);
const tradeItem = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resource'),
    resource: z.enum(RESOURCES),
    qty: z.number().positive(),
  }),
  z.object({ type: z.literal('money'), amount: z.number().positive() }),
  z.object({ type: z.literal('units'), systemId: id, count: z.number().int().positive().max(100) }),
  z.object({ type: z.literal('licence'), systemId: id }),
]);
const opTarget = z.object({
  nationId: id.optional(),
  provinceId: id.optional(),
  unitId: id.optional(),
  at: lngLat.optional(),
  radiusKm: z.number().positive().max(2000).optional(),
});

/** Ordres « simples » (utilisables aussi comme étapes d'une opération combinée). */
const BASE_ORDERS = [
  // ——— Phase 1 ———
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
    count: z.number().int().min(1).max(20).optional(),
  }),
  // ——— Phase 2 : économie, industrie, logistique ———
  z.object({ kind: z.literal('research'), nodeId: id }),
  z.object({ kind: z.literal('cancelResearch'), nodeId: id }),
  z.object({ kind: z.literal('buyLicence'), systemId: id }),
  z.object({ kind: z.literal('cancelProduction'), productionId: id }),
  z.object({
    kind: z.literal('build'),
    provinceId: id,
    building: z.union([buildingType, z.enum(['fortification', 'forward_base'])]),
  }),
  z.object({ kind: z.literal('repair'), provinceId: id, building: buildingType }),
  z.object({
    kind: z.literal('sellOffer'),
    item: tradeItem,
    price: z.number().min(0),
    to: id.nullable().default(null),
  }),
  z.object({ kind: z.literal('acceptOffer'), offerId: id }),
  z.object({ kind: z.literal('cancelOffer'), offerId: id }),
  z.object({
    kind: z.literal('blackMarket'),
    systemId: id,
    count: z.number().int().min(1).max(10).default(1),
  }),
  z.object({
    kind: z.literal('transfer'),
    to: id,
    item: tradeItem,
    covert: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('mobilize'), on: z.boolean() }),
  // ——— Phase 3 : combat complet ———
  z.object({ kind: z.literal('strike'), unitIds, target: strikeTarget }),
  z.object({
    kind: z.literal('patrol'),
    unitIds,
    at: lngLat,
    radiusKm: z.number().positive().max(1000),
  }),
  z.object({ kind: z.literal('rtb'), unitIds }),
  z.object({ kind: z.literal('rebase'), unitIds, provinceId: id }),
  z.object({ kind: z.literal('jam'), unitIds, on: z.boolean() }),
  z.object({
    kind: z.literal('blockade'),
    unitIds,
    target: z.union([z.object({ provinceId: id }), z.object({ straitId: id })]),
  }),
  z.object({
    kind: z.literal('specialOp'),
    unitIds,
    provinceId: id,
    mission: z.enum(['raid', 'sabotage', 'rescue']),
    building: buildingType.optional(),
  }),
  z.object({ kind: z.literal('split'), unitId: id, count: z.number().int().positive() }),
  z.object({ kind: z.literal('merge'), unitIds }),
  z.object({ kind: z.literal('appointGeneral'), generalId: id, unitIds: z.array(id).max(200) }),
  z.object({
    kind: z.literal('delegate'),
    generalId: id,
    directive: z.enum(['defend', 'advance', 'harass']).nullable(),
    area: lngLat.nullable(),
  }),
  z.object({ kind: z.literal('nuclearAuth'), on: z.boolean() }),
  // ——— Phase 3 : renseignement ———
  z.object({ kind: z.literal('intelOp'), op: z.enum(INTEL_OPS), target: opTarget }),
  z.object({ kind: z.literal('cancelIntelOp'), opId: id }),
  z.object({
    kind: z.literal('intelBudget'),
    dept: z.enum(DEPARTMENTS),
    budgetPerDay: z.number().min(0),
  }),
  z.object({ kind: z.literal('shareReport'), reportId: id, to: id }),
  z.object({ kind: z.literal('turnAgent'), agentId: id }),
  // ——— Phase 4 : diplomatie ———
  z.object({ kind: z.literal('declareWar'), nationId: id }),
  z.object({ kind: z.literal('proposePeace'), nationId: id, type: z.enum(['peace', 'ceasefire']) }),
  z.object({ kind: z.literal('answerPeace'), nationId: id, accept: z.boolean() }),
  z.object({
    kind: z.literal('createAlliance'),
    name: text(40).min(2),
    flag: text(16),
    charter: z.object({
      mutualDefense: z.boolean(),
      intelSharing: z.boolean(),
      passage: z.boolean(),
    }),
  }),
  z.object({ kind: z.literal('inviteToAlliance'), nationId: id }),
  z.object({ kind: z.literal('answerInvite'), allianceId: id, accept: z.boolean() }),
  z.object({ kind: z.literal('leaveAlliance') }),
  z.object({ kind: z.literal('allianceVote'), voteId: id, yes: z.boolean() }),
  z.object({
    kind: z.literal('allianceProposeVote'),
    vote: z.enum(['replace_leader', 'skip_mutual_defense', 'expel']),
    subject: id,
  }),
  z.object({ kind: z.literal('allianceTreasury'), amount: z.number() }),
  z.object({
    kind: z.literal('proposeResolution'),
    type: z.enum(RESOLUTION_TYPES),
    target: z.object({
      nationId: id.optional(),
      provinceIds: z.array(id).max(50).optional(),
      at: lngLat.optional(),
      radiusKm: z.number().positive().max(2000).optional(),
    }),
    text: text(500),
  }),
  z.object({
    kind: z.literal('voteResolution'),
    resolutionId: id,
    vote: z.enum(['yes', 'no', 'abstain']),
  }),
  z.object({ kind: z.literal('courtNeutral'), nationId: id, aid: z.number().positive() }),
  z.object({ kind: z.literal('fundRebels'), provinceId: id, amount: z.number().positive() }),
  z.object({
    kind: z.literal('hireMercenaries'),
    provinceId: id,
    count: z.number().int().min(1).max(10),
  }),
] as const;

const OperationStepSchema = z.object({
  offsetMin: z
    .number()
    .min(-7 * 24 * 60)
    .max(7 * 24 * 60),
  label: text(80).optional(),
  order: z.discriminatedUnion('kind', [...BASE_ORDERS]),
});

/** Ordres de jeu : la seule chose qu'un client peut demander au moteur. */
export const OrderSchema = z.discriminatedUnion('kind', [
  ...BASE_ORDERS,
  z.object({
    kind: z.literal('operation'),
    name: text(60).min(1),
    hHour: z.number().min(0),
    steps: z.array(OperationStepSchema).min(1).max(30),
  }),
  z.object({ kind: z.literal('cancelOperation'), operationId: id }),
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
  /** Messagerie (phase 5) : alliance, message privé, ou salon de la partie. */
  z.object({
    t: z.literal('chat'),
    channel: z.enum(['game', 'alliance', 'private']),
    to: z.string().max(64).optional(),
    text: z.string().min(1).max(1000),
  }),
  /** Accuse lecture des messages d'un canal. */
  z.object({ t: z.literal('chatRead'), channel: z.string().max(80), upTo: z.number().int() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface GameMeta {
  id: GameId;
  name: string;
  mode: 'solo' | 'multi';
  scenarioId: string;
  status: 'lobby' | 'running' | 'paused' | 'ended';
  speeds: number[];
  // ——— Phases 5-6 (optionnels) ———
  /** Joueurs humains attendus / inscrits (multijoueur). */
  maxPlayers?: number;
  playerCount?: number;
  /** Achats en jeu : autorisés, limités ou désactivés (serveurs compétitifs). */
  shopPolicy?: ShopPolicy;
  /** Spectateur (lecture seule). */
  spectator?: boolean;
  victory?: { provinceShare: number; allEnemyCapitals: boolean; capitals?: number };
  createdAt?: string;
  startedAt?: string | null;
}

export interface ShopPolicy {
  mode: 'open' | 'limited' | 'disabled';
  /** Plafond de monnaie premium dépensable par joueur et par partie (mode 'limited'). */
  capPerPlayer?: number;
}

export interface ChatMessage {
  id: number;
  gameId: GameId;
  channel: string; // "game", "alliance:<id>", "private:<a>|<b>"
  from: { userId: UserId; nationId: NationId | null; name: string };
  text: string;
  sentAt: string;
  /** Masqué par la modération. */
  hidden?: boolean;
}

export type OrderErrorCode =
  | 'not_owner'
  | 'unknown_unit'
  | 'unreachable'
  | 'out_of_range'
  | 'insufficient_funds'
  | 'invalid_target'
  | 'not_allowed'
  | 'game_over'
  | 'unknown'
  | 'locked' // bloqué par le niveau d'alerte, une résolution, un embargo…
  | 'research_required'
  | 'capacity'
  | 'cooldown'
  | 'insufficient_resources';

export type ServerMessage =
  | { t: 'welcome'; game: GameMeta; me: NationId; clock: ClockState; view: PlayerView }
  | { t: 'diff'; diff: ViewDiff }
  | { t: 'clock'; clock: ClockState }
  | { t: 'notify'; items: GameNotification[] }
  | { t: 'orderResult'; id: number; ok: boolean; error?: OrderErrorCode; message?: string }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chatHistory'; messages: ChatMessage[] }
  /** Avis de l'administration (modification d'équilibrage, maintenance…). */
  | { t: 'notice'; level: 'info' | 'warn'; text: string }
  /** Partie déplacée vers une autre instance (bail perdu) : se reconnecter. */
  | { t: 'moved' }
  | { t: 'error'; code: string; message: string };

export function encodeMessage(msg: ClientMessage | ServerMessage): Uint8Array {
  return encode(msg, { ignoreUndefined: true });
}

export function decodeMessage<T = unknown>(data: ArrayBuffer | Uint8Array): T {
  return decode(data instanceof Uint8Array ? data : new Uint8Array(data)) as T;
}
