// Vérifie le déterminisme du VRAI moteur sur la partie monde, tel que le serveur l'utilise :
//   A. avance événement par événement (+ instants intermédiaires) vs avance d'un seul advanceTo ;
//   B. état vivant vs état sérialisé puis désérialisé (reprise sur instantané).
//   pnpm --filter @redline/server exec tsx scripts/determinism-check.ts [heures=6]
import { join } from 'node:path';
import pino from 'pino';
import * as E from '@redline/engine';
import { loadGameData } from '../src/data/loader.js';
import { REPO_ROOT } from '../src/paths.js';

const HOUR = 3_600_000;
const hours = Number(process.argv[2] ?? 6);
const data = await loadGameData(join(REPO_ROOT, 'data'), pino({ level: 'warn' }) as never);
const scenario = data.scenarios.find((s) => s.id === 'world-today')!;
const world = E.buildWorld(data.map!, data.repoCatalog, data.balance!, {
  research: data.research,
  orbats: data.orbats,
});
const nations = data.map!.nations.map((n) => n.id);
const mk = () =>
  E.createGame(world, {
    seed: 99,
    players: nations.map((n) => ({ nationId: n, isAi: n !== 'fra' && n !== 'usa' })),
    scenario,
    speed: 1,
  });

const base = mk();
const clone = () => E.deserializeState(world, E.serializeState(base));
const fresh = mk();
console.log('création identique :', E.stateHash(fresh) === E.stateHash(base));
console.log('instantané fidèle   :', E.stateHash(clone()) === E.stateHash(base));

const T = hours * HOUR;
const coarse = (s: E.GameState) => E.advanceTo(s, T);
const fine = (s: E.GameState) => {
  let k = 0;
  for (;;) {
    const next = E.nextEventTime(s);
    if (next === null || next > T) break;
    E.advanceTo(s, Math.max(next, s.time));
    // Instants intermédiaires arbitraires (ticks de l'ordonnanceur, diffusions, changements de jour).
    if (++k % 7 === 0) E.advanceTo(s, Math.min(T, s.time + 1234));
  }
  E.advanceTo(s, T);
};

const a = mk();
coarse(a);
const b = mk();
fine(b);
console.log(`A. pas fins vs un seul pas (${hours} h) :`, E.stateHash(a) === E.stateHash(b));

const c = mk();
fine(c);
const d = clone();
fine(d);
console.log(`B. vivant vs désérialisé (${hours} h)   :`, E.stateHash(c) === E.stateHash(d));
const e = clone();
coarse(e);
console.log(`C. désérialisé, un seul pas            :`, E.stateHash(e) === E.stateHash(a));

// D. Les vues (viewFor, publicView) ne doivent pas modifier l'état.
const f = mk();
const h0 = E.stateHash(f);
E.viewFor(f, 'fra');
E.publicView(f);
console.log('D. viewFor sans effet sur l’état       :', E.stateHash(f) === h0);
const g1 = mk();
const g2 = mk();
for (let hh = 1; hh <= hours; hh++) {
  E.advanceTo(g1, hh * HOUR);
  E.advanceTo(g2, hh * HOUR);
  for (const n of nations) E.notificationsFor(g2, n, E.advanceTo(g2, g2.time));
  for (const n of nations) E.viewFor(g2, n);
  E.publicView(g2);
  E.ownersFrame(g2);
  E.stats(g2);
}
console.log('E. vues (201 nations) sans effet       :', E.stateHash(g1) === E.stateHash(g2));
const o1 = mk();
const o2 = mk();
E.advanceTo(o1, HOUR);
E.advanceTo(o2, HOUR);
const own = Object.values(E.viewFor(o1, 'fra').units).filter((u) => u.level === 'own');
const order = { kind: 'move' as const, unitIds: [own[0]!.id], to: [3, 47] as [number, number] };
console.log('ordre', E.applyOrder(o1, 'fra', order).ok, E.applyOrder(o2, 'fra', order).ok);
fine(o1);
coarse(o2);
console.log('F. ordre puis pas fins vs un seul pas  :', E.stateHash(o1) === E.stateHash(o2));

/** Premier écart entre deux états (chemin de la valeur). */
function firstDiff(x: unknown, y: unknown, path = ''): string | null {
  if (x === y) return null;
  if (typeof x !== 'object' || typeof y !== 'object' || !x || !y) {
    return `${path} : ${JSON.stringify(x)?.slice(0, 120)} ≠ ${JSON.stringify(y)?.slice(0, 120)}`;
  }
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of [...keys].sort()) {
    const d = firstDiff(
      (x as Record<string, unknown>)[k],
      (y as Record<string, unknown>)[k],
      `${path}.${k}`,
    );
    if (d) return d;
  }
  return null;
}
const { decodeMessage: decode } = await import('@redline/shared');
const dump = (s: E.GameState) => decode(E.serializeState(s));
console.log('   écart F :', firstDiff(dump(o1), dump(o2)));
const f2 = mk();
console.log('   écart D :', firstDiff(dump(f2), dump(f)));
