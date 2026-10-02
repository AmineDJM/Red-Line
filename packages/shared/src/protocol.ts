import { z } from 'zod';
import { encode, decode } from '@msgpack/msgpack';
import type { GameId, NationId, UserId } from './ids.js';
import type { ClockState, GameNotification, PlayerView, ViewDiff } from './view.js';
import { RESOURCES } from './catalog.js';
import { BUILDING_TYPES } from './map.js';
import { DEPARTMENTS, DETAINEE_ACTIONS } from './intel.js';
import { RESOLUTION_TYPES } from './diplomacy.js';
import { DOMESTIC_POLICIES, INTERIOR_FOCUS } from './domestic.js';
import { COMMAND_ORDERS } from './command.js';

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
  // Profondeur du renseignement (optionnelles côté sauvegardes : simples nouveaux ordres)
  'cryptanalysis',
  'intercept_comms',
  'geolocate_emitters',
  'cultivate_source',
  'vet_agents',
  'designate_targets',
  'dismantle_network',
  'deception_plan',
  'harden_sites',
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
  /** Couverture d'un agent infiltré (HUMINT). */
  cover: z.enum(['diplomatic', 'nonofficial']).optional(),
  /** Agent visé (culture d'une source, vérification). */
  agentId: id.optional(),
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
  /** Gestion intérieure : active ou suspend une politique. */
  z.object({
    kind: z.literal('domesticPolicy'),
    policy: z.enum(DOMESTIC_POLICIES),
    on: z.boolean(),
  }),
  // ——— Phase 3 : combat complet ———
  z.object({
    kind: z.literal('strike'),
    unitIds,
    target: strikeTarget,
    /** Munitions tirées par pile (missiles, munitions rôdeuses) ; absent = toute la pile. */
    count: z.number().int().min(1).max(10000).optional(),
  }),
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
  z.object({
    kind: z.literal('split'),
    unitId: id,
    /** Éléments détachés (pile mixte : répartis au prorata de chaque matériel). */
    count: z.number().int().positive().optional(),
    /** Éléments détachés par matériel (pile mixte). */
    parts: z
      .array(z.object({ systemId: id, count: z.number().int().positive() }))
      .min(1)
      .max(64)
      .optional(),
    /** 'half' : diviser en deux piles ; 'type' : une pile par matériel. */
    mode: z.enum(['half', 'type']).optional(),
  }),
  z.object({ kind: z.literal('merge'), unitIds }),
  /**
   * Escorte : les piles suivent une pile amie (`targetId`) et engagent ce qui la menace (chasseurs
   * escortant des bombardiers, frégates escortant un transport, défense antiaérienne mobile). Fin : ordre
   * d'arrêt ou de déplacement, cible détruite, carburant (aéronefs).
   */
  z.object({ kind: z.literal('escort'), unitIds, targetId: id }),
  /** Transport naval : des piles terrestres embarquent sur un navire de transport ami tout proche. */
  z.object({ kind: z.literal('embark'), unitIds, transportId: id }),
  /**
   * Débarquement des troupes d'un navire de transport : sur place (côte ou port proche), ou après la
   * traversée vers `to` (point côtier, débarquement amphibie). `unitIds` : une partie de la cargaison.
   */
  z.object({
    kind: z.literal('disembark'),
    transportId: id,
    unitIds: z.array(z.string().max(32)).min(1).max(200).optional(),
    to: lngLat.optional(),
  }),
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
  /** Renseignement intérieur : priorité du département. */
  z.object({ kind: z.literal('interiorFocus'), focus: z.enum(INTERIOR_FOCUS) }),
  /** Renseignement intérieur : protection d'un site sensible (province). */
  z.object({ kind: z.literal('protectSite'), provinceId: id, on: z.boolean() }),
  /**
   * Détenus : décision sur un agent étranger capturé (interpeller, interroger, expulser ou renvoyer,
   * emprisonner `days` jours, exécuter, retourner, libérer).
   */
  z.object({
    kind: z.literal('detainee'),
    agentId: id,
    action: z.enum(DETAINEE_ACTIONS),
    days: z.number().int().min(1).max(3650).optional(),
  }),
  /**
   * Échange ou libération d'agents : `give` (détenus que nous libérons), `get` (nos agents détenus
   * chez `nationId`), argent (> 0 : nous payons ; < 0 : nous demandons), accord de non-ingérence
   * (jours), allègement des sanctions que nous parrainons contre eux.
   */
  z.object({
    kind: z.literal('proposeSwap'),
    nationId: id,
    give: z.array(id).max(20),
    get: z.array(id).max(20),
    money: z.number().min(-1e12).max(1e12).optional(),
    accordDays: z.number().int().min(0).max(365).optional(),
    liftSanctions: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('answerSwap'), swapId: id, accept: z.boolean() }),
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
  // Centre de commandement (armées, missions, généraux).
  ...COMMAND_ORDERS,
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
  /**
   * Partie terminée : victoire militaire, abandon (aucun joueur connecté depuis 48 h solo / 24 h multi) ou
   * fin imposée par l'administration ('admin').
   */
  endReason?: 'victory' | 'abandoned' | 'admin';
  /** Partie multijoueur non classée : un joueur en mode illimité y joue (aucun point de classement). */
  unranked?: boolean;
  /**
   * Version de la carte épinglée par la partie (identifiants de province). Une partie créée avant un
   * changement de carte garde la sienne : le client charge alors `/api/map/*?map=<version>`.
   */
  mapVersion?: number;
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
  | 'insufficient_resources'
  | 'off_road' // destination trop loin du réseau de routes (unités terrestres)
  | 'resource_required'; // construction : la province n'a pas la ressource (ou pas de côte)

/**
 * Raisons détaillées d'un refus (ou d'une exécution partielle) d'ordre : le client les traduit, le
 * message en français reste le repli.
 */
export const ORDER_REASONS = [
  'target_invalid',
  'target_not_visible',
  'target_friendly',
  'air_defense_air_only',
  'cannot_hit_class',
  'out_of_weapon_range',
  'missile_out_of_range',
  'aircraft_out_of_radius',
  'aircraft_cooldown',
  'partial',
  'munition_use_strike',
  'ceasefire',
  // Escorte
  'escort_self',
  'escort_target_invalid',
  'escort_incapable',
  'escort_domain',
  // Transport naval
  'transport_not_ship',
  'transport_not_land',
  'transport_capacity',
  'transport_too_far',
  'transport_moving',
  'transport_no_shore',
  'transport_empty',
  'transport_embarked',
  'transport_busy',
  // Défense antiaérienne : catégorie non engagée, hors de l'enveloppe, magasin vide.
  'ad_cannot_engage',
  'ad_out_of_range',
  'ad_no_ammo',
] as const;
export type OrderReason = (typeof ORDER_REASONS)[number];

export type ServerMessage =
  | { t: 'welcome'; game: GameMeta; me: NationId; clock: ClockState; view: PlayerView }
  | { t: 'diff'; diff: ViewDiff }
  | { t: 'clock'; clock: ClockState }
  | { t: 'notify'; items: GameNotification[] }
  | {
      t: 'orderResult';
      id: number;
      ok: boolean;
      error?: OrderErrorCode;
      message?: string;
      /** Raison détaillée (clé de traduction `game.orders.reasons.<reason>`), si connue. */
      reason?: OrderReason;
      /** Valeurs de la raison (distances, noms…). */
      params?: Record<string, string | number>;
    }
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
