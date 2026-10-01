import { DAY, type IntelOpKind, type IntelOpTarget, type NationId } from '@redline/shared';
import type { EngineState } from '../../state/types.js';
import { sortedKeys, warsOf } from '../../state/access.js';
import { board } from '../kit.js';
import { turnable } from './agents.js';
import { hash01, neighborNations } from './levels.js';
import { startOp } from './ops.js';
import { opCost } from './recon.js';
import { nat } from './state.js';

/**
 * IA du renseignement : une décision par jour de jeu et par nation, à une heure propre à chaque nation
 * (étalement), avec parcimonie. Priorités : contre-espionnage (retourner un agent démasqué, balayage
 * quand la nation est menacée), puis reconnaissance militaire de l'ennemi, puis, rarement, une mission
 * chez un voisin. Elle agit exclusivement par les ordres (startOp), comme un joueur.
 */

/** Réserve : l'IA ne dépense que si l'argent couvre ce multiple du coût. */
const RESERVE = 3;

/** Heure de réflexion propre à une nation (étalement sur la journée). */
export function aiOffset(n: NationId): number {
  return Math.floor(hash01('intel-ai', n) * DAY);
}

export function aiThink(state: EngineState, n: NationId): void {
  const ns = state.nations[n];
  if (!ns?.alive || !ns.isAi) return;
  const ni = nat(state, n);
  if (state.time < ni.aiNext) return;
  ni.aiNext = state.time + DAY;
  const wars = warsOf(state, n);
  // Garnisons neutres en paix : pas de service actif.
  if (!ns.active && wars.length === 0) return;
  const tryOp = (kind: IntelOpKind, target: IntelOpTarget, agentId?: string): boolean =>
    ns.money >= opCost(state, kind, target).money * RESERVE &&
    startOp(state, n, kind, target, agentId).ok;

  // 1. Contre-espionnage d'abord.
  const caught = turnable(state, n);
  if (caught.length && tryOp('turn_agent', {}, caught[0]!.id)) return;
  const log = ni.log;
  const incidents = log.sabotage + log.cyber + log.rebels + log.caught + log.strikes;
  ni.log = { sabotage: 0, cyber: 0, rebels: 0, caught: 0, strikes: 0, found: 0 };
  const plans = board(state).warPlans ?? {};
  const targeted = sortedKeys(plans).some((x) => x !== n && plans[x]?.includes(n));
  const day = Math.floor(state.time / DAY);
  const threatened = incidents > 0 || wars.length > 0 || targeted;
  if ((threatened || hash01('ci', n, day) < 0.2) && tryOp('counterintel_sweep', {})) return;

  // 2. Ennemi (guerre en cours ou planifiée) : reconnaissance militaire, puis un agent sur place.
  const enemy = wars[0] ?? (plans[n] ?? []).find((x) => state.nations[x]?.alive);
  if (enemy) {
    if (hash01('rm', n, day) < 0.6 && tryOp('recon_military', { nationId: enemy })) return;
    if (tryOp('infiltrate_spy', { nationId: enemy })) return;
    return;
  }

  // 3. En paix : rarement, une reconnaissance chez un voisin.
  if (hash01('peace', n, day) < 0.15) {
    const nb = neighborNations(state, n);
    const x = nb.length ? nb[Math.floor(hash01('nb', n, day) * nb.length)]! : undefined;
    if (x) tryOp(hash01('ax', n, day) < 0.5 ? 'recon_military' : 'recon_economic', { nationId: x });
  }
}
