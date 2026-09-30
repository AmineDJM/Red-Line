// Essai de charge contre un VRAI serveur (moteur et données réels) : une partie monde à N joueurs
// humains simulés (clients WebSocket de test) + M parties simultanées, ordres réguliers.
// Mesure : latence des ordres, vues initiales, diffs (taille, fréquence), CPU, mémoire, boucle
// d'événements, coût des diffusions, taille des instantanés.
//
// Serveur à lancer avec CLIENT_IP_HEADER=x-load-ip (chaque client simulé a sa propre adresse, comme
// en réalité : les limites de débit par IP s'appliquent normalement), par exemple :
//   NODE_ENV=production CLIENT_IP_HEADER=x-load-ip ADMIN_EMAIL=… ADMIN_PASSWORD=… node apps/server/dist/main.js
// puis :
//   pnpm --filter @redline/server exec tsx scripts/load-test.ts --base http://localhost:3000 \
//     --players 64 --games 3 --duration 180 --speed 16 --order-every 15
import WebSocket from 'ws';
import {
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type NationId,
  type ServerMessage,
} from '@redline/shared';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
}
const BASE = args.get('base') ?? 'http://localhost:3000';
const PLAYERS = Number(args.get('players') ?? 64);
const GAMES = Number(args.get('games') ?? 3);
const DURATION_S = Number(args.get('duration') ?? 180);
const SPEED = Number(args.get('speed') ?? 16);
const ORDER_EVERY_S = Number(args.get('order-every') ?? 15);
const ADMIN_EMAIL = args.get('admin-email') ?? process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = args.get('admin-password') ?? process.env.ADMIN_PASSWORD ?? '';

let ipSeq = 1;
const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

interface Client {
  ip: string;
  cookie: string;
}

async function http(
  c: Client | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; cookie?: string }> {
  const headers: Record<string, string> = { 'x-load-ip': c?.ip ?? nextIp() };
  if (c?.cookie) headers.cookie = c.cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const setCookie = r.headers.get('set-cookie');
  return {
    status: r.status,
    json: text ? JSON.parse(text) : null,
    ...(setCookie ? { cookie: setCookie.split(';')[0] } : {}),
  };
}

async function guest(): Promise<Client> {
  const ip = nextIp();
  const r = await http({ ip, cookie: '' }, 'POST', '/api/auth/guest');
  if (r.status !== 200 || !r.cookie) throw new Error(`invité : ${r.status}`);
  return { ip, cookie: r.cookie };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

interface Stats {
  welcomeBytes: number[];
  welcomeMs: number[];
  diffBytes: number[];
  diffs: number;
  notifies: number;
  orderLatency: number[];
  ordersOk: number;
  ordersKo: number;
  errors: Map<string, number>;
  bytesIn: number;
}
const S: Stats = {
  welcomeBytes: [],
  welcomeMs: [],
  diffBytes: [],
  diffs: 0,
  notifies: 0,
  orderLatency: [],
  ordersOk: 0,
  ordersKo: 0,
  errors: new Map(),
  bytesIn: 0,
};

class Player {
  ws!: WebSocket;
  own: { id: string; pos: [number, number] }[] = [];
  pending = new Map<number, number>();
  seq = 1;
  timer: NodeJS.Timeout | null = null;
  constructor(
    readonly c: Client,
    readonly gameId: string,
  ) {}

  connect(): Promise<void> {
    const t0 = performance.now();
    const url = `${BASE.replace(/^http/, 'ws')}/ws?gameId=${this.gameId}`;
    this.ws = new WebSocket(url, {
      headers: { cookie: this.c.cookie, 'x-load-ip': this.c.ip },
      perMessageDeflate: true,
    });
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('welcome : délai dépassé')), 120_000);
      this.ws.on('message', (data: Buffer) => {
        S.bytesIn += data.byteLength;
        const m = decodeMessage<ServerMessage>(new Uint8Array(data));
        if (m.t === 'welcome') {
          clearTimeout(to);
          S.welcomeMs.push(performance.now() - t0);
          S.welcomeBytes.push(data.byteLength);
          this.own = Object.values(m.view.units)
            .filter((u) => u.level === 'own' && u.pos)
            .map((u) => ({ id: u.id, pos: u.pos as [number, number] }));
          resolve();
        } else if (m.t === 'diff') {
          S.diffs++;
          S.diffBytes.push(data.byteLength);
        } else if (m.t === 'notify') {
          S.notifies++;
        } else if (m.t === 'orderResult') {
          const t = this.pending.get(m.id);
          if (t !== undefined) {
            S.orderLatency.push(performance.now() - t);
            this.pending.delete(m.id);
          }
          if (m.ok) S.ordersOk++;
          else {
            S.ordersKo++;
            S.errors.set(`order:${m.error}`, (S.errors.get(`order:${m.error}`) ?? 0) + 1);
          }
        } else if (m.t === 'error') {
          S.errors.set(m.code, (S.errors.get(m.code) ?? 0) + 1);
        }
      });
      this.ws.on('error', (e) => reject(e));
      this.ws.on('unexpected-response', (_q, res) =>
        reject(new Error(`WS HTTP ${res.statusCode}`)),
      );
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeMessage(msg));
  }

  /** Ordres réguliers : déplacement d'une unité à 50-300 km, ou changement de posture. */
  play(): void {
    const tick = () => {
      if (this.own.length) {
        const u = this.own[Math.floor(Math.random() * this.own.length)]!;
        const id = this.seq++;
        this.pending.set(id, performance.now());
        if (Math.random() < 0.7) {
          const to: [number, number] = [
            u.pos[0] + (Math.random() - 0.5) * 4,
            Math.max(-80, Math.min(80, u.pos[1] + (Math.random() - 0.5) * 3)),
          ];
          this.send({ t: 'order', id, order: { kind: 'move', unitIds: [u.id], to } });
        } else {
          this.send({
            t: 'order',
            id,
            order: {
              kind: 'stance',
              unitIds: [u.id],
              stance: Math.random() < 0.5 ? 'aggressive' : 'hold',
            },
          });
        }
      }
      if (Math.random() < 0.3) this.send({ t: 'ping', clientTime: Date.now() });
      this.timer = setTimeout(tick, ORDER_EVERY_S * 1000 * (0.5 + Math.random()));
    };
    this.timer = setTimeout(tick, Math.random() * ORDER_EVERY_S * 1000);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.ws.close();
  }
}

async function main(): Promise<void> {
  console.log(
    `Essai de charge : ${BASE} · ${PLAYERS} joueurs dans une partie monde + ${GAMES} parties · ${DURATION_S} s · ×${SPEED} · un ordre toutes les ~${ORDER_EVERY_S} s par joueur`,
  );
  let admin: Client | null = null;
  if (ADMIN_EMAIL) {
    const ip = nextIp();
    const r = await http({ ip, cookie: '' }, 'POST', '/api/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    if (r.cookie) admin = { ip, cookie: r.cookie };
  }
  const metrics: any[] = [];
  const sample = async () => {
    if (!admin) return;
    const r = await http(admin, 'GET', '/admin/api/metrics');
    if (r.status === 200) metrics.push({ t: Date.now(), ...r.json });
  };

  const nations = (await http(null, 'GET', '/api/map/nations')).json.nations as { id: NationId }[];
  // Grandes puissances d'abord (plus d'unités, vues plus lourdes : cas le plus défavorable).
  const big = ['usa', 'rus', 'chn', 'ind', 'fra', 'gbr', 'deu', 'jpn', 'tur', 'bra', 'irn', 'pak'];
  const order = [
    ...big.filter((b) => nations.some((n) => n.id === b)),
    ...nations.map((n) => n.id).filter((n) => !big.includes(n)),
  ];
  const clients = await Promise.all(Array.from({ length: PLAYERS }, () => guest()));
  const t0 = performance.now();
  const lobby = await http(clients[0]!, 'POST', '/api/lobby', {
    name: 'Essai de charge',
    nationId: order[0],
    maxPlayers: PLAYERS,
    speed: SPEED,
  });
  if (lobby.status !== 201)
    throw new Error(`salon : ${lobby.status} ${JSON.stringify(lobby.json)}`);
  const gameId = lobby.json.game.id as string;
  for (let i = 1; i < PLAYERS; i++) {
    const r = await http(clients[i]!, 'POST', `/api/lobby/${gameId}/join`, { nationId: order[i] });
    if (r.status !== 200) throw new Error(`arrivée ${i} : ${r.status} ${JSON.stringify(r.json)}`);
  }
  console.log(`partie ${gameId} lancée en ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const others: string[] = [];
  const otherPlayers: Player[] = [];
  for (let k = 0; k < GAMES; k++) {
    const c = await guest();
    const r = await http(c, 'POST', '/api/lobby', {
      name: `Parallèle ${k + 1}`,
      nationId: order[k % order.length],
      maxPlayers: 1,
      speed: SPEED,
    });
    if (r.status !== 201) throw new Error(`partie parallèle : ${r.status}`);
    others.push(r.json.game.id);
    otherPlayers.push(new Player(c, r.json.game.id));
  }

  // Connexions simultanées (tempête de reconnexions après un déploiement).
  const players = clients.map((c) => new Player(c, gameId));
  const tc = performance.now();
  await Promise.all([...players, ...otherPlayers].map((p) => p.connect()));
  console.log(
    `${players.length + otherPlayers.length} connexions établies en ${((performance.now() - tc) / 1000).toFixed(1)} s`,
  );
  await sample();
  const sampler = setInterval(() => void sample(), 5000);
  for (const p of [...players, ...otherPlayers]) p.play();
  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  clearInterval(sampler);
  await sample();
  for (const p of [...players, ...otherPlayers]) p.close();

  const last = metrics.at(-1) ?? {};
  const series = (k: string) => metrics.map((m) => Number(m[k] ?? 0));
  const out = {
    players: PLAYERS,
    games: 1 + GAMES,
    durationS: DURATION_S,
    speed: SPEED,
    welcome: {
      kioP50: +(pct(S.welcomeBytes, 50) / 1024).toFixed(1),
      msP50: Math.round(pct(S.welcomeMs, 50)),
      msMax: Math.round(Math.max(...S.welcomeMs)),
    },
    orders: {
      ok: S.ordersOk,
      refused: S.ordersKo,
      latencyMsP50: Math.round(pct(S.orderLatency, 50)),
      latencyMsP95: Math.round(pct(S.orderLatency, 95)),
      latencyMsMax: Math.round(Math.max(0, ...S.orderLatency)),
    },
    diffs: {
      count: S.diffs,
      perPlayerPerMin: +(S.diffs / (PLAYERS + GAMES) / (DURATION_S / 60)).toFixed(1),
      bytesP50: pct(S.diffBytes, 50),
      bytesP95: pct(S.diffBytes, 95),
    },
    notifies: S.notifies,
    wsInKioPerPlayerPerMin: +(S.bytesIn / 1024 / (PLAYERS + GAMES) / (DURATION_S / 60)).toFixed(1),
    errors: Object.fromEntries(S.errors),
    server: {
      cpuPctMean: +(
        series('cpuPct').reduce((a, b) => a + b, 0) / Math.max(1, metrics.length)
      ).toFixed(1),
      cpuPctMax: Math.max(0, ...series('cpuPct')),
      rssMbMax: Math.max(0, ...series('rssMb')),
      heapMbMax: Math.max(0, ...series('heapMb')),
      loopP99MsMax: Math.max(0, ...series('eventLoopP99Ms')),
      loopMaxMs: Math.max(0, ...series('eventLoopMaxMs')),
      flushMaxMs: Math.max(0, ...series('flushMaxMs')),
      flushesPerMin: last.flushesPerMin,
      flushMsPerMin: last.flushMsPerMin,
      wsKioOutPerMin: Math.round((last.wsBytesOutPerMin ?? 0) / 1024),
      eventsPerMin: last.eventsProcessedPerMin,
      stateKio: Math.round((last.stateBytes ?? 0) / 1024),
      gamesBehind: Math.max(0, ...series('gamesBehind')),
    },
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
