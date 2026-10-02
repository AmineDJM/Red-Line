/**
 * Actions de commandement d'une sélection d'unités (panneau de sélection, « Mes armées ») : seules
 * les actions valides sont actives, les autres sont grisées avec la raison (clé de traduction).
 * Logique pure, testée dans test/unitActions.test.ts ; le moteur reste seul juge (refus motivé).
 */
import {
  strikeRangeKm,
  type Order,
  type SystemId,
  type UnitId,
  type UnitView,
  type WeaponSystem,
} from '@redline/shared';

export type UnitActionId =
  'move' | 'attack' | 'strike' | 'intercept' | 'patrol' | 'recon' | 'blockade' | 'rtb' | 'stop';

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
}

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
function canRecon(s: WeaponSystem): boolean {
  return (
    isFlyer(s) &&
    (s.category === 'drone' ||
      s.roles.some((r) => /recon|isr|surveillance/.test(r)) ||
      s.sensor?.kind === 'optical')
  );
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
): UnitAction[] {
  const own = units.filter((u) => u.level === 'own' && u.systemId && catalog[u.systemId]);
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
    a('rtb', 'R', 'home', mobile, 'static', rtbLabel),
    a('stop', 'S', 'stop', busy, 'idle'),
  ];
}

/** Ordre direct (sans ciblage) d'une action, sinon null (ciblage sur la carte nécessaire). */
export function directOrder(action: UnitAction): Order | null {
  if (action.id === 'rtb') return { kind: 'rtb', unitIds: action.unitIds };
  if (action.id === 'stop') return { kind: 'stop', unitIds: action.unitIds };
  return null;
}
