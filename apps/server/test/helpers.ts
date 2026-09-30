import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '@redline/shared';
import { loadConfig } from '../src/config.js';
import { buildApp, type BuiltApp } from '../src/app.js';
import { runMigrations } from '../src/db/client.js';
import type { Engine } from '../src/engine.js';
import type { RuntimeOptions } from '../src/context.js';
import type { PaymentProvider } from '../src/shop/payments.js';
import type { PushSender } from '../src/push/push.js';
import { createFakeEngine } from './fake-engine.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/redline_test';

let dbChecked: boolean | null = null;

/** Vrai si la base de test répond (sinon les suites qui en dépendent sont sautées). */
export async function dbAvailable(): Promise<boolean> {
  if (dbChecked !== null) return dbChecked;
  const sql = postgres(TEST_DB_URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    dbChecked = true;
  } catch {
    dbChecked = false;
    console.warn(
      `[tests serveur] PostgreSQL de test injoignable (${TEST_DB_URL}) : suites sautées.`,
    );
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  return dbChecked;
}

/** Remet la base de test à zéro (migrations + vidage des tables). */
export async function resetDb(): Promise<void> {
  await runMigrations(TEST_DB_URL);
  const sql = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`TRUNCATE users, sessions, weapon_systems, catalog_releases, catalog_changes, games,
      game_players, game_snapshots, game_orders, admin_audit, chat_messages, chat_reads,
      server_settings, push_subscriptions, timelapse_frames, wallet_ledger, shop_packs, shop_promotions,
      purchases, stripe_events, cosmetics, user_cosmetics, seasons, rankings, game_results,
      legal_acceptances, user_fingerprints, data_revisions RESTART IDENTITY CASCADE`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function sqlQuery<T extends readonly object[]>(
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export function testSystem(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Système ${id}`,
    doctrine: 'eu',
    origin: 'FR',
    category: 'infantry',
    roles: [],
    generation: 3,
    targetClass: 'infantry',
    movement: 'land',
    canCapture: true,
    cost: { money: 100, resources: {} },
    buildTimeH: 12,
    upkeepPerDay: 1,
    speedKmh: 36000,
    operationalRadiusKm: null,
    weaponRangeKm: { min: 0, max: 5 },
    damage: {
      infantry: 5,
      armor: 1,
      aircraft: 0,
      helicopter: 1,
      drone: 1,
      ship: 0,
      submarine: 0,
      missile: 0,
      building: 2,
    },
    hp: 10,
    armor: 0.1,
    stealth: 0,
    detectionRangeKm: 20,
    ew: { jamming: 0, jamResistance: 0 },
    payload: { slots: 0 },
    unitSize: 1,
    requires: [],
    licensable: false,
    exportable: true,
    icon: 'infantry',
    sheet: {
      engine: null,
      lengthM: null,
      wingspanM: null,
      mtowKg: null,
      warheadKg: null,
      speedLabel: null,
      rangeKm: null,
    },
    enabled: true,
    ...extra,
  };
}

export const BALANCE = {
  version: 1,
  time: { speeds: [1, 2, 4, 1000], combatRoundMinutes: 10, captureMinutes: 60, aiThinkMinutes: 30 },
  combat: {
    variance: 0.1,
    groundContactKm: 5,
    defenderCityBonus: 0.2,
    veterancyXp: [10, 30],
    veterancyDamageBonus: 0.1,
  },
  movement: { embarkedSpeedFactor: 0.5, embarkMinutes: 30 },
  sensors: {
    provinceDetectionKm: 100,
    identifiedAtFraction: 0.6,
    preciseAtFraction: 0.3,
    uncertaintyGrowthKmh: 10,
    forgetAfterMinutes: 600,
  },
  economy: { startingMoney: 1000, startingResources: { oil: 10 }, incomeMultiplier: 1 },
  victory: { provinceShare: 0.6, allEnemyCapitals: true },
  startingArmy: [{ systemId: 'eu.test-inf', count: 2 }],
  garrisonArmy: [{ systemId: 'eu.test-inf', count: 1 }],
};

export interface DataDirOptions {
  map?: boolean;
  balance?: boolean;
  catalog?: boolean;
  tiles?: 'lowzoom' | 'both' | 'none';
  dists?: boolean;
}

/** Dossier DATA_DIR jetable avec une mini-carte (3 nations), l'équilibrage, un catalogue et des tuiles. */
export function makeDataDir(o: DataDirOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-data-'));
  const w = (rel: string, content: string | Buffer) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  };
  if (o.map !== false) {
    w(
      'map/nations.json',
      JSON.stringify([
        {
          id: 'fra',
          iso: 'FRA',
          name: 'France',
          kind: 'state',
          color: '#3355aa',
          capitalProvinceId: 'fra-1',
        },
        {
          id: 'dza',
          iso: 'DZA',
          name: 'Algérie',
          kind: 'state',
          color: '#228844',
          capitalProvinceId: 'dza-1',
        },
        {
          id: 'usa',
          iso: 'USA',
          name: 'États-Unis',
          kind: 'state',
          color: '#aa3333',
          capitalProvinceId: 'usa-1',
        },
      ]),
    );
    const prov = (id: string, nationId: string, c: [number, number], cap = false) => ({
      id,
      name: id,
      nationId,
      centroid: c,
      cityPoint: c,
      isCapital: cap,
      coastal: false,
      income: { money: 10 },
      buildings: [],
      neighbors: [],
      areaKm2: 1000,
    });
    w(
      'map/provinces.json',
      JSON.stringify({
        provinces: [
          prov('fra-1', 'fra', [2.35, 48.85], true),
          prov('fra-2', 'fra', [5.37, 43.3]),
          prov('dza-1', 'dza', [3.06, 36.75], true),
          prov('usa-1', 'usa', [-77.03, 38.9], true),
        ],
      }),
    );
    w('map/cells.json', JSON.stringify({ res: 4, cells: {} }));
    w('map/straits.json', JSON.stringify([]));
    w('map/disputed.json', JSON.stringify([]));
    w(
      'map/provinces.geojson',
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { id: 'fra-1' },
            geometry: { type: 'Point', coordinates: [2.35, 48.85] },
          },
        ],
      }),
    );
  }
  if (o.balance !== false) w('balance/default.json', JSON.stringify(BALANCE));
  if (o.catalog !== false) {
    w(
      'catalog/test.json',
      JSON.stringify({
        category: 'infantry',
        systems: [testSystem('eu.test-inf'), testSystem('eu.test-tank', { category: 'tank' })],
      }),
    );
  }
  const tiles = o.tiles ?? 'lowzoom';
  const bytes = Buffer.alloc(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  if (tiles !== 'none') w('tiles/satellite-lowzoom.pmtiles', bytes);
  if (tiles === 'both') w('tiles/satellite.pmtiles', bytes);
  w('basemap/coast.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] }));
  if (o.dists) {
    w('client-dist/index.html', '<!doctype html><title>Red Line</title>client');
    w('client-dist/assets/app-123.js', 'console.log(1)');
    w('admin-dist/index.html', '<!doctype html><title>Red Line admin</title>admin');
  }
  return dir;
}

export interface StartOptions {
  dataDir: string;
  instanceId?: string;
  engine?: Engine | null;
  runtime?: Partial<RuntimeOptions>;
  env?: Record<string, string>;
  payments?: PaymentProvider | null;
  pushSender?: PushSender;
}

export async function startApp(o: StartOptions): Promise<BuiltApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    DATA_DIR: o.dataDir,
    CLIENT_DIST: join(o.dataDir, 'client-dist'),
    ADMIN_DIST: join(o.dataDir, 'admin-dist'),
    INSTANCE_ID: o.instanceId ?? 'test-a',
    SNAPSHOT_INTERVAL_S: '3600',
    LEASE_TTL_S: '30',
    ...o.env,
  });
  return buildApp({
    config,
    engine: o.engine === undefined ? createFakeEngine() : o.engine,
    logger: { level: process.env.TEST_LOG_LEVEL ?? 'silent' },
    runtime: { authRateLimitPerMin: 1000, createRateLimitPerMin: 1000, ...o.runtime },
    payments: o.payments === undefined ? null : o.payments,
    ...(o.pushSender ? { pushSender: o.pushSender } : {}),
  });
}

/** Compte enregistré (non invité). */
export async function register(
  app: FastifyInstance,
  email: string,
  displayName = email.split('@')[0]!,
): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'motdepasse-test', displayName },
  });
  if (res.statusCode !== 200) throw new Error(`register ${res.statusCode} ${res.body}`);
  return { cookie: sessionCookie(res), userId: res.json().user.id };
}

/** Connexion d'un compte existant (ex. super-admin d'ADMIN_EMAIL). */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

/** Requête JSON authentifiée. */
export function api(app: FastifyInstance, cookie: string | null) {
  return (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
}

/** Valeur « rl_session=… » à renvoyer dans l'en-tête Cookie. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => x.startsWith('rl_session='));
  if (!c) throw new Error(`pas de cookie de session (statut ${res.statusCode})`);
  return c.split(';')[0]!;
}

export async function guest(app: FastifyInstance): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/guest' });
  if (res.statusCode !== 200) throw new Error(`guest ${res.statusCode} ${res.body}`);
  return { cookie: sessionCookie(res), userId: res.json().user.id };
}

export async function createGame(
  app: FastifyInstance,
  cookie: string,
  body: Record<string, unknown> = { nationId: 'fra' },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/games',
    headers: { cookie },
    payload: body,
  });
  if (res.statusCode !== 201) throw new Error(`createGame ${res.statusCode} ${res.body}`);
  return res.json().game.id;
}

export async function listen(app: FastifyInstance): Promise<number> {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

/** Client WebSocket de test : garde tous les messages reçus (décodés et bruts). */
export class WsClient {
  readonly messages: ServerMessage[] = [];
  readonly raw: Buffer[] = [];
  closeCode: number | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.raw.push(Buffer.from(data));
      const m = decodeMessage<ServerMessage>(new Uint8Array(data));
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static connect(
    port: number,
    gameId: string,
    cookie?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?gameId=${gameId}`, {
        headers: { ...(cookie ? { cookie } : {}), ...extraHeaders },
      });
      const client = new WsClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(encodeMessage(msg as ClientMessage));
  }

  next<T extends ServerMessage['t']>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const test = (m: ServerMessage) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>);
    const found = this.messages.find(test);
    if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `délai dépassé en attendant '${t}' (reçus : ${this.messages.map((m) => m.t).join(',')})`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        pred: test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }

  /** Attend un message reçu APRÈS l'appel. */
  nextNew<T extends ServerMessage['t']>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const start = this.messages.length;
    return this.next(t, (m) => this.messages.indexOf(m) >= start && pred(m), timeoutMs);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend qu’une condition devienne vraie (sondage toutes les 20 ms). */
export async function until<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > timeoutMs) throw new Error(`délai dépassé : ${what}`);
    await sleep(20);
  }
}
