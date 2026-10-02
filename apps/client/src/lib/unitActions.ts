/**
 * Actions de commandement d'une sélection d'unités (panneau de sélection, « Mes armées ») : seules
 * les actions valides sont actives, les autres sont grisées avec la raison (clé de traduction).
 * Logique pure, testée dans test/unitActions.test.ts ; le moteur reste seul juge (refus motivé).
 */
import {
  distanceKm,
  strikeRangeKm,
  type LngLat,
  type Order,
  type SystemId,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';

export type UnitActionId =
  | 'move'
  | 'attack'
  | 'strike'
  | 'intercept'
  | 'patrol'
  | 'recon'
  | 'blockade'
  | 'escort'
  | 'embark'
  | 'disembark'
  | 'rtb'
  | 'stop';

export interface UnitAction {
  id: UnitActionId;
  /** Touche de raccourci (ordinateur). */
  key: string;
  icon: string;
  enabled: boolean;
  /** Clé de traduction de la raison (action grisée). */
  reason?: string;
  /** Variante de libellé (retour à la base / au port / ravitaillement). */
  label?: string;
  /** Unités concernées (celles qui peuvent exécuter l'action). */
  unitIds: UnitId[];
  /** Embarquer : navires de transport amis à portée, du plus proche au plus éloigné. */
  transportIds?: UnitId[];
  /** Action sans objet pour cette sélection : non affichée (embarquer, débarquer). */
  hidden?: boolean;
}

/** Contexte facultatif : toutes les unités vues (navires de transport proches), équilibrage. */
export interface ActionContext {
  units?: Record<UnitId, UnitView>;
  /** Distance maximale pile ↔ navire pour embarquer (balance.military.transport.embarkKm). */
  embarkKm?: number;
}

/** Distance d'embarquement par défaut (km), si l'équilibrage n'en donne pas. */
export const DEFAULT_EMBARK_KM = 60;

const AIR_CLASSES = ['aircraft', 'helicopter', 'drone'] as const;

function isMunition(s: WeaponSystem): boolean {
  return !!s.missile;
}
function isFlyer(s: WeaponSystem): boolean {
  return s.movement === 'air' && !s.missile && s.category !== 'space';
}
function isStatic(s: WeaponSystem): boolean {
  return s.movement === 'static' || s.speedKmh <= 0 || s.category === 'space';
}
function canAttack(s: WeaponSystem): boolean {
  if (isMunition(s)) return true;
  return s.weaponRangeKm.max > 0 && Object.values(s.damage).some((d) => d > 0);
}
function canStrike(s: WeaponSystem): boolean {
  if (isMunition(s)) return true;
  if ((s.naval?.launchCells ?? 0) > 0) return true;
  return isFlyer(s) && (s.damage.building > 0 || s.damage.armor > 0 || s.damage.infantry > 0);
}
/** Interception : chasseurs (cibles aériennes) et défenses antiaériennes (tout ce qui vole). */
function canIntercept(s: WeaponSystem): boolean {
  if (s.interceptor && !isMunition(s) && s.weaponRangeKm.max > 0) return true;
  return isFlyer(s) && AIR_CLASSES.some((c) => s.damage[c] > 0);
}
/** Pile capable d'escorter : mobile, armée (ni munition, ni satellite). */
export function canEscortSys(s: WeaponSystem): boolean {
  if (isMunition(s) || isStatic(s)) return false;
  return s.weaponRangeKm.max > 0 && Object.values(s.damage).some((d) => d > 0);
}
/** Navire capable de transporter des troupes (catalogue : payload.transport). */
export function isTransportSys(s: WeaponSystem): boolean {
  return s.movement === 'sea' && (s.payload?.transport ?? 0) > 0;
}
function canRecon(s: WeaponSystem): boolean {
  return (
    isFlyer(s) &&
    (s.category === 'drone' ||
      s.roles.some((r) => /recon|isr|surveillance/.test(r)) ||
      s.sensor?.kind === 'optical')
  );
}

/** Éléments d'une pile (pile mixte : par matériel). */
function partsOfView(u: UnitView): { systemId: SystemId; count: number }[] {
  if (u.parts?.length) return u.parts;
  return u.systemId ? [{ systemId: u.systemId, count: u.count ?? 1 }] : [];
}

/** La pile compte-t-elle au moins un élément capable de capturer une province ? */
export function canCaptureUnit(u: UnitView, catalog: Record<SystemId, WeaponSystem>): boolean {
  return partsOfView(u).some((p) => !!catalog[p.systemId]?.canCapture);
}

/** Places occupées à bord d'un navire de transport (balance.military.transport). */
export function placesOfUnit(
  u: UnitView,
  catalog: Record<SystemId, WeaponSystem>,
  places: Record<string, number> | undefined,
  defaultPlaces = 3,
): number {
  let n = 0;
  for (const p of partsOfView(u)) {
    const cat = catalog[p.systemId]?.category ?? '';
    n += p.count * (places?.[cat] ?? defaultPlaces);
  }
  return n;
}

/** Portée utile (km) d'une pile pour l'aperçu : frappe (munitions), rayon d'action, arme. */
export function usefulRangeKm(s: WeaponSystem): number {
  if (isMunition(s)) return strikeRangeKm(s);
  if (isFlyer(s) && s.operationalRadiusKm) return s.operationalRadiusKm;
  return s.weaponRangeKm.max;
}

/** Actions pour une sélection d'unités du joueur. */
export function unitActions(
  units: UnitView[],
  catalog: Record<SystemId, WeaponSystem>,
  ctx: ActionContext = {},
): UnitAction[] {
  const own = units.filter((u) => u.level === 'own' && u.systemId && catalog[u.systemId]);
  const aboard = (u: UnitView) => !!u.transportId || u.status === 'embarked';
  const sysOf = (u: UnitView) => catalog[u.systemId!]!;
  const pick = (f: (s: WeaponSystem, u: UnitView) => boolean) =>
    own.filter((u) => f(sysOf(u), u)).map((u) => u.id);
  const mobile = pick((s) => !isStatic(s) && !isMunition(s));
  const attackers = pick(canAttack);
  const strikers = pick(canStrike);
  const interceptors = pick(canIntercept);
  const air = pick((s) => isFlyer(s));
  const sea = pick((s) => s.movement === 'sea');
  const recon = pick(canRecon);
  const escorts = pick((s, u) => canEscortSys(s) && !aboard(u) && !u.loading);
  // Embarquer : piles terrestres mobiles, à terre, près d'un navire de transport ami à l'arrêt.
  const land = pick((s, u) => s.movement === 'land' && !isStatic(s) && !aboard(u) && !u.loading);
  const reach = ctx.embarkKm ?? DEFAULT_EMBARK_KM;
  const near: { id: UnitId; d: number }[] = [];
  if (land.length && ctx.units) {
    const spots: LngLat[] = own.filter((u) => land.includes(u.id) && !u.move).map((u) => u.pos);
    for (const o of Object.values(ctx.units)) {
      const s = o.level === 'own' && o.systemId ? catalog[o.systemId] : undefined;
      if (!s || !isTransportSys(s) || o.move) continue;
      const d = Math.min(...spots.map((p) => distanceKm(p, o.pos)));
      if (d <= reach) near.push({ id: o.id, d });
    }
    near.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  }
  const transports = pick((s) => isTransportSys(s));
  const loaded = own.filter((u) => (u.cargo?.unitIds.length ?? 0) > 0).map((u) => u.id);
  const busy = own
    .filter(
      (u) =>
        u.status === 'moving' ||
        u.status === 'combat' ||
        (u.mission && u.mission.kind !== 'none') ||
        !!u.targetId,
    )
    .map((u) => u.id);
  const domains = new Set(own.map((u) => sysOf(u).movement));
  const rtbLabel =
    domains.size === 1 && domains.has('air')
      ? 'rtbAir'
      : domains.size === 1 && domains.has('sea')
        ? 'rtbSea'
        : domains.size === 1 && domains.has('land')
          ? 'resupply'
          : 'rtb';
  const a = (
    id: UnitActionId,
    key: string,
    icon: string,
    ids: UnitId[],
    reason: string,
    label?: string,
  ): UnitAction => ({
    id,
    key,
    icon,
    enabled: ids.length > 0,
    unitIds: ids,
    ...(ids.length ? {} : { reason }),
    ...(label ? { label } : {}),
  });
  return [
    a('move', 'M', 'arrowRight', mobile, 'static'),
    a('attack', 'A', 'target', attackers, 'noWeapon'),
    a('strike', 'F', 'missile', strikers, 'noStrike'),
    a('intercept', 'I', 'shield', interceptors, 'noIntercept'),
    a('patrol', 'P', 'radio', [...air, ...sea], 'airSeaOnly'),
    a('recon', 'V', 'eye', recon, 'noRecon'),
    a('blockade', 'B', 'anchor', sea, 'seaOnly'),
    a('escort', 'E', 'users', escorts, 'noEscort'),
    {
      ...a('embark', 'K', 'box', near.length ? land : [], land.length ? 'noTransport' : 'noLand'),
      ...(near.length ? { transportIds: near.map((x) => x.id) } : {}),
      hidden: !land.length || !near.length,
    },
    { ...a('disembark', 'D', 'arrowDown', loaded, 'noCargo'), hidden: !transports.length },
    a('rtb', 'R', 'home', mobile, 'static', rtbLabel),
    a('stop', 'S', 'stop', busy, 'idle'),
  ];
}

/** Ordre direct (sans ciblage) d'une action, sinon null (ciblage sur la carte nécessaire). */
export function directOrder(action: UnitAction): Order | null {
  if (action.id === 'rtb') return { kind: 'rtb', unitIds: action.unitIds };
  if (action.id === 'stop') return { kind: 'stop', unitIds: action.unitIds };
  // Un seul navire de transport à portée : embarquement direct.
  if (action.id === 'embark' && action.transportIds?.length === 1)
    return { kind: 'embark', unitIds: action.unitIds, transportId: action.transportIds[0]! };
  return null;
}
