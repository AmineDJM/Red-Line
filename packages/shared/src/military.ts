import type { GameTime, LngLat, NationId, ProvinceId, SystemId, UnitId } from './ids.js';
import type { BuildingType } from './map.js';
import type { TargetClass } from './catalog.js';

/** Niveau d'alerte mondial : 5 (calme) → 1 (crise nucléaire). Débloque ou bloque des actions pour tous. */
export type AlertLevel = 1 | 2 | 3 | 4 | 5;

/** Cible d'une frappe (missiles, bombardiers, forces spéciales). */
export type StrikeTarget =
  | { type: 'point'; at: LngLat }
  | { type: 'unit'; unitId: UnitId }
  | { type: 'building'; provinceId: ProvinceId; building: BuildingType };

/** Mission d'une unité aérienne ou navale. */
export type MissionKind =
  | 'none'
  | 'patrol' // patrouille (CAP) autour d'un point
  | 'strike' // frappe puis retour à la base
  | 'escort'
  | 'refuel' // ravitailleur en orbite
  | 'awacs' // avion radar en orbite
  | 'recon'
  | 'blockade'
  | 'rtb'; // retour à la base

export interface MissionView {
  kind: MissionKind;
  at?: LngLat;
  radiusKm?: number;
  target?: StrikeTarget;
  /** Autonomie restante (aéronefs), en heures de jeu. */
  fuelH?: number;
  baseProvinceId?: ProvinceId | null;
}

// ——— Opérations combinées (heure H) ———

export interface OperationStepInput {
  /** Décalage en minutes de jeu par rapport à l'heure H (négatif = avant). */
  offsetMin: number;
  /** Ordre à exécuter (tout ordre de jeu, sauf 'operation'). */
  order: unknown;
  label?: string;
}

export interface OperationView {
  id: string;
  name: string;
  hHour: GameTime;
  status: 'planned' | 'running' | 'done' | 'cancelled' | 'failed';
  steps: {
    offsetMin: number;
    label: string;
    status: 'pending' | 'done' | 'failed';
    error?: string;
  }[];
}

// ——— Rapports de bataille ———

export interface BattleSide {
  nations: NationId[];
  engaged: { systemId: SystemId; count: number }[];
  losses: { systemId: SystemId; count: number }[];
}

export interface BattleReportSummary {
  id: string;
  at: LngLat;
  provinceId: ProvinceId | null;
  startedAt: GameTime;
  endedAt: GameTime | null;
  title: string;
  attacker: BattleSide;
  defender: BattleSide;
  outcome: 'attacker' | 'defender' | 'draw' | 'ongoing';
}

export interface BattleReport extends BattleSummaryDetails, BattleReportSummary {}

export interface BattleSummaryDetails {
  /** Contre-mesures qui ont joué (brouillage, interception, furtivité…). */
  countermeasures: { kind: string; text: string; count: number }[];
  /** Chronologie des faits marquants. */
  timeline: { t: GameTime; text: string }[];
  /** Replay court : positions échantillonnées des unités engagées. */
  replay: {
    t0: GameTime;
    t1: GameTime;
    frames: {
      t: GameTime;
      units: { id: UnitId; owner: NationId; systemId: SystemId; at: LngLat; hp: number }[];
    }[];
    shots: { t: GameTime; from: LngLat; to: LngLat; cls: TargetClass; hit: boolean }[];
  };
}

// ——— Généraux, expérience, fortifications ———

export type GeneralTrait = 'offensive' | 'defender' | 'logistician' | 'aviator' | 'admiral';

export interface GeneralView {
  id: string;
  name: string;
  traits: GeneralTrait[];
  /** Groupe d'unités sous son commandement. */
  unitIds: UnitId[];
  /** Consigne de délégation IA (généraux délégués). */
  directive: 'defend' | 'advance' | 'harass' | null;
  area: LngLat | null;
}

export interface FortificationView {
  provinceId: ProvinceId;
  level: number;
  completesAt: GameTime | null;
}

export interface BlockadeView {
  id: string;
  by: NationId;
  target: { provinceId: ProvinceId } | { straitId: string };
  since: GameTime;
}

/** Passage d'un satellite au-dessus d'une zone (renseignement image). */
export interface SatellitePassView {
  unitId: UnitId;
  nextPassAt: GameTime;
  footprint: LngLat[];
}
