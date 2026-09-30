// Vérifie sur la vraie carte qu'une nation peut conquérir une province voisine.
import { readFileSync, readdirSync } from 'node:fs';
import { BalanceSchema, CatalogFileSchema, type MapData } from '@redline/shared';
import * as E from '@redline/engine';

const j = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const map: MapData = {
  nations: j('../../data/map/nations.json'), provinces: j('../../data/map/provinces.json'), cells: j('../../data/map/cells.json'),
  straits: j('../../data/map/straits.json'), disputed: j('../../data/map/disputed.json'),
};
const catalog = readdirSync('../../data/catalog').filter((f) => f.endsWith('.json'))
  .flatMap((f) => CatalogFileSchema.parse(j(`../../data/catalog/${f}`)).systems);
const balance = BalanceSchema.parse(j('../../data/balance/default.json'));
let t = Date.now();
const world = E.buildWorld(map, catalog, balance);
console.log('buildWorld', Date.now() - t, 'ms');
t = Date.now();
const s = E.createGame(world, { seed: 7, players: [{ nationId: 'fra', isAi: false }] });
console.log('createGame', Date.now() - t, 'ms');
const target = map.provinces.find((p) => p.nationId === 'bel' && p.isCapital)!;
const v0 = E.viewFor(s, 'fra');
const inf = Object.values(v0.units).filter((u) => u.level === 'own' && world.catalog.get(u.systemId!)?.canCapture);
console.log('cible', target.id, target.name, 'capturants', inf.length);
console.log('ordre', E.applyOrder(s, 'fra', { kind: 'move', unitIds: inf.map((u) => u.id), to: target.cityPoint }));
const HOUR = 3_600_000;
for (let h = 1; h <= 96; h++) {
  const notes = E.advanceTo(s, h * HOUR);
  for (const n of E.notificationsFor(s, 'fra', notes)) if (n.kind !== 'unit_detected') console.log(`h+${h}`, n.kind, JSON.stringify(n).slice(0, 140));
  const owner = E.viewFor(s, 'fra').provinces[target.id]?.owner;
  if (owner === 'fra') { console.log(`✔ ${target.name} capturée à h+${h}`); break; }
}
