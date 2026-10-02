import type { FeatureCollection } from 'geojson';
import type {
  PublicStats,
  BattleReport,
  CosmeticItem,
  CreateGameBody,
  CreateLobbyBody,
  GameMeta,
  GameStatsView,
  LegalDoc,
  LegalDocRef,
  LobbyGame,
  MyGame,
  NationDef,
  NationId,
  NationInfo,
  ProvinceDef,
  PublicUser,
  RankingEntry,
  ResearchNode,
  Balance,
  ScenarioSummary,
  SeasonView,
  ResourceBuyResult,
  ResourceOffer,
  ShopPack,
  TimelapseView,
  WalletEntry,
  WeaponSystem,
  RoutesFile,
} from '@redline/shared';

export interface TilesInfo {
  satellite: string;
  maxzoom: number;
}

/** Fond vectoriel (chaque couche est facultative : absente = non affichée). */
export interface BasemapData {
  /** Terres émergées (polygones). */
  land: FeatureCollection | null;
  /** Traits de côte (lignes). */
  coastline: FeatureCollection | null;
  /** Étiquettes des mers (points : name, rank, minzoom). */
  seas: FeatureCollection | null;
  /** Points d'étiquette des pays (points : id, name, rank, minzoom). */
  countries: FeatureCollection | null;
  /** Villes (points : name, rank, minzoom, capital, nation). */
  cities: FeatureCollection | null;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput extends Credentials {
  displayName: string;
}

/** Accès aux données REST (serveur réel ou fixtures du mode ?mock=1). */
export interface Api {
  readonly kind: 'http' | 'mock';
  me(): Promise<PublicUser | null>;
  guest(): Promise<PublicUser>;
  login(body: Credentials): Promise<PublicUser>;
  register(body: RegisterInput): Promise<PublicUser>;
  logout(): Promise<void>;
  catalog(): Promise<WeaponSystem[]>;
  nations(): Promise<NationDef[]>;
  provinces(): Promise<ProvinceDef[]>;
  provincesGeoJSON(): Promise<FeatureCollection>;
  /** Réseau de routes des unités terrestres (GET /api/map/routes), null si indisponible. */
  routes?(): Promise<RoutesFile | null>;
  tiles(): Promise<TilesInfo | null>;
  basemap(): Promise<BasemapData>;
  /** Vrai si les glyphes MapLibre sont servis. */
  glyphsAvailable(): Promise<boolean>;
  scenarios(): Promise<ScenarioSummary[]>;
  createGame(body: CreateGameBody): Promise<GameMeta>;
  game(id: string): Promise<{ game: GameMeta; me: NationId }>;

  // ——— Phases 2+ (données statiques) ———
  /** Arbre technologique (GET /api/research, repli : data/research embarqué). */
  researchNodes(): Promise<ResearchNode[]>;
  /** Équilibrage (défaut : data/balance embarqué). La démo y ajoute les coûts de construction. */
  balance?(): Promise<Balance | null>;
  /** Fiches nations de l'écran de sélection (GET /api/nations/info). */
  nationsInfo(): Promise<NationInfo[]>;

  // ——— Phase 5 : multijoueur ———
  myGames(): Promise<MyGame[]>;
  /** Suppression définitive d'une partie solo (créateur uniquement). */
  deleteGame(id: string): Promise<void>;
  lobby(): Promise<LobbyGame[]>;
  createLobby(body: CreateLobbyBody): Promise<GameMeta>;
  joinLobby(id: string, nationId: NationId): Promise<GameMeta>;
  /** Salon multijoueur (salle d'attente). */
  lobbyGame(id: string): Promise<LobbyGame>;
  leaveLobby(id: string): Promise<void>;
  startLobby(id: string): Promise<GameMeta>;
  spectate(id: string): Promise<GameMeta>;
  stats(id: string): Promise<GameStatsView>;
  timelapse(id: string): Promise<TimelapseView>;
  battleReport(gameId: string, reportId: string): Promise<BattleReport>;
  /** Clé VAPID publique (null si le serveur ne propose pas Web Push). */
  pushKey(): Promise<string | null>;
  pushSubscribe(sub: PushSubscriptionJSON): Promise<void>;
  pushUnsubscribe(): Promise<void>;

  // ——— Phase 6 : boutique, classements, légal ———
  shopPacks(): Promise<ShopPack[]>;
  wallet(): Promise<{ balance: number; history: WalletEntry[]; unlimited?: boolean }>;
  checkout(packId: string): Promise<{ url: string }>;
  accelerate(
    gameId: string,
    target: { type: 'production' | 'research' | 'build' | 'repair'; id: string },
    hours: number,
  ): Promise<{ ok: boolean; balance: number; unlimited?: boolean }>;
  cosmetics(): Promise<{ items: CosmeticItem[]; owned: string[] }>;
  /** Offres de ressources en jeu (monnaie premium → dollars du jeu et ressources). */
  resourceOffers(): Promise<ResourceOffer[]>;
  /** Achat d'une offre de ressources dans une partie en cours (politique de la partie). */
  buyResources(gameId: string, offerId: string): Promise<ResourceBuyResult>;
  buyCosmetic(id: string): Promise<{ ok: boolean; balance: number }>;
  rankings(season?: string): Promise<{ season: SeasonView; entries: RankingEntry[] }>;
  seasons(): Promise<SeasonView[]>;
  /** Document légal ; `lang` : traduction si elle est à jour (la version française fait foi). */
  legal(doc: LegalDocRef['id'], lang?: string): Promise<LegalDoc>;
  /** Chiffres publics de l'accueil (parties en cours, joueurs en ligne). */
  publicStats(): Promise<PublicStats>;
  acceptLegal(docs: LegalDocRef[]): Promise<void>;
  /** Documents légaux à (re)accepter (champ `legal` de GET /api/me). */
  legalPending(): Promise<LegalDocRef[]>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
