import { decode, encode } from '@msgpack/msgpack';
import type { World } from '../api.js';
import { addToIndex } from './runtime.js';
import { STATE_FORMAT, type EngineState, type StateData } from './types.js';
import { attachState } from './create.js';
import { registerProvinceZone, registerUnit } from '../encounters/pairs.js';
import { sortedKeys } from './access.js';

const DATA_KEYS: (keyof StateData)[] = [
  'fmt',
  'time',
  'setup',
  'rng',
  'seq',
  'nextUnit',
  'nextProd',
  'queue',
  'nationIds',
  'nations',
  'provinces',
  'totalProvinces',
  'units',
  'wars',
  'pairs',
  'sight',
  'know',
  'pending',
  'winner',
];

/** MessagePack canonique (clés triées) de tout l'état, hors monde et index dérivés. */
export function serializeImpl(state: EngineState): Uint8Array {
  const data: Record<string, unknown> = {};
  for (const k of DATA_KEYS) data[k] = state[k];
  return encode(data, { sortKeys: true, ignoreUndefined: true });
}

export function deserializeImpl(world: World, bytes: Uint8Array): EngineState {
  const data = decode(bytes) as StateData;
  if (!data || data.fmt !== STATE_FORMAT) throw new Error('format d’état inconnu');
  const state = attachState(world, data);
  rebuildRuntime(state);
  return state;
}

/** Reconstruit les index dérivés à partir des données (ordre trié, donc indépendant de l'historique). */
export function rebuildRuntime(state: EngineState): void {
  const rt = state.rt;
  for (const pid of sortedKeys(state.provinces)) registerProvinceZone(state, pid);
  for (const uid of sortedKeys(state.units)) {
    const u = state.units[uid]!;
    addToIndex(rt.byNation, u.owner, uid);
    if (u.target) addToIndex(rt.chasers, u.target, uid);
    registerUnit(state, u);
  }
  for (const key of sortedKeys(state.pairs)) {
    const h = key.indexOf('#');
    if (h >= 0) {
      addToIndex(rt.pairsOf, `p:${key.slice(0, h)}`, key);
      addToIndex(rt.pairsOf, key.slice(h + 1), key);
    } else {
      const [a, b] = key.split('|') as [string, string];
      addToIndex(rt.pairsOf, a, key);
      addToIndex(rt.pairsOf, b, key);
    }
  }
}

/** FNV-1a 64 bits (en hexadécimal) calculé sur 4 mots de 16 bits. */
export function fnv1a64(bytes: Uint8Array): string {
  let a0 = 0x2325;
  let a1 = 0x8422;
  let a2 = 0x9ce4;
  let a3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    a0 ^= bytes[i]!;
    // h × 0x100000001b3 = h × 0x1b3 + (h << 40)  (mod 2^64)
    const t0 = a0 * 0x1b3;
    const t1 = a1 * 0x1b3 + (t0 >>> 16);
    const t2 = a2 * 0x1b3 + (t1 >>> 16) + ((a0 & 0xff) << 8);
    const t3 = a3 * 0x1b3 + (t2 >>> 16) + (a0 >>> 8) + ((a1 & 0xff) << 8);
    a0 = t0 & 0xffff;
    a1 = t1 & 0xffff;
    a2 = t2 & 0xffff;
    a3 = t3 & 0xffff;
  }
  const hex = (x: number): string => x.toString(16).padStart(4, '0');
  return hex(a3) + hex(a2) + hex(a1) + hex(a0);
}

export function stateHashImpl(state: EngineState): string {
  return fnv1a64(serializeImpl(state));
}
