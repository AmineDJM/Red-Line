import {
  MilitaryBalanceSchema,
  type BuildingType,
  type GameTime,
  type GeneralTrait,
  type LngLat,
  type MilitaryBalance,
  type MissionKind,
  type NationId,
  type ProvinceId,
  type StrikeTarget,
  type SystemId,
  type TargetClass,
  type UnitId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';

/**
 * État sérialisable du module militaire (state.mods.mil). Uniquement des données JSON : nombres,
 * chaînes, booléens, null, tableaux et objets. Toute itération qui influence le résultat se fait
 * dans l'ordre trié des clés.
 */

/** Mission d'une unité (aéronef, navire, satellite). Présente pour tout aéronef à carburant. */
export interface MissionSt {
  /** Aéronef à carburant (fiche `air`). */
  fa: boolean;
  /** Base d'attache : province ('p') ou unité porteuse ('c'), ou aucune. */
  bk: 'p' | 'c' | null;
  base: string | null;
  /** En vol. */
  up: boolean;
  /** Autonomie (heures) à l'instant `ft`. */
  fuel: number;
  ft: GameTime;
  /** Version : invalide les événements de carburant et de veille déjà programmés. */
  v: number;
  /** Retour automatique prévu (null si aucun). */
  bingo: GameTime | null;
  /** Disponible à partir de (remise en œuvre). */
  ready: GameTime;
  mis: MissionKind;
  ph: 'out' | 'station' | 'back' | 'tanker' | null;
  /** Centre et rayon de patrouille, ou destination d'un simple déplacement. */
  at: LngLat | null;
  r: number;
  tg: StrikeTarget | null;
  retry: number;
  /** Ravitailleur : carburant transférable restant (heures). */
  give: number;
  /** Porte-avions sur lequel l'aéronef est embarqué. */
  emb: UnitId | null;
  /** Ravitailleur visé pendant une jonction. */
  tk: UnitId | null;
  /** Version de la veille (patrouille) : invalide les événements de veille programmés. */
  sv: number;
}

/** Salve de missiles en vol (unité de rôle 'missile'). */
export interface MissileSt {
  by: NationId;
  /** Lanceur (peut avoir disparu). */
  from: UnitId;
  launchAt: LngLat;
  aim: LngLat;
  target: StrikeTarget;
  /** Nation visée (pour les notifications et la tension), null si personne. */
  victim: NationId | null;
  impactAt: GameTime;
  nuclear: boolean;
  kind: string;
  /** Classe d'interception : croisière, balistique, hypersonique, drone (munition rôdeuse). */
  cls: 'cruise' | 'ballistic' | 'hypersonic' | 'drone';
  /** Bataille (rapport) à laquelle la salve est rattachée. */
  battle: string | null;
  launched: number;
}

export interface SatSt {
  /** Zone visée (centre de la fauchée). */
  aim: LngLat | null;
  next: GameTime;
  v: number;
}

export interface OpStepSt {
  offsetMin: number;
  label: string;
  order: unknown;
  status: 'pending' | 'done' | 'failed';
  error?: string;
}

export interface OpSt {
  id: string;
  owner: NationId;
  name: string;
  hHour: GameTime;
  status: 'planned' | 'running' | 'done' | 'cancelled' | 'failed';
  steps: OpStepSt[];
  createdAt: GameTime;
}

export interface BattleSideSt {
  nations: NationId[];
  /** systemId → effectif maximal engagé (éléments). */
  engaged: Record<SystemId, number>;
  losses: Record<SystemId, number>;
  /** Valeur des pertes (dollars ou unités de coût du catalogue). */
  lossValue: number;
}

/**
 * Faits d'un camp pour le rapport après action (optionnel : batailles antérieures). Clés courtes :
 * l'état est sérialisé dans les instantanés.
 */
export interface BattleSideX {
  /** Dégâts reçus (PV) par système. */
  hp: Record<SystemId, number>;
  /** Éléments × rounds de tir ayant porté, par système (munitions tirées). */
  sh: Record<SystemId, number>;
  /** Meilleur niveau d'identification atteint par ce camp sur chaque unité adverse (1 à 3). */
  ob: Record<UnitId, number>;
  /** Éléments adverses détruits par les tirs de ce camp (pertes confirmées), par unité adverse. */
  kc: Record<UnitId, number>;
  /** Dégâts (PV) infligés par ce camp à chaque unité adverse (évaluation des dégâts). */
  dd: Record<UnitId, number>;
  /** Missiles tirés, missiles de ce camp abattus, missiles adverses abattus par ce camp, impacts reçus. */
  ml: number;
  md: number;
  mi: number;
  mr: number;
  /** Coups portés par mode : indirect, air → sol, sol direct, naval, contre aéronefs. */
  mo: number[];
  /** Tirs adverses dégradés par son brouillage, coups portés sans être vu (furtivité). */
  ew: number;
  st: number;
  /** Coups reçus : total, en position retranchée (fortification, ville), tirs portés mal ravitaillé, tirs portés. */
  nh: number;
  fo: number;
  oos: number;
  nf: number;
  /** Coups portés contre des aéronefs adverses, et éléments aériens adverses abattus. */
  aa: number;
  /** Vétérance : somme des niveaux × éléments, éléments comptés. */
  vt: [number, number];
  /** Généraux (identifiants) qui commandaient des unités engagées. */
  gn: string[];
  /** Éléments capturés par l'adversaire (matériel pris sur ses bases). */
  cp: Record<SystemId, number>;
}

export interface BattleX {
  a: BattleSideX;
  d: BattleSideX;
  /** Courbe : [t, pertes A, pertes D, pertes A confirmées par D, pertes D confirmées par A]. */
  ser: [number, number, number, number, number][];
  /**
   * Tranche en cours : début, puis par camp (A puis D) les coups portés par mode (indirect, air sur
   * sol, sol direct, naval, air-air) et les éléments perdus.
   */
  bk: [number, number[], number[]] | null;
  /** Phases closes : [genre, début, fin, camp (a / d / ''), pertes A, pertes D, confirmées A, confirmées D]. */
  ph: [string, number, number, string, number, number, number, number][];
  /** Provinces prises dans la zone : [province, preneur, date]. */
  cap: [ProvinceId, NationId, number][];
  /** Coups par milieu de la cible : terre, mer, air. */
  dom: [number, number, number];
  /** Propriétaire de la province au début. */
  own: NationId | null;
}

export interface BattleSt {
  id: string;
  at: LngLat;
  pid: ProvinceId | null;
  start: GameTime;
  last: GameTime;
  end: GameTime | null;
  a: BattleSideSt;
  d: BattleSideSt;
  /** Unités vues dans la bataille : id → [propriétaire, système, éléments à l'engagement]. */
  units: Record<UnitId, [NationId, SystemId] | [NationId, SystemId, number]>;
  cm: Record<string, number>;
  /** Faits marquants ; `u` : unités nommées dans le texte (masqué au lecteur qui ne les a pas identifiées). */
  timeline: { t: GameTime; text: string; u?: UnitId[] }[];
  frames: {
    t: GameTime;
    units: { id: UnitId; owner: NationId; systemId: SystemId; at: LngLat; hp: number }[];
  }[];
  shots: {
    t: GameTime;
    from: LngLat;
    to: LngLat;
    cls: TargetClass;
    hit: boolean;
    /** Tireur (filtrage du replay selon ce que le lecteur a vu). */
    u?: UnitId;
  }[];
  outcome: 'attacker' | 'defender' | 'draw' | 'ongoing';
  title: string;
  /** Rapport après action (absent des batailles antérieures). */
  x?: BattleX;
}

export interface GenSt {
  id: string;
  owner: NationId;
  name: string;
  traits: GeneralTrait[];
  units: UnitId[];
  directive: 'defend' | 'advance' | 'harass' | null;
  area: LngLat | null;
  /** Version de la délégation (invalide les réflexions programmées). */
  v: number;
}

export interface BlkSt {
  id: string;
  by: NationId;
  target: { provinceId: ProvinceId } | { straitId: string };
  at: LngLat;
  units: UnitId[];
  since: GameTime;
  on: boolean;
}

export interface SfSt {
  pid: ProvinceId;
  mission: 'raid' | 'sabotage' | 'rescue';
  building: BuildingType | null;
  /** Version du trajet à l'ordre (l'opération est annulée par tout nouvel ordre). */
  mv: number;
}

export interface StatSt {
  kills: number;
  losses: number;
  /** Victimes estimées (personnels) subies. */
  cas: number;
  /** Victimes estimées infligées. */
  casInf: number;
  /** Éléments détruits par système de l'attaquant. */
  bySys: Record<SystemId, number>;
  missiles: number;
  intercepted: number;
  /**
   * Valeur détruite (prix des éléments) par nation victime : ce que l'attaquant a vu détruire, base de
   * son estimation des forces adverses restantes (IA, sans tricher).
   */
  vs?: Record<NationId, number>;
}

export interface MilState {
  seq: number;
  /** PRNG propre au module (graine dérivée de celle de la partie). */
  rng: [number, number, number, number] | null;
  /** Unités fixes des sites de défense (board.sites) : "province:bâtiment" → unité. */
  fixed: Record<string, UnitId>;
  /** Unité fixe → "province:bâtiment" (ordre de déplacement refusé). */
  fixedOf: Record<UnitId, string>;
  /** Zones de brouillage (signal jam du renseignement) : identifiant → zone. */
  jz: Record<string, { by: NationId; at: LngLat; r: number; until: GameTime }>;
  /** Unité fixe → portée du site (engagement ou détection, km), fixée par eco selon le niveau. */
  siteRange: Record<UnitId, number>;
  ms: Record<UnitId, MissionSt>;
  msl: Record<UnitId, MissileSt>;
  /** Lanceur → prêt à tirer à partir de. */
  reload: Record<UnitId, GameTime>;
  /** Navire → cellules de lancement restantes. */
  cells: Record<UnitId, number>;
  /** Intercepteur → [munitions restantes, dernier tir]. */
  mag: Record<UnitId, [number, GameTime]>;
  /** Intercepteur → [début de la fenêtre d'engagement, canaux utilisés]. */
  icw: Record<UnitId, [GameTime, number]>;
  /** "intercepteur>missile" → prochain engagement programmé. */
  icq: Record<string, GameTime>;
  /** Brouilleurs éteints (un brouilleur émet par défaut). */
  jamOff: Record<UnitId, true>;
  /** Sous-marin repéré jusqu'à (après un tir). */
  exposed: Record<UnitId, GameTime>;
  /** Radars d'une nation aveuglés jusqu'à (cyberattaque). */
  blind: Record<NationId, GameTime>;
  /** Leurre → fin de vie. */
  decoy: Record<UnitId, GameTime>;
  sats: Record<UnitId, SatSt>;
  ops: Record<string, OpSt>;
  battles: Record<string, BattleSt>;
  /** Batailles en cours (identifiants triés). */
  open: string[];
  gens: Record<string, GenSt>;
  unitGen: Record<UnitId, string>;
  blk: Record<string, BlkSt>;
  sf: Record<UnitId, SfSt>;
  stats: Record<NationId, StatSt>;
  /** Dernier niveau d'alerte notifié. */
  lastAlert: number;
  /** Cessez-le-feu vus en vigueur (pour réengager à leur expiration). */
  cf: Record<string, number>;
  /** Zones d'exclusion vues (empreinte). */
  nf: string;
}

export function emptyMil(): MilState {
  return {
    seq: 0,
    rng: null,
    fixed: {},
    fixedOf: {},
    siteRange: {},
    jz: {},
    ms: {},
    msl: {},
    reload: {},
    cells: {},
    mag: {},
    icw: {},
    icq: {},
    jamOff: {},
    exposed: {},
    blind: {},
    decoy: {},
    sats: {},
    ops: {},
    battles: {},
    open: [],
    gens: {},
    unitGen: {},
    blk: {},
    sf: {},
    stats: {},
    lastAlert: 5,
    cf: {},
    nf: '',
  };
}

/** État du module (créé à la volée pour les parties antérieures au module). */
export function mil(state: EngineState): MilState {
  const mods = state.mods as Record<string, unknown>;
  let m = mods.mil as MilState | undefined;
  if (!m) {
    m = emptyMil();
    mods.mil = m;
  }
  return m;
}

/** Lecture sans création (code du cœur). */
export function milOpt(state: EngineState): MilState | undefined {
  return (state.mods as Record<string, unknown> | undefined)?.mil as MilState | undefined;
}

const balCache = new WeakMap<object, MilitaryBalance>();

/** Équilibrage militaire (section `military` de data/balance, valeurs par défaut sinon). */
export function milBal(state: EngineState): MilitaryBalance {
  const b = state.world.balance;
  let r = balCache.get(b);
  if (!r) {
    r = MilitaryBalanceSchema.parse(b.military ?? {});
    balCache.set(b, r);
  }
  return r;
}

export function nextId(state: EngineState, prefix: string): string {
  const m = mil(state);
  return `${prefix}${++m.seq}`;
}
