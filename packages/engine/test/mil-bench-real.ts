// Banc d'essai hors suite (vraie carte + vrai catalogue, armée synthétique de 12 piles par nation) :
//   cd packages/engine && npx tsx test/mil-bench-real.ts        (CALM=1 : journée calme seulement)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BalanceSchema,
  CatalogFileSchema,
  CellsFileSchema,
  DAY,
  HOUR,
  NationDefSchema,
  ProvinceDefSchema,
  StraitSchema,
  destination,
  type MapData,
  type WeaponSystem,
} from '@redline/shared';
import { advanceTo, applyOrder, buildWorld, createGame, stats, viewFor } from '../src/index.js';
import type { EngineState } from '../src/state/types.js';
import { nextFloat, seedRng } from '../src/rng/rng.js';

const root = join(process.cwd(), '../../data');
const j = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const map: MapData = {
  nations: (j('map/nations.json').nations ?? j('map/nations.json')).map((x: unknown) =>
    NationDefSchema.parse(x),
  ),
  provinces: (j('map/provinces.json').provinces ?? j('map/provinces.json')).map((x: unknown) =>
    ProvinceDefSchema.parse(x),
  ),
  cells: CellsFileSchema.parse(j('map/cells.json')),
  straits: (j('map/straits.json').straits ?? j('map/straits.json')).map((x: unknown) =>
    StraitSchema.parse(x),
  ),
  disputed: [],
};
const catalog: WeaponSystem[] = [];
for (const f of readdirSync(join(root, 'catalog')).sort()) {
  if (f.endsWith('.json')) catalog.push(...CatalogFileSchema.parse(j(`catalog/${f}`)).systems);
}
const bal = BalanceSchema.parse(j('balance/default.json'));
const army = [
  { systemId: 'other.infantry-light', count: 2 },
  { systemId: 'eu.leopard-2a7', count: 1 },
  { systemId: 'us.patriot', count: 1 },
  { systemId: 'us.f-16', count: 1 },
  { systemId: 'us.e-3-sentry', count: 1 },
  { systemId: 'us.kc-135-stratotanker', count: 1 },
  { systemId: 'us.tomahawk', count: 1 },
  { systemId: 'us.arleigh-burke', count: 1 },
  { systemId: 'ru.nebo-m', count: 1 },
  { systemId: 'us.optical-recon-satellite', count: 1 },
  { systemId: 'other.shahed-136', count: 1 },
  { systemId: 'us.virginia', count: 1 },
];
let t = performance.now();
const world = buildWorld(map, catalog, { ...bal, startingArmy: army, garrisonArmy: army });
console.log('buildWorld', (performance.now() - t).toFixed(0), 'ms', catalog.length, 'systèmes');
t = performance.now();
const ids = map.nations.map((n) => n.id).sort();
const s = createGame(world, {
  seed: 7,
  players: [
    { nationId: 'fra', isAi: false },
    { nationId: 'usa', isAi: true, aiLevel: 'hard' },
    { nationId: 'rus', isAi: true, aiLevel: 'hard' },
    { nationId: 'chn', isAi: true, aiLevel: 'normal' },
  ],
}) as EngineState;
console.log(
  'createGame',
  (performance.now() - t).toFixed(0),
  'ms',
  Object.keys(s.units).length,
  'unités',
  Object.keys(s.pairs).length,
  'paires',
  ids.length,
  'nations',
);
t = performance.now();
advanceTo(s, DAY);
console.log('jour calme', (performance.now() - t).toFixed(0), 'ms');
const rng = seedRng(3);
const uids = Object.keys(s.units).sort();
let ok = 0;
let tried = 0;
t = performance.now();
for (let i = 0; i < (process.env.CALM ? 0 : 3000) && ok < 400; i++) {
  const id = uids[Math.floor(nextFloat(rng) * uids.length)]!;
  const u = s.units[id];
  if (!u) continue;
  tried++;
  const to = destination(u.pos, nextFloat(rng) * 360, 100 + nextFloat(rng) * 600);
  const sys = world.catalog.get(u.sys)!;
  let r;
  if (sys.missile)
    r = applyOrder(s, u.owner, {
      kind: 'strike',
      unitIds: [id],
      target: { type: 'point', at: to },
      count: 2,
    });
  else if (sys.movement === 'air')
    r = applyOrder(s, u.owner, { kind: 'patrol', unitIds: [id], at: to, radiusKm: 150 });
  else r = applyOrder(s, u.owner, { kind: 'move', unitIds: [id], to });
  if (r.ok) ok++;
}
console.log('ordres', ok, '/', tried, (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const notes = advanceTo(s, 2 * DAY);
console.log(
  'jour de guerre',
  (performance.now() - t).toFixed(0),
  'ms',
  notes.length,
  'notifications',
  Object.keys(s.wars).length,
  'guerres',
);
t = performance.now();
advanceTo(s, 2 * DAY + 12 * HOUR);
console.log('demi-journée suivante', (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const v = viewFor(s, 'fra');
console.log(
  'viewFor fra',
  (performance.now() - t).toFixed(1),
  'ms',
  Object.keys(v.units).length,
  'unités',
  v.battleReports?.length,
  'rapports',
  v.alertLevel,
);
const st = stats(s);
console.log('stats usa', JSON.stringify(st.nations.usa));
const m = s.mods.mil as { battles: object; stats: object };
console.log('batailles', Object.keys(m.battles).length);
