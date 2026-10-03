import {
  CommandBalanceSchema,
  type Aggressiveness,
  type ArmyJournalEntry,
  type ArmyStatus,
  type Branch,
  type CommandBalance,
  type OpMetric,
  type OpPhase,
  type OpSector,
  type OpStatus,
  type GameTime,
  type GeneralSkill,
  type LngLat,
  type NationId,
  type ProvinceId,
  type ReinforceMode,
  type Roe,
  type UnitId,
} from '@redline/shared';
import type { ArmyMemory } from '../../ai/ai.js';
import { nextFloat, seedRng, type RngState } from '../../rng/rng.js';
import type { EngineState } from '../../state/types.js';

/**
 * État sérialisable du centre de commandement (state.mods.cmd). Données JSON uniquement ; toute
 * itération qui influence le résultat se fait dans l'ordre trié des clés. Absent des anciennes
 * sauvegardes : créé à la volée au premier ordre.
 */

export interface MissionSt {
  type: string;
  provinceId?: ProvinceId;
  nationId?: NationId;
  at?: LngLat;
  radiusKm?: number;
  aggr: Aggressiveness;
  roe: Roe;
  retreatAt: number;
  since: GameTime;
  /** Provinces visées (Conquérir, Débarquement), figées au lancement. */
  targets?: ProvinceId[];
  /** Villes à tenir (Défendre, Tenir la ligne), figées au lancement. */
  holds?: ProvinceId[];
  /** Autorisations accordées par le joueur : guerre contre ces nations, frappes stratégiques. */
  okWar?: NationId[];
  okStrike?: boolean;
  /** Dernier progrès (prise, objectif atteint) : échec si rien n'avance pendant `stuckHours`. */
  progressAt: GameTime;
  /** Objectif atteint depuis (missions de durée : supériorité acquise…). */
  doneAt?: GameTime | null;
}

export interface RequestSt {
  id: string;
  kind: 'declare_war' | 'strategic_strike' | 'reinforce';
  nationId?: NationId;
  unitIds?: UnitId[];
  at: GameTime;
}

export interface ArmySt {
  id: string;
  owner: NationId;
  name: string;
  createdAt: GameTime;
  units: UnitId[];
  general: string | null;
  mission: MissionSt | null;
  status: ArmyStatus;
  suspended: boolean;
  reinforce: ReinforceMode;
  /** Piles sous ordre manuel du joueur : rendues au général à la fin de l'ordre. */
  manual: Record<UnitId, 1>;
  /** Piles repliées (santé sous le seuil de repli), rendues au général une fois remises. */
  rest?: Record<UnitId, 1>;
  /** Dernier constat « forces insuffisantes » (journal espacé). */
  weakAt?: GameTime;
  /** Compteurs au dernier rapport quotidien : [prises, pertes]. */
  rep?: [number, number];
  request: RequestSt | null;
  /** Délai avant une nouvelle demande de renforts. */
  askAfter: GameTime;
  journal: ArmyJournalEntry[];
  /** Valeur (dollars) au lancement de la mission. */
  start: number;
  /** Dernière valeur calculée (réflexion). */
  now: number;
  /** Estimation de la mission (réflexion). */
  est: { ratio: number; etaHours: number | null; chance: number } | null;
  /** Objectif mesurable (réflexion). */
  obj: { done: number; total: number } | null;
  /** Objectifs en cours (villes visées), pour la carte. */
  aims: LngLat[];
  captures: number;
  losses: number;
  /** Mémoire de l'IA tactique de l'armée (opérations, engagements, transports). */
  mem: ArmyMemory;
  /** Version : invalide les réflexions programmées. */
  v: number;
  /** Opération dont l'armée fait partie (son général y tient le rôle `OpSt.roles[id]`). */
  op?: string;
  /** Armée formée d'office pour une opération (dissoute quand elle la quitte). */
  opAuto?: boolean;
}

/** Ordre d'opération : pays cibles, objectif, généraux (armées), planificateur commun. */
export interface OpSt {
  id: string;
  owner: NationId;
  name: string;
  goal: string;
  nations: NationId[];
  /** Région visée (Occuper) : provinces désignées. */
  provinces?: ProvinceId[];
  aggr: Aggressiveness;
  roe: Roe;
  retreatAt?: number;
  deadline: GameTime | null;
  since: GameTime;
  status: OpStatus;
  suspended: boolean;
  /** Armées (une par général), dans l'ordre d'engagement. */
  armies: string[];
  roles: Record<string, Branch>;
  /** Secteurs de l'armée de terre (orientation, provinces), recalculés quand les forces changent. */
  sectors: Record<string, { dir: OpSector; pids: ProvinceId[] }>;
  /** Provinces à prendre (conquête, décapitation, occupation), figées au lancement. */
  targets: ProvinceId[];
  /** Mesures de référence au lancement : forces estimées, détruites par nation, ports, front. */
  base: { enemy: number; killed: Record<NationId, number>; ports: number; front: ProvinceId[] };
  /** Contacts ennemis identifiés vus depuis le lancement (défense sol-air, aéronefs), bâtiments visés. */
  seen: { sams: string[]; air: string[]; bld: string[] };
  /** Dernier aéronef ennemi vu en vol au-dessus des cibles. */
  airAt: GameTime | null;
  strikes: number;
  captures: number;
  losses: number;
  /** Valeur (dollars) des forces des pays visés détruite par la nation depuis le lancement. */
  kills?: number;
  phase: OpPhase;
  /** Fin du rassemblement (borné). */
  stageUntil: GameTime;
  /** Dernier progrès de la mesure principale (enlisement) et meilleure valeur atteinte. */
  progressAt: GameTime;
  best: number;
  doneAt: GameTime | null;
  request: { id: string; kind: 'declare_war'; nationId: NationId; at: GameTime } | null;
  okWar: NationId[];
  journal: ArmyJournalEntry[];
  prog: { key: OpMetric; done: number; total: number }[];
  pct: number;
  start: number;
  now: number;
  /** Valeur engagée au début de la fenêtre de 24 h (alerte « pertes lourdes »). */
  day: [GameTime, number];
  /** Dernières alertes émises (clé → date). */
  alerts: Record<string, GameTime>;
  /** Dernière reconnaissance lancée. */
  reconAt: GameTime | null;
  est: { ratio: number; etaHours: number | null; chance: number } | null;
  /** Objectifs en cours des généraux de l'armée de terre (appui aérien, couverture). */
  focus?: LngLat[];
  v: number;
}

export interface GenSt {
  id: string;
  owner: NationId;
  /** Rang du candidat dans le vivier de la nation (tirage déterministe). */
  idx: number;
  first: string;
  last: string;
  culture: string;
  skills: Record<GeneralSkill, number>;
  traits: string[];
  xp: number;
  /** Expérience déjà convertie en points de compétence. */
  xpUsed: number;
  status: 'active' | 'wounded' | 'dead' | 'resigned';
  army: string | null;
  hiredAt: GameTime;
  woundedUntil: GameTime | null;
  /** Jours de salaire impayés consécutifs. */
  unpaid: number;
  victories: number;
  /** Commandement (arme) ; absent dans les anciennes sauvegardes (déduit des compétences). */
  branch?: Branch;
}

export interface PoolSt {
  /** Rangs des candidats proposés (dans l'ordre d'arrivée). */
  ids: number[];
  /** Prochain rang à tirer. */
  next: number;
  /** Dernier renouvellement. */
  at: GameTime;
}

export interface CmdState {
  seq: number;
  rng: RngState | null;
  armies: Record<string, ArmySt>;
  /** Pile → armée. */
  unitArmy: Record<UnitId, string>;
  gens: Record<string, GenSt>;
  pools: Record<NationId, PoolSt>;
  /** Tick de réflexion programmé. */
  ticking: boolean;
  /** Viviers des commandements air, mer et DCA (`<nation>:<arme>`) ; celui de l'armée de terre est `pools`. */
  bpools?: Record<string, PoolSt>;
  /** Généraux en chef : nation → arme → général. */
  chiefs?: Record<NationId, Partial<Record<Branch, string>>>;
  /** Opérations (absent des sauvegardes antérieures). */
  ops?: Record<string, OpSt>;
}

export function emptyCmd(): CmdState {
  return { seq: 0, rng: null, armies: {}, unitArmy: {}, gens: {}, pools: {}, ticking: false };
}

/** État du module (créé à la volée : parties antérieures au centre de commandement). */
export function cmd(state: EngineState): CmdState {
  const mods = state.mods as Record<string, unknown>;
  let c = mods.cmd as CmdState | undefined;
  if (!c) {
    c = emptyCmd();
    mods.cmd = c;
  }
  return c;
}

/** Lecture sans création (vues, crochets fréquents). */
export function cmdOpt(state: EngineState): CmdState | undefined {
  return (state.mods as Record<string, unknown> | undefined)?.cmd as CmdState | undefined;
}

const balCache = new WeakMap<object, CommandBalance>();

/** Équilibrage du centre de commandement (section `command`, défauts sinon). */
export function cmdBal(state: EngineState): CommandBalance {
  const b = state.world.balance;
  let r = balCache.get(b);
  if (!r) {
    r = CommandBalanceSchema.parse(b.command ?? {});
    balCache.set(b, r);
  }
  return r;
}

export function nextCmdId(state: EngineState, prefix: string): string {
  const c = cmd(state);
  return `${prefix}${++c.seq}`;
}

/** PRNG propre au module (frictions, blessures), sérialisé ; ne perturbe aucune autre suite. */
export function cmdRoll(state: EngineState): number {
  const c = cmd(state);
  if (!c.rng) c.rng = seedRng((state.setup.seed ^ 0x0c0a_11d5) >>> 0);
  return nextFloat(c.rng);
}
