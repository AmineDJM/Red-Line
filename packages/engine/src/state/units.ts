import { callHook } from '../modules/registry.js';
import type { LngLat, NationId, UnitId } from '@redline/shared';
import { refreshUnitPairs } from '../encounters/pairs.js';
import { addToIndex } from './runtime.js';
import type { EngineState, Unit } from './types.js';

/**
 * Crée une unité immobile à une position, l'indexe et calcule ses paires. `init` permet de fixer des
 * champs particuliers (rôle, hors carte) AVANT l'indexation et le calcul des paires.
 */
export function spawnUnit(
  state: EngineState,
  owner: NationId,
  systemId: string,
  pos: LngLat,
  count?: number,
  init?: (u: Unit) => void,
): Unit {
  const sys = state.world.catalog.get(systemId);
  if (!sys) throw new Error(`système inconnu : ${systemId}`);
  const n = Math.max(1, Math.floor(count ?? sys.unitSize));
  const id: UnitId = `u${++state.nextUnit}`;
  const u: Unit = {
    id,
    owner,
    sys: systemId,
    count: n,
    hp: n * sys.hp,
    maxHp: n * sys.hp,
    xp: 0,
    pos: [pos[0], pos[1]],
    move: null,
    mv: 0,
    leg: 0,
    cross: null,
    stance: 'defend',
    target: null,
    tmode: null,
    chasing: false,
    chaseEv: 0,
    engaged: false,
    cv: 0,
    lastHit: -1,
  };
  init?.(u);
  state.units[id] = u;
  addToIndex(state.rt.byNation, owner, id);
  if (sys.ew.jamming > 0) addToIndex(state.rt.jammers, owner, id);
  refreshUnitPairs(state, u);
  state.rt.dirtyCombat.add(id);
  callHook('onUnitSpawned', state, u);
  return u;
}
