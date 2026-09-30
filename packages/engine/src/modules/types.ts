import type {
  GameNotification,
  NationId,
  Order,
  OrderErrorCode,
  PlayerView,
  ProvinceId,
} from '@redline/shared';
import type { GameSetup, GameStats, OrderResult, SystemCommand } from '../api.js';
import type { EngineState, Unit } from '../state/types.js';

/**
 * Modules du moteur (phases 2+). Chaque domaine vit dans src/modules/<id>/ et se branche au cœur par
 * cette interface, sans modifier les fichiers du cœur :
 *  - eco   : économie réelle (dollars US, budgets), recherche, licences, marché, logistique, bâtiments ;
 *  - mil   : air, mer, missiles, nucléaire, opérations combinées, rapports de bataille, capteurs, généraux ;
 *  - intel : renseignement (HUMINT, SIGINT, départements, rapports cotés, opérations, intoxication) ;
 *  - diplo : diplomatie, alliances, Conseil de sécurité, stabilité, territoires disputés, actualité, IA avancée.
 * Règles : pur et déterministe (PRNG de l'état), itérations triées, état du module dans state.mods[id]
 * (données sérialisables uniquement), index dérivés reconstruits par `rebuild`.
 */
export type ModuleId = 'eco' | 'mil' | 'intel' | 'diplo';

/** Événement propre à un module (programmé avec scheduleMod). */
export interface ModEvent {
  t: number;
  m: ModuleId;
  /** Type d'événement, libre dans le module. */
  e: string;
  /** Données sérialisables. */
  d?: unknown;
}

export type OrderHandler = (state: EngineState, n: NationId, order: Order) => OrderResult;
export type SystemHandler = (state: EngineState, cmd: SystemCommand) => OrderResult;

export interface ModuleHooks {
  /** Après le tick journalier du cœur (revenus de base déjà versés). */
  onDailyTick?(state: EngineState): void;
  /** Avant la suppression d'une unité détruite. */
  onUnitDestroyed?(state: EngineState, u: Unit, killer: Unit | null): void;
  /** Après chaque tir ayant infligé des dégâts. */
  onDamage?(state: EngineState, attacker: Unit, target: Unit, dmg: number): void;
  onUnitSpawned?(state: EngineState, u: Unit): void;
  onProvinceCaptured?(state: EngineState, pid: ProvinceId, from: NationId, to: NationId): void;
  onWarDeclared?(state: EngineState, a: NationId, b: NationId): void;
  /** Autorisation de produire (recherche, licence, embargo, bâtiment…) : code d'erreur ou null. */
  canProduce?(
    state: EngineState,
    n: NationId,
    systemId: string,
    pid: ProvinceId,
  ): OrderErrorCode | null;
  /** Multiplicateur (clés MODIFIER_KEYS de shared) ; le cœur multiplie les résultats des modules. */
  modifier?(state: EngineState, n: NationId, key: string): number;
  /** Multiplicateur propre à une unité (ravitaillement, fortification, général, vétérance…). */
  unitModifier?(state: EngineState, u: Unit, key: string): number;
  /** Autorisation d'importer (achat au catalogue d'un fournisseur) : embargo, alerte… */
  canImport?(state: EngineState, n: NationId, systemId: string): OrderErrorCode | null;
  /** Bus de signaux entre modules (voir SIGNALS dans docs/agents-brief-v2.md). */
  onSignal?(state: EngineState, name: string, data: Record<string, unknown>): void;
  /** Place les forces de départ d'une nation ; renvoie true si le module s'en est chargé (ORBAT). */
  placeStartingForces?(state: EngineState, n: NationId): boolean;
  /** Réflexion IA propre au module, appelée à chaque réflexion des IA pour chaque nation IA. */
  aiThink?(state: EngineState, n: NationId): void;
  /** Destinataires d'une notification inconnue du cœur (après désérialisation). */
  audience?(state: EngineState, nation: NationId, note: GameNotification): boolean | undefined;
  stats?(state: EngineState, out: GameStats): void;
}

/**
 * Tableau partagé entre modules (state.mods.board), lu par tous, écrit par le module propriétaire indiqué.
 * Données sérialisables uniquement.
 */
export interface SharedBoard {
  /** mil : niveau d'alerte mondial 5 (calme) → 1 (crise nucléaire) et tension sous-jacente 0..100. */
  alertLevel: 1 | 2 | 3 | 4 | 5;
  tension: number;
  /** diplo : nations sous embargo sur les armes (achats au catalogue interdits). */
  embargoed: Record<NationId, true>;
  /** diplo : multiplicateur de revenus commerciaux (sanctions), 1 = aucune. */
  sanctions: Record<NationId, number>;
  /** diplo : provinces sous zone d'exclusion aérienne. */
  noFly: Record<ProvinceId, true>;
  /** diplo : cessez-le-feu en vigueur, clé "a|b" (a < b) → fin. */
  ceasefires: Record<string, number>;
  /** diplo : stabilité 0..100 par nation. */
  stability: Record<NationId, number>;
  /** diplo : alliances, nation → identifiant d'alliance. */
  allianceOf: Record<NationId, string>;
  /** mil : nations ayant autorisé l'emploi du nucléaire. */
  nuclearAuth: Record<NationId, true>;
  /** eco : nations en mobilisation générale. */
  mobilized: Record<NationId, true>;
}

export interface EngineModule {
  id: ModuleId;
  /** Crée state.mods[id] (createGame), avant le placement des forces. */
  init?(state: EngineState, setup: GameSetup): void;
  /** Reconstruit les index dérivés du module (désérialisation). */
  rebuild?(state: EngineState): void;
  onEvent?(state: EngineState, ev: ModEvent): void;
  /** Ordres traités par ce module (le cœur traite move, attack, stop, stance, produce). */
  orders?: Partial<Record<Order['kind'], OrderHandler>>;
  system?: Partial<Record<SystemCommand['kind'], SystemHandler>>;
  /** Complète la vue d'une nation (sections optionnelles, champs optionnels des unités/provinces). */
  view?(state: EngineState, nation: NationId, view: PlayerView): void;
  /** Complète la vue publique (spectateur) ; ne jamais y mettre de secret. */
  publicView?(state: EngineState, view: PlayerView): void;
  hooks?: ModuleHooks;
}
