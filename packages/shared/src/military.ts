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
  // ——— optionnels ———
  /** `fuelH` est l'autonomie à l'instant `fuelAt` ; elle baisse d'une heure par heure de vol. */
  fuelAt?: GameTime;
  airborne?: boolean;
  /** Porte-avions (ou navire porteur) d'attache, au lieu d'une province. */
  baseUnitId?: UnitId | null;
  /** Phase : aller, sur zone, retour, jonction avec un ravitailleur. */
  phase?: 'out' | 'station' | 'back' | 'tanker' | null;
  /** Retour automatique prévu (carburant). */
  bingoAt?: GameTime | null;
  /** Disponible à partir de (remise en œuvre après atterrissage, rechargement d'un lanceur). */
  readyAt?: GameTime | null;
  /** Munitions restantes : cellules de lancement ou magasin d'intercepteurs. */
  ammo?: number | null;
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

/** Tir enregistré dans une bataille (replay, activité récente). */
export interface BattleShotView {
  t: GameTime;
  from: LngLat;
  to: LngLat;
  cls: TargetClass;
  hit: boolean;
}

export interface BattleReportSummary {
  id: string;
  at: LngLat;
  provinceId: ProvinceId | null;
  startedAt: GameTime;
  endedAt: GameTime | null;
  title: string;
  /**
   * Camps. Depuis le rapport « après action », le camp du lecteur est exact ; le camp adverse ne
   * contient que les matériels qu'il a identifiés (effectifs estimés, pertes confirmées).
   */
  attacker: BattleSide;
  defender: BattleSide;
  outcome: 'attacker' | 'defender' | 'draw' | 'ongoing';
  /**
   * Bataille en cours (optionnel) : activité récente pour l'affichage sur la carte (traceurs,
   * explosions). Mêmes informations que le replay du rapport, réservées aux nations engagées.
   */
  live?: {
    /** Dernier fait d'armes (temps de jeu). */
    lastAt: GameTime;
    /** Derniers tirs (bornés en nombre et en ancienneté), du plus ancien au plus récent. */
    shots: BattleShotView[];
  };
  // ——— optionnels (rapport après action) ———
  /** Milieu dominant des combats (carte : symbole de la bataille). */
  domain?: BattleDomain;
  /** Camp du lecteur. */
  mySide?: 'attacker' | 'defender';
  /** Intensité (0 à 1) : pertes cumulées rapportées aux forces engagées (taille du symbole). */
  intensity?: number;
}

export interface BattleReport extends BattleSummaryDetails, BattleReportSummary {
  /** Rapport après action (champs optionnels : absent des parties anciennes). */
  aar?: BattleAar;
}

// ——— Rapport après action (AAR) ———

/** Milieu d'une bataille : terre, littoral (terre et mer), mer, air. */
export type BattleDomain = 'land' | 'coast' | 'sea' | 'air';

/** Estimation : meilleure valeur et fourchette (min = max = best pour un chiffre exact). */
export interface Estimate {
  best: number;
  min: number;
  max: number;
}

/** Fiabilité de la source (A : sûre … F : inconnue) et crédibilité de l'information (1 : confirmée … 6 : invérifiable). */
export interface IntelGrade {
  source: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  credibility: 1 | 2 | 3 | 4 | 5 | 6;
}

/** Ligne de l'ordre de bataille d'un camp : un matériel (ou un groupe non identifié). */
export interface BattleForceLine {
  /** Matériel identifié, sinon null (contact détecté seulement). */
  systemId: SystemId | null;
  /** Milieu du contact (connu dès la détection). */
  medium: 'land' | 'sea' | 'air';
  /** Éléments engagés (chars, appareils, navires, bataillons…). */
  engaged: Estimate;
  destroyed: Estimate;
  damaged: Estimate;
  captured: Estimate;
  /** Personnels engagés (équipages, servants, fantassins). */
  personnel: Estimate;
  /** Munitions principales tirées (obus, missiles, bombes), estimation. */
  munitions: Estimate;
}

export interface BattleCasualties {
  killed: Estimate;
  wounded: Estimate;
  missing: Estimate;
  prisoners: Estimate;
}

export interface BattleAarSide {
  side: 'attacker' | 'defender';
  nations: NationId[];
  /** Camp du lecteur : chiffres exacts ; camp adverse : estimations du renseignement. */
  own: boolean;
  /** Qualité de l'information (camp adverse seulement). */
  grade?: IntelGrade;
  forces: BattleForceLine[];
  totals: {
    personnel: Estimate;
    vehicles: Estimate;
    aircraft: Estimate;
    ships: Estimate;
  };
  casualties: BattleCasualties;
  materiel: { destroyed: Estimate; damaged: Estimate; captured: Estimate };
  /** Valeur des matériels perdus (dollars). */
  lossesUsd: Estimate;
  /** Missiles tirés par ce camp, et combien ont été abattus par l'adversaire. */
  missiles: { launched: Estimate; shotDown: Estimate };
  /** Missiles adverses abattus par ce camp. */
  interceptions: Estimate;
  /** Sorties aériennes (appareils engagés). */
  sorties: Estimate;
  munitions: Estimate;
  /** Généraux qui commandaient des unités engagées (camp du lecteur seulement). */
  generals?: string[];
  /** Niveau moyen de vétérance des unités engagées (camp du lecteur seulement). */
  veterancy?: number;
}

export type BattlePhaseKind =
  | 'preparation' // préparation d'artillerie, frappes de missiles et aériennes
  | 'strikes' // frappes à distance seulement (missiles, aviation)
  | 'assault' // assaut terrestre
  | 'defense' // assaut repoussé : le défenseur a l'avantage
  | 'counter' // contre-attaque du défenseur
  | 'air' // combat aérien
  | 'naval' // engagement naval
  | 'retreat' // repli d'un camp (pertes sans riposte)
  | 'capture'; // prise de la ville

export interface BattlePhase {
  kind: BattlePhaseKind;
  t0: GameTime;
  t1: GameTime;
  /** Camp qui a l'initiative pendant la phase. */
  side: 'attacker' | 'defender' | null;
  /** Pertes (éléments) pendant la phase : exactes pour le camp du lecteur, confirmées pour l'adversaire. */
  attackerLosses: number;
  defenderLosses: number;
}

export type BattleFactorKind =
  | 'numbers' // supériorité numérique
  | 'air_superiority'
  | 'electronic_warfare'
  | 'stealth'
  | 'entrenched' // défense retranchée ou urbaine
  | 'air_defense' // interceptions
  | 'supply' // ravitaillement coupé (facteur négatif)
  | 'veterancy'
  | 'generals'
  | 'morale'; // stabilité basse (facteur négatif)

export interface BattleFactor {
  kind: BattleFactorKind;
  /** Camp concerné. */
  side: 'attacker' | 'defender';
  /** Favorable (+) ou défavorable (−) à ce camp. */
  positive: boolean;
  /** Importance relative (0 à 1). */
  weight: number;
  /** Paramètres du libellé (nombres, noms). */
  params: Record<string, string | number>;
}

export interface BattleAar {
  /** Lieu : province, ville, propriétaire au début, milieu, combats en zone urbaine. */
  place: {
    provinceId: ProvinceId | null;
    province: string | null;
    city: string | null;
    owner: NationId | null;
    domain: BattleDomain;
    urban: boolean;
  };
  mySide: 'attacker' | 'defender';
  sides: [BattleAarSide, BattleAarSide];
  phases: BattlePhase[];
  /** Pertes cumulées (éléments) dans le temps : exactes pour le camp du lecteur, confirmées pour l'adversaire. */
  losses: { t: GameTime; attacker: number; defender: number }[];
  factors: BattleFactor[];
  /** Issue détaillée et conséquences. */
  result: {
    verdict:
      'decisive_attacker' | 'attacker' | 'stalemate' | 'defender' | 'decisive_defender' | 'ongoing';
    captured: { provinceId: ProvinceId; name: string; by: NationId; at: GameTime }[];
    /** Province disputée tenue par son propriétaire. */
    held: ProvinceId | null;
  };
}

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
    shots: BattleShotView[];
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
