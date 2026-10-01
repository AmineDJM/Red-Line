import type {
  AllianceCharter,
  GameTime,
  LngLat,
  NationId,
  NewsItem,
  ProvinceId,
  ResolutionType,
  UnitId,
} from '@redline/shared';
import { frA, frAgree, frCap, frDe, frLe, type FrArticle } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import type { RngState } from '../../rng/rng.js';
import { board, modState } from '../kit.js';
import { wi } from '../../state/world.js';
import { worldConfig, type DiploConfig } from './config.js';

/** Vote interne d'une alliance. `subject` : nouveau chef proposé, nation dispensée, ou membre à exclure. */
export interface AllianceVote {
  id: string;
  kind: 'replace_leader' | 'skip_mutual_defense' | 'expel';
  subject: NationId;
  endsAt: GameTime;
  yes: NationId[];
  no: NationId[];
  /** Défense mutuelle : membre attaqué (vote ouvert automatiquement). */
  victim?: NationId;
}

export interface Alliance {
  id: string;
  name: string;
  flag: string;
  leader: NationId;
  members: NationId[];
  charter: AllianceCharter;
  treasury: number;
  createdAt: GameTime;
  votes: AllianceVote[];
  invites: NationId[];
  /** Dispenses de défense mutuelle en vigueur : agresseur → fin. */
  skip: Record<NationId, GameTime>;
}

export interface Resolution {
  id: string;
  type: ResolutionType;
  proposer: NationId;
  target: { nationId?: NationId; provinceIds?: ProvinceId[]; at?: LngLat; radiusKm?: number };
  text: string;
  votes: Record<NationId, 'yes' | 'no' | 'abstain'>;
  status: 'proposed' | 'voting' | 'passed' | 'rejected' | 'vetoed' | 'expired';
  durationDays: number;
  /** Proposition automatique (violation de cessez-le-feu, attaque de casques bleus). */
  auto?: boolean;
}

export interface InForce extends Resolution {
  until: GameTime;
  /** Unités de casques bleus déployées. */
  units?: UnitId[];
}

export interface Session {
  id: number;
  /** Version : invalide les événements programmés (séance d'urgence). */
  v: number;
  phase: 'proposals' | 'voting' | 'closed';
  opensAt: GameTime;
  votingEndsAt: GameTime;
  members: NationId[];
  rotating: NationId[];
  resolutions: Resolution[];
}

export interface PeaceProposal {
  from: NationId;
  to: NationId;
  kind: 'peace' | 'ceasefire';
  at: GameTime;
}

export interface StabilityDetail {
  /** Valeur au tick précédent (tendance). */
  prev: number;
  /** Facteurs récents : libellé → variation cumulée (décroissante). */
  f: Record<string, number>;
  /** Unités perdues depuis le dernier tick. */
  lost: number;
  /** Provinces perdues depuis le dernier tick. */
  provLost: number;
}

export interface DisputedState {
  tension: number;
  holder: NationId;
}

export type PseudoKind = 'rebel' | 'peacekeeper';

export interface Irregular {
  kind: 'rebel' | 'peacekeeper' | 'mercenary';
  /** Fin de contrat / dissolution. */
  until: GameTime;
}

export interface WorldEffect {
  event: string;
  until: GameTime;
  mods: Record<string, number>;
}

export interface DiploState {
  /** PRNG propre au module (n'altère pas les tirages du combat). */
  rng: RngState;
  /** Règles du Conseil propres à la partie. */
  rule: { majority: 'simple' | 'two_thirds'; veto: boolean };
  councilEveryMs: number;
  voteWindowMs: number;
  rotatingSeats: number;
  rep: Record<NationId, number>;
  /** Date du dernier changement de relation, clé "a|b". */
  since: Record<string, GameTime>;
  /** Agresseur de chaque guerre, clé "a|b". */
  aggressor: Record<string, NationId>;
  /** Proposition de paix en attente, clé "a|b". */
  proposals: Record<string, PeaceProposal>;
  /** Retrait après la paix / cessez-le-feu : clé "a>b" → fin du droit de passage. */
  grace: Record<string, GameTime>;
  alliances: Record<string, Alliance>;
  nextId: number;
  session: Session;
  /** Ouverture de la prochaine séance ordinaire (rythme mensuel). */
  nextRegular: GameTime;
  inForce: InForce[];
  stab: Record<NationId, StabilityDetail>;
  disputed: Record<string, DisputedState>;
  /** Agitation locale par province (financements, révoltes), 0..100. */
  unrest: Record<ProvinceId, number>;
  /** Financeurs des rebelles par province (pour la remise au prétendant). */
  funding: Record<ProvinceId, Record<NationId, number>>;
  /** Inclinaison des neutres vers chaque alliance. */
  leaning: Record<NationId, Record<string, number>>;
  /** Pseudo-nations créées (rebelles par pays, casques bleus). */
  pseudo: Record<NationId, { kind: PseudoKind; of: NationId | null }>;
  /** Unités irrégulières (rebelles, casques bleus, mercenaires). */
  irregular: Record<UnitId, Irregular>;
  news: NewsItem[];
  newsSeq: number;
  /** Anti-répétition des dépêches : clé → dernière date. */
  throttle: Record<string, GameTime>;
  /** Dernier ordre accepté par nation (chef inactif). */
  lastActive: Record<NationId, GameTime>;
  /** Réfugiés estimés accueillis par nation. */
  refugees: Record<NationId, number>;
  effects: WorldEffect[];
  /** Nations ayant subi un coup d'État (politique changée). */
  coups: Record<NationId, GameTime>;
  /** Version de la carte politique (incrémentée à chaque capture ; caches dérivés de l'IA). */
  ownerV: number;
  /** Pertes en territoire depuis le dernier tick (réfugiés). */
  hurt: Record<NationId, number>;
}

export const PK_NATION = 'onu';
export const REBEL_PREFIX = 'reb-';

export function ds(state: EngineState): DiploState {
  return modState<DiploState>(state, 'diplo');
}

export function cfg(state: EngineState): DiploConfig {
  return worldConfig(state.world);
}

export function pairKey(a: NationId, b: NationId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function isPseudo(state: EngineState, n: NationId): boolean {
  return !!ds(state).pseudo[n];
}

/** Nation « régulière » de la partie (hors pseudo-nations). */
export function isRegular(state: EngineState, n: NationId): boolean {
  return !!state.nations[n] && !isPseudo(state, n);
}

export function clamp(x: number, lo = 0, hi = 100): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function allianceOf(state: EngineState, n: NationId): Alliance | null {
  const id = board(state).allianceOf[n];
  return id ? (ds(state).alliances[id] ?? null) : null;
}

export function sameAlliance(state: EngineState, a: NationId, b: NationId): boolean {
  const x = board(state).allianceOf[a];
  return !!x && x === board(state).allianceOf[b];
}

export function reputation(state: EngineState, n: NationId): number {
  return ds(state).rep[n] ?? cfg(state).reputationStart;
}

export function addReputation(state: EngineState, n: NationId, delta: number): void {
  if (!isRegular(state, n)) return;
  ds(state).rep[n] = round1(clamp(reputation(state, n) + delta));
}

export function stabilityOf(state: EngineState, n: NationId): number {
  return board(state).stability[n] ?? cfg(state).stabilityStart;
}

/** Variation de stabilité avec son facteur (libellé court, affiché dans StabilityView). */
export function addStability(state: EngineState, n: NationId, delta: number, label: string): void {
  if (!isRegular(state, n) || delta === 0) return;
  const d = stabDetail(state, n);
  const b = board(state);
  b.stability[n] = round1(clamp(stabilityOf(state, n) + delta));
  d.f[label] = round1((d.f[label] ?? 0) + delta);
}

export function stabDetail(state: EngineState, n: NationId): StabilityDetail {
  const st = ds(state).stab;
  let d = st[n];
  if (!d) st[n] = d = { prev: stabilityOf(state, n), f: {}, lost: 0, provLost: 0 };
  return d;
}

export function nationName(state: EngineState, n: NationId): string {
  const def = wi(state.world).nationById.get(n);
  if (def) return def.name;
  const p = ds(state).pseudo[n];
  if (p?.kind === 'peacekeeper') return 'Casques bleus';
  if (p?.kind === 'rebel') return p.of ? `Rebelles (${nationName(state, p.of)})` : 'Rebelles';
  return n;
}

/** Article français de la nation (données) ; pseudo-nations au pluriel (« les Casques bleus »). */
export function nationArticle(state: EngineState, n: NationId): FrArticle {
  const def = wi(state.world).nationById.get(n);
  if (def) return def.article ?? '';
  return ds(state).pseudo[n] ? 'les' : '';
}

/** « le Maroc », « l'Algérie », « Cuba » ; `cap` pour un début de phrase. */
export function natLe(state: EngineState, n: NationId, cap = false): string {
  const s = frLe(nationName(state, n), nationArticle(state, n));
  return cap ? frCap(s) : s;
}

/** « du Maroc », « de l'Algérie », « des États-Unis », « d'Israël ». */
export function natDe(state: EngineState, n: NationId): string {
  return frDe(nationName(state, n), nationArticle(state, n));
}

/** « au Maroc », « à l'Algérie », « aux États-Unis », « à Cuba ». */
export function natA(state: EngineState, n: NationId): string {
  return frA(nationName(state, n), nationArticle(state, n));
}

/** Verbe accordé en nombre avec la nation sujet : « le Maroc propose », « les États-Unis proposent ». */
export function natAgree(state: EngineState, n: NationId, sg: string, pl: string): string {
  return frAgree(nationArticle(state, n), sg, pl);
}

/** Liste de nations avec article : « le Maroc, l'Algérie et la Tunisie ». */
export function natList(state: EngineState, ns: readonly NationId[]): string {
  const l = ns.map((n) => natLe(state, n));
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} et ${l[l.length - 1]}`;
}

export function newId(state: EngineState, prefix: string): string {
  return `${prefix}${++ds(state).nextId}`;
}
