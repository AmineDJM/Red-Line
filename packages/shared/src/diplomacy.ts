import type { GameTime, LngLat, NationId, ProvinceId } from './ids.js';
import type { LocText } from './i18n.js';

export type Relation = 'war' | 'peace' | 'ceasefire' | 'ally';

export interface RelationView {
  nationId: NationId;
  relation: Relation;
  since: GameTime;
  /** Proposition de paix / cessez-le-feu en attente. */
  pending?: { from: NationId; kind: 'peace' | 'ceasefire'; at: GameTime } | null;
}

export interface AllianceCharter {
  mutualDefense: boolean;
  intelSharing: boolean;
  passage: boolean;
}

export interface AllianceView {
  id: string;
  name: string;
  /** Drapeau : emoji ou code court choisi par le chef. */
  flag: string;
  leader: NationId;
  members: NationId[];
  charter: AllianceCharter;
  treasury: number;
  createdAt: GameTime;
  /** Votes en cours (remplacement du chef, défense mutuelle, exclusion). */
  votes: AllianceVoteView[];
  invites: NationId[];
}

export interface AllianceVoteView {
  id: string;
  kind: 'replace_leader' | 'skip_mutual_defense' | 'expel';
  subject: NationId;
  endsAt: GameTime;
  yes: NationId[];
  no: NationId[];
}

// ——— Conseil de sécurité ———

export const RESOLUTION_TYPES = [
  'arms_embargo',
  'economic_sanctions',
  'ceasefire',
  'no_fly_zone',
  'peacekeeping',
  'condemnation',
] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

export interface ResolutionView {
  id: string;
  type: ResolutionType;
  proposer: NationId;
  /** Nation visée, ou zone (zone d'exclusion, maintien de la paix). */
  target: { nationId?: NationId; provinceIds?: ProvinceId[]; at?: LngLat; radiusKm?: number };
  text: string;
  votes: Record<NationId, 'yes' | 'no' | 'abstain'>;
  status: 'proposed' | 'voting' | 'passed' | 'rejected' | 'vetoed' | 'expired';
  /** Durée d'effet si adoptée. */
  durationDays: number;
}

export interface CouncilView {
  members: NationId[];
  rotatingSeats: NationId[];
  rule: { majority: 'simple' | 'two_thirds'; veto: boolean };
  nextSessionAt: GameTime;
  session: {
    phase: 'proposals' | 'voting' | 'closed';
    opensAt: GameTime;
    votingEndsAt: GameTime;
    resolutions: ResolutionView[];
  } | null;
  /** Résolutions adoptées encore en vigueur. */
  inForce: (ResolutionView & { until: GameTime })[];
}

// ——— Stabilité, territoires disputés, rebelles ———

export interface StabilityView {
  value: number; // 0..100
  trend: number; // variation par jour
  /** Facteurs principaux (libellés courts). */
  factors: { label: string; delta: number }[];
  coupRisk: number; // 0..1
}

export interface DisputedView {
  id: string;
  name: string;
  provinceIds: ProvinceId[];
  holder: NationId;
  claimants: NationId[];
  tension: number; // 0..100
}

// ——— Fil d'actualité mondial ———

export type NewsCategory =
  | 'strike'
  | 'war'
  | 'peace'
  | 'council'
  | 'leak'
  | 'revolt'
  | 'coup'
  | 'alliance'
  | 'economy'
  | 'nuclear'
  | 'capture'
  | 'refugees'
  | 'event';

export interface NewsItem {
  id: string;
  time: GameTime;
  category: NewsCategory;
  headline: string;
  body: string;
  at: LngLat | null;
  nations: NationId[];
  /**
   * Gabarit localisable (`news.<type>.h<n>` / `news.<type>.b<n>` et paramètres) : le client affiche
   * la dépêche dans la langue du joueur ; `headline`/`body` restent le texte français.
   */
  loc?: { headline: LocText; body: LocText };
}

export interface DiplomacyView {
  relations: RelationView[];
  alliances: AllianceView[];
  myAllianceId: string | null;
  /** Invitations reçues. */
  invitations: string[];
  reputation: number; // 0..100
  disputed: DisputedView[];
  /** Nations neutres courtisables : inclinaison vers chaque alliance (0..1). */
  neutrals: { nationId: NationId; leaning: Record<string, number> }[];
}
