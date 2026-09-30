// Villes des provinces (nom, rang, population) depuis Natural Earth — à lancer après build.ts :
//   node tools/map/scripts/cities.mjs && pnpm exec prettier --write data/map/provinces.json --ignore-path /dev/null
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const h3 = require('h3-js');
const R = new URL('../../../', import.meta.url).pathname;
const provs = JSON.parse(fs.readFileSync(R + 'data/map/provinces.json', 'utf8'));
const cells = JSON.parse(fs.readFileSync(R + 'data/map/cells.json', 'utf8'));
const pp = JSON.parse(
  fs.readFileSync(R + 'tools/map/.cache/ne_10m_populated_places.geojson', 'utf8'),
);
const byProv = new Map();
for (const f of pp.features) {
  const [lng, lat] = f.geometry.coordinates;
  const c = h3.latLngToCell(lat, lng, cells.res);
  let pid = cells.cells[c];
  if (!pid)
    for (const n of h3.gridDisk(c, 1))
      if (cells.cells[n]) {
        pid = cells.cells[n];
        break;
      }
  if (!pid) continue;
  const p = f.properties;
  const pop = Math.max(p.POP_MAX ?? 0, p.POP_MIN ?? 0);
  const name = p.NAME_FR || p.NAME || p.NAMEASCII;
  if (!byProv.has(pid)) byProv.set(pid, []);
  byProv.get(pid).push({ name, pop, lng, lat });
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
let named = 0;
for (const pr of provs) {
  const list = (byProv.get(pr.id) ?? []).sort(
    (a, b) => b.pop - a.pop || (a.name < b.name ? -1 : 1),
  );
  const total = list.reduce((s, x) => s + x.pop, 0);
  // Ville = la plus proche du cityPoint parmi les plus peuplées (le cityPoint vient de la plus grande ville).
  let city = null;
  for (const x of list)
    if (dist([x.lng, x.lat], pr.cityPoint) < 0.35) {
      if (!city || x.pop > city.pop) city = x;
    }
  city ??= list[0] ?? null;
  if (city) {
    pr.cityName = city.name;
    named++;
  }
  const pop = Math.round(total || city?.pop || 0);
  if (pop) pr.population = pop;
  pr.cityRank = pr.isCapital
    ? 1
    : (city?.pop ?? 0) >= 1_000_000
      ? 2
      : (city?.pop ?? 0) >= 200_000
        ? 3
        : 4;
}
for (const pr of provs) pr.cityName ??= pr.name;
fs.writeFileSync(R + 'data/map/provinces.json', JSON.stringify(provs, null, 1));
console.log('provinces', provs.length, 'avec ville nommée', named);
const ex = provs
  .filter((p) => ['fra', 'dza', 'esp'].includes(p.nationId))
  .slice(0, 12)
  .map((p) => `${p.name} → ${p.cityName} (${p.cityRank}, ${p.population})`);
console.log(ex.join('\n'));
