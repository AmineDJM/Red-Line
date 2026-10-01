// Rapport de bataille après action sur la vraie partie : une guerre imposée, puis le rapport le plus
// fourni vu par chacun des deux camps (format JSON du contrat BattleReport.aar).
//
//   node bench/run.mjs battle-report            (depuis packages/engine)
//   BR_WAR=rus:ukr BR_HOURS=30 BR_SEED=1 BR_OUT=rapport.json
import { writeFileSync } from 'node:fs';
import { DAY, HOUR, type NationId } from '@redline/shared';
import { advanceTo, applyOrder, battleReportFor, buildWorld, createGame } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { mil } from '../src/modules/mil/state.js';
import { loadRealData } from './load.js';

const env = process.env;
const [A, B] = (env.BR_WAR ?? 'rus:ukr').split(':') as [NationId, NationId];
const HOURS = Number(env.BR_HOURS ?? 30);
const data = loadRealData();
const world = buildWorld(data.map, data.catalog, data.balance, {
  research: data.research,
  orbats: data.orbats,
});
const s = createGame(world, {
  seed: Number(env.BR_SEED ?? 1),
  players: [{ nationId: 'fra', isAi: false }],
  aiLevel: 'normal',
  scenario: data.scenario,
  speed: 1,
}) as EngineState;
advanceTo(s, DAY);
applyOrder(s, A, { kind: 'declareWar', nationId: B });
advanceTo(s, DAY + HOURS * HOUR);
const m = mil(s);
const ids = Object.keys(m.battles)
  .filter((id) => {
    const b = m.battles[id]!;
    return b.end !== null && b.x && [...b.a.nations, ...b.d.nations].includes(A);
  })
  .sort((x, y) => {
    const n = (id: string) => Object.keys(m.battles[id]!.units).length;
    return n(y) - n(x) || (x < y ? -1 : 1);
  });
console.log(`${ids.length} batailles closes ; la plus fournie : ${ids[0]}`);
const out: Record<string, unknown> = {};
for (const n of [A, B]) {
  const r = battleReportFor(s, n, ids[0]!);
  if (!r?.aar) continue;
  out[n] = r;
  const a = r.aar;
  console.log(`\n— vu par ${n} : ${r.title} (${a.place.domain}, ${a.result.verdict})`);
  for (const sd of a.sides) {
    console.log(
      `  ${sd.side} ${sd.nations.join(',')} ${sd.own ? 'exact' : `estimé ${sd.grade?.source}${sd.grade?.credibility}`}` +
        ` personnels ${sd.totals.personnel.best} véhicules ${sd.totals.vehicles.best} aéronefs ${sd.totals.aircraft.best}` +
        ` | tués ${sd.casualties.killed.best} blessés ${sd.casualties.wounded.best} disparus ${sd.casualties.missing.best} prisonniers ${sd.casualties.prisoners.best}` +
        ` | détruits ${sd.materiel.destroyed.min}-${sd.materiel.destroyed.max} missiles ${sd.missiles.launched.best}`,
    );
    for (const f of sd.forces.slice(0, 8))
      console.log(
        `    ${f.systemId ?? `? (${f.medium})`} engagés ${f.engaged.min}-${f.engaged.max} détruits ${f.destroyed.best} endommagés ${f.damaged.best}`,
      );
  }
  console.log('  phases', a.phases.map((p) => `${p.kind}:${p.side}`).join(' → '));
  console.log('  facteurs', a.factors.map((f) => `${f.kind}(${f.side}${f.positive ? '+' : '−'})`).join(' '));
}
if (env.BR_OUT) writeFileSync(env.BR_OUT, JSON.stringify(out, null, 1));
