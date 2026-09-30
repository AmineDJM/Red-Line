import type {
  GameTime,
  NationId,
  Orbat,
  ProvinceId,
  Resource,
  SystemId,
  TradeItem,
  UnitId,
} from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { modState } from '../kit.js';

/** Somme payée (remboursements partiels à l'annulation). */
export interface Paid {
  money: number;
  res: Partial<Record<Resource, number>>;
}

export interface ResearchJob {
  id: string;
  startedAt: GameTime;
  completesAt: GameTime;
  paid: Paid;
  /** Version : invalide l'événement de fin (accélération, annulation). */
  v: number;
}

export interface EcoNation {
  /** Nœuds de recherche acquis (triés). */
  done: string[];
  /** Date d'acquisition des nœuds obtenus en cours de partie. */
  doneAt: Record<string, GameTime>;
  cur: ResearchJob | null;
  queue: { id: string; paid: Paid }[];
  /** Licences de production détenues : système → date d'acquisition. */
  licences: Record<SystemId, GameTime>;
  /** Début de la mobilisation générale (null = pas mobilisée). */
  mobSince: GameTime | null;
  /** Dollars dépensés (statistiques). */
  spent: number;
  /** Ressources en pénurie au dernier tick journalier. */
  short: Partial<Record<Resource, true>>;
  /** Grand livre : flux signés du jour en cours et du jour précédent (clés LedgerKey). */
  today: Record<string, number>;
  lastDay: Record<string, number>;
  /** Trésorerie juste après le dernier tick journalier (poste « other » par différence). */
  lastMoney: number;
}

/** État d'un bâtiment qui s'écarte du défaut (présent à la carte, santé 1, sans réparation). */
export interface BState {
  h: number;
  /** Fin de la réparation en cours. */
  rep: GameTime | null;
  /** Version de la réparation. */
  rv: number;
  /** Bâtiment construit en cours de partie (absent de la carte). */
  add?: true;
  /** Niveau, s'il diffère du niveau de départ. */
  lvl?: number;
}

export type JobKind = string; // BuildingType | 'fortification' | 'forward_base'

export interface Job {
  id: string;
  n: NationId;
  pid: ProvinceId;
  kind: JobKind;
  startedAt: GameTime;
  completesAt: GameTime;
  paid: number;
  v: number;
  /** Niveau visé (1 = construction, > 1 = amélioration). */
  lvl: number;
}

export interface ProdMeta {
  n: NationId;
  v: number;
  paid: Paid;
}

export interface Offer {
  id: string;
  seller: NationId;
  item: TradeItem;
  price: number;
  to: NationId | null;
  createdAt: GameTime;
  expiresAt: GameTime;
}

export interface Delivery {
  id: string;
  from: NationId;
  to: NationId;
  item: TradeItem;
  carrier: UnitId | null;
  eta: GameTime;
  covert: boolean;
  /** Province de destination (capitale de l'acheteur). */
  dest: ProvinceId;
  /** Version du trajet du porteur au moment de la programmation de l'arrivée. */
  mv: number;
}

export interface EcoState {
  /** Économie réelle (recherche et/ou ORBAT chargés) ; sinon comportement de la phase 1. */
  live: boolean;
  /** Année du scénario (ère des systèmes, eraYear des nœuds). */
  year: number;
  /** Jeu d'ORBAT (« 2025 »…). */
  set: string;
  nations: Record<NationId, EcoNation>;
  prod: Record<string, ProdMeta>;
  bld: Record<ProvinceId, Record<string, BState>>;
  jobs: Record<string, Job>;
  forts: Record<ProvinceId, number>;
  /** Moral des provinces qui s'écarte de la valeur de départ. */
  morale: Record<ProvinceId, number>;
  /** Ravitaillement des unités qui ne sont pas « supplied ». */
  supply: Record<UnitId, 'limited' | 'cut'>;
  offers: Record<string, Offer>;
  dlv: Record<string, Delivery>;
  /** Provinces sous blocus → nation qui l'impose. */
  blockaded: Record<ProvinceId, NationId>;
  straits: Record<string, NationId>;
  /** Agrandissement des piles de départ (cible mondiale de piles). */
  stackScale: number;
  seq: number;
}

export function emptyEcoNation(): EcoNation {
  return {
    done: [],
    doneAt: {},
    cur: null,
    queue: [],
    licences: {},
    mobSince: null,
    spent: 0,
    short: {},
    today: {},
    lastDay: {},
    lastMoney: 0,
  };
}

export function emptyEco(live: boolean, year: number, set: string): EcoState {
  return {
    live,
    year,
    set,
    nations: {},
    prod: {},
    bld: {},
    jobs: {},
    forts: {},
    morale: {},
    supply: {},
    offers: {},
    dlv: {},
    blockaded: {},
    straits: {},
    stackScale: 1,
    seq: 0,
  };
}

export function eco(state: EngineState): EcoState {
  let es = modState<EcoState | undefined>(state, 'eco');
  if (!es) {
    es = emptyEco(false, 2025, '2025');
    state.mods.eco = es;
  }
  return es;
}

export function ecoNation(state: EngineState, n: NationId): EcoNation {
  const es = eco(state);
  let en = es.nations[n];
  if (!en) es.nations[n] = en = emptyEcoNation();
  return en;
}

export function nextId(state: EngineState, prefix: string): string {
  const es = eco(state);
  return `${prefix}${++es.seq}`;
}

export function orbatOf(state: EngineState, n: NationId): Orbat | undefined {
  return state.world.orbats?.get(eco(state).set)?.get(n);
}

/** Index dérivés (jamais sérialisés), recalculés à la demande après désérialisation. */
export interface EcoRuntime {
  /** Revenu journalier en argent de chaque province (dollars si son propriétaire d'origine a un ORBAT). */
  provValue: Map<ProvinceId, number> | null;
  /** Produit des effets de recherche par nation et par clé. */
  mods: Map<NationId, Map<string, number>>;
}

const runtimes = new WeakMap<EngineState, EcoRuntime>();

export function ecoRt(state: EngineState): EcoRuntime {
  let r = runtimes.get(state);
  if (!r) runtimes.set(state, (r = { provValue: null, mods: new Map() }));
  return r;
}

export function resetEcoRt(state: EngineState): void {
  runtimes.delete(state);
}

export function sortedIds(o: object): string[] {
  return Object.keys(o).sort();
}

export function insertSorted(list: string[], id: string): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] !== id) list.splice(lo, 0, id);
}
