import { atWar, sortedSet, sysOf } from '../../state/access.js';
import type { EngineState, Unit } from '../../state/types.js';
import { CAPTURE_RADIUS_KM } from '../../state/world.js';
import { cityOf, generic, noteLoc, placeOf } from './util.js';

/**
 * Explication d'une capture impossible, à l'arrivée d'une pile terrestre sur le point de capture d'une
 * province étrangère : pile sans unité capable de capturer (artillerie, défense antiaérienne, radars…),
 * ou nation avec laquelle on n'est pas en guerre (droit de passage d'un allié). Le joueur sait pourquoi
 * la province ne change pas de mains.
 */
export function captureHint(state: EngineState, u: Unit): void {
  if (u.role || u.off) return;
  const s = sysOf(state, u);
  if (s.movement !== 'land') return;
  for (const key of sortedSet(state.rt.pairsOf.get(u.id))) {
    const h = key.indexOf('#');
    if (h < 0) continue;
    const pair = state.pairs[key];
    if (!pair || pair.d > CAPTURE_RADIUS_KM) continue;
    const pid = key.slice(0, h);
    const P = state.provinces[pid];
    if (!P || P.owner === u.owner) continue;
    const why = !s.canCapture ? 'noCapturer' : !atWar(state, u.owner, P.owner) ? 'noWar' : null;
    if (!why) return;
    generic(
      state,
      [u.owner],
      'capture',
      'Capture impossible',
      why === 'noCapturer'
        ? `${s.name} ne peut pas capturer de province : il faut de l'infanterie ou des blindés.`
        : `Pas de guerre avec le propriétaire de cette province : pas de capture.`,
      'warn',
      cityOf(state, pid),
      noteLoc('captureBlocked', { system: { system: u.sys }, place: placeOf(pid) }, why),
    );
    return;
  }
}
