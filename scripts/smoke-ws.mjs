// Test de fumée bout en bout : invité → partie solo → WebSocket → ordre de déplacement.
// Usage : node scripts/smoke-ws.mjs [baseUrl] [nation]
import WebSocket from '../apps/server/node_modules/ws/index.js';
import { encode, decode } from '../packages/shared/node_modules/@msgpack/msgpack/dist.esm/index.mjs';

const base = process.argv[2] ?? 'http://localhost:3100';
const nation = process.argv[3] ?? 'fra';
const t0 = Date.now();
const r = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
const cookie = r.headers.get('set-cookie').split(';')[0];
const post = (p, b) =>
  fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((x) => x.json());
const created = await post('/api/games', { nationId: nation, speed: 1 });
console.log('partie', created.game?.id, `${Date.now() - t0} ms`);
if (!created.game) { console.log(created); process.exit(1); }
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?gameId=${created.game.id}`, { headers: { cookie, origin: base } });
let view;
ws.on('message', (data) => {
  const m = decode(data);
  if (m.t === 'welcome') {
    view = m.view;
    const own = Object.values(view.units).filter((u) => u.level === 'own');
    const others = Object.values(view.units).filter((u) => u.level !== 'own');
    console.log('welcome', m.me, 'unités', own.length, 'visibles ennemies', others.length, 'provinces', Object.values(view.provinces).filter((p) => p.owner === nation).length, 'argent', view.economy.money);
    const inf = own.find((u) => u.systemId?.includes('infantry'));
    ws.send(encode({ t: 'order', id: 1, order: { kind: 'move', unitIds: [inf.id], to: [4.35, 50.85] } }));
    ws.send(encode({ t: 'control', speed: 16 }));
  } else if (m.t === 'orderResult') {
    console.log('orderResult', JSON.stringify(m));
  } else if (m.t === 'diff') {
    const up = m.diff.units?.upsert ?? [];
    const moving = up.filter((u) => u.move);
    if (moving.length) console.log('diff: unités en mouvement', moving.length, 'segments', moving[0].move.legs.length);
  } else if (m.t === 'notify') {
    console.log('notify', m.items.map((i) => i.kind).join(','));
  } else if (m.t === 'clock') console.log('clock speed', m.clock.speed);
  else if (m.t === 'error') console.log('ERREUR', m);
});
setTimeout(() => { ws.close(); process.exit(0); }, 6000);
