import { distanceKm, type LngLat, type NationId, type Order } from '@redline/shared';
import type { OrderResult } from '../../api.js';
import { destroyUnit } from '../../combat/combat.js';
import { sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { board } from '../kit.js';
import { signal } from '../registry.js';
import { raiseAlert, thresholds, setTensionAtLeast } from './alert.js';
import { battleFor, countermeasure, timeline, touch } from './battles.js';
import { mil, milBal, type MissileSt } from './state.js';
import { countLoss } from './stats.js';
import { damageUnit, hitBuilding } from './strike.js';
import {
  OK,
  buildingsOf,
  cityOf,
  fail,
  generic,
  nameOfProvince,
  posOf,
  provinceAt,
  provincesNear,
  unitsNear,
} from './util.js';

/**
 * Nucléaire. L'emploi exige une autorisation explicite (ordre `nuclearAuth`, board.nuclearAuth),
 * possible seulement quand le niveau d'alerte mondial est ≤ military.nuclear.maxAlertForAuth (3),
 * et une frappe n'est permise qu'à un niveau ≤ maxAlertForStrike (2). Détonation : tout est détruit
 * dans le rayon (fiche `missile.blastKm`, au moins minBlastKm), dégâts partiels dans l'anneau
 * (ringFactor × rayon), bâtiments des provinces touchées détruits ; signaux nuclear_detonation,
 * strike, alert, news, stability ; alerte mondiale portée au niveau 1.
 */

export function orderNuclearAuth(
  state: EngineState,
  n: NationId,
  o: Extract<Order, { kind: 'nuclearAuth' }>,
): OrderResult {
  const b = board(state);
  if (!o.on) {
    delete b.nuclearAuth[n];
    generic(state, [n], 'nuclear', 'Autorisation nucléaire levée', 'Les forces nucléaires reviennent au contrôle normal.', 'info');
    return OK;
  }
  if (b.nuclearAuth[n]) return OK;
  const max = milBal(state).nuclear.maxAlertForAuth;
  if (b.alertLevel > max) {
    return fail('locked', `Niveau d'alerte ${b.alertLevel} : autorisation impossible (niveau ${max} ou plus grave requis).`);
  }
  b.nuclearAuth[n] = true;
  raiseAlert(state, milBal(state).tension.nuclearAuth, 'nuclear_auth');
  generic(
    state,
    [n],
    'nuclear',
    'Emploi du nucléaire autorisé',
    'Les frappes nucléaires sont possibles tant que le niveau d’alerte le permet.',
    'critical',
  );
  return OK;
}

export function detonate(state: EngineState, M: Unit, at: LngLat, st: MissileSt): void {
  const bal = milBal(state).nuclear;
  const sys = sysOf(state, M);
  const blast = Math.max(sys.missile?.blastKm ?? 0, bal.minBlastKm);
  const ring = blast * bal.ringFactor;
  const pid = provinceAt(state, at);
  const victim = (pid ? state.provinces[pid]!.owner : null) ?? st.victim;
  const b = victim ? battleFor(state, M.owner, victim, at) : null;
  let destroyed = 0;
  for (const u of unitsNear(state, at, ring)) {
    if (u === M || !state.units[u.id]) continue;
    const d = distanceKm(posOf(state, u), at);
    if (d <= blast) {
      destroyed += u.role ? 0 : u.count;
      countLoss(state, u, u.count, M);
      destroyUnit(state, u, M);
    } else {
      damageUnit(state, M, u, u.hp * bal.ringDamage);
    }
  }
  // Aéronefs embarqués : détruits avec leur porteur (crochet onUnitDestroyed).
  for (const p of provincesNear(state, at, ring)) {
    const d = distanceKm(cityOf(state, p)!, at);
    const dmg = d <= blast ? 1 : bal.ringDamage;
    for (const bld of buildingsOf(state, p)) hitBuilding(state, p, bld, dmg, M);
  }
  if (b) {
    countermeasure(b, 'nuclear', 1);
    timeline(state, b, `Détonation nucléaire à ${nameOfProvince(state, pid)} : ${destroyed} éléments anéantis`);
    touch(state, b);
  }
  const where = nameOfProvince(state, pid);
  signal(state, 'nuclear_detonation', { by: M.owner, victim, at, pid });
  signal(state, 'strike', { by: M.owner, victim, at, kind: 'missile', nuclear: true });
  raiseAlert(state, milBal(state).tension.nuclear, 'nuclear');
  setTensionAtLeast(state, thresholds(state)[3]!);
  signal(state, 'news', {
    category: 'nuclear',
    headline: `Détonation nucléaire à ${where}`,
    body: `Une arme nucléaire tirée par ${M.owner.toUpperCase()} a explosé à ${where}.`,
    at,
    nations: victim ? [M.owner, victim] : [M.owner],
  });
  if (victim) signal(state, 'stability', { nation: victim, delta: bal.stabilityVictim, reason: 'nuclear' });
  signal(state, 'stability', { nation: M.owner, delta: bal.stabilityStriker, reason: 'nuclear' });
  for (const n of state.nationIds) {
    if (n === victim || n === M.owner) continue;
    signal(state, 'stability', { nation: n, delta: bal.stabilityWorld, reason: 'nuclear_world' });
  }
  generic(state, null, 'nuclear', 'Détonation nucléaire', `Frappe nucléaire à ${where}.`, 'critical', at);
  void mil;
}
