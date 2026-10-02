/**
 * Serveur factice : économie du service, annonces, paramètres d'exploitation, gestion des comptes et
 * des parties (mêmes routes, gardes et formes de réponse que economy-routes.ts et manage-routes.ts).
 * La consommation est synthétique (déterministe) ; l'attribution est le vrai calcul partagé.
 */
import {
  AnnouncementBodySchema,
  CostEntryBodySchema,
  CostSettingsSchema,
  DEFAULT_COST_SETTINGS,
  RuntimeSettingsSchema,
  ZERO_USAGE,
  computeCostReport,
  costAlerts,
  planOf,
  type AdminGame,
  type Announcement,
  type CostEntry,
  type CostInput,
  type CostPeriod,
  type CostSeriesPoint,
  type CostSettings,
  type Role,
  type RuntimeSettings,
  type UserKind,
} from '@redline/shared';
import { ApiError, type HttpMethod } from '../client';
import type { AdminUser, Purchase } from '../types';
import type { ArchivedGame } from '../ops';

type Body = Record<string, unknown>;
type Handler = (p: string[], body: Body, q: URLSearchParams) => unknown;

export interface OpsMockCtx {
  on(m: HttpMethod, pattern: string, h: Handler): void;
  need(r: Role): { id: string; displayName: string };
  log(action: string, target: string, before?: unknown, after?: unknown): void;
  users: AdminUser[];
  games: AdminGame[];
  purchases: Purchase[];
}

const H = 3_600_000;
const zodMsg = (e: { issues: { path: (string | number)[]; message: string }[] }) =>
  e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(corps)'} : ${i.message}`)
    .join(' ; ');

/** Pseudo-aléa déterministe (même tableau de bord à chaque ouverture). */
const noise = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function periodHours(p: CostPeriod, now: Date): number {
  if (p === '24h') return 24;
  if (p === '7d') return 7 * 24;
  if (p === '30d') return 30 * 24;
  return (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / H;
}

export function registerOpsMock(c: OpsMockCtx): void {
  const { on, need, log, users, games, purchases } = c;
  let settings: CostSettings = DEFAULT_COST_SETTINGS;
  let runtime: RuntimeSettings = {
    maxActiveSoloPerUser: 10,
    maxActiveMultiPerUser: 5,
    soloAbandonMin: 48 * 60,
    multiAbandonMin: 24 * 60,
    dormancyDelayMin: 5,
    idleUnloadMin: 10,
  };
  const today = new Date().toISOString().slice(0, 10);
  let entrySeq = 3;
  const entries: CostEntry[] = [
    {
      id: 1,
      day: `${today.slice(0, 8)}01`,
      category: 'tools',
      label: 'Nom de domaine (mensualisé)',
      amountUsd: 1.5,
      monthly: true,
      source: 'manual',
      ref: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 2,
      day: today,
      category: 'video_api',
      label: 'Studio vidéo : génération de la bande-annonce',
      amountUsd: 4.2,
      monthly: false,
      source: 'measured',
      ref: 'studio:trailer-1',
      createdAt: new Date().toISOString(),
    },
  ];
  let annSeq = 2;
  const announcements: Announcement[] = [
    {
      id: 1,
      text: 'Maintenance du serveur dimanche à 3 h (heure de Paris), 10 minutes.',
      level: 'warn',
      startsAt: new Date(Date.now() - 2 * H).toISOString(),
      endsAt: new Date(Date.now() + 46 * H).toISOString(),
      active: true,
      createdAt: new Date(Date.now() - 2 * H).toISOString(),
      authorName: users[0]?.displayName ?? null,
    },
  ];
  const archived: ArchivedGame[] = Array.from({ length: 9 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`,
    name:
      i % 3 === 0
        ? `Coalition du Levant ${i + 1}`
        : `Le monde aujourd’hui — ${['France', 'Algérie', 'Japon'][i % 3]}`,
    mode: i % 3 === 0 ? 'multi' : 'solo',
    scenarioId: 'world-today',
    endReason: i % 4 === 1 ? 'abandoned' : i === 5 ? 'admin' : 'victory',
    winner: i % 4 === 1 ? null : 'fra',
    createdAt: new Date(Date.now() - (20 + i * 3) * 24 * H).toISOString(),
    endedAt: new Date(Date.now() - (2 + i * 2) * 24 * H).toISOString(),
    stateBytes: 380_000 + i * 21_000,
    unranked: i === 5,
    humans: i % 3 === 0 ? 6 : 1,
  }));

  const kindOf = (u: AdminUser): UserKind =>
    u.role !== 'player' || u.unlimited
      ? 'staff'
      : u.isGuest
        ? 'guest'
        : purchases.some((p) => p.userId === u.id && p.status === 'paid')
          ? 'paying'
          : 'free';

  /** Consommation synthétique : ordres de grandeur de docs/charge.md (partie monde). */
  const inputFor = (period: CostPeriod, now = new Date()): CostInput => {
    const hours = periodHours(period, now);
    const from = new Date(now.getTime() - hours * H);
    const live = games.filter((g) => g.game.status !== 'lobby');
    const humansOf = (g: AdminGame) =>
      g.players
        .filter((p) => p.userName)
        .map((p) => users.find((u) => u.displayName === p.userName)?.id)
        .filter((x): x is string => !!x);
    const gameInputs = live.map((g, i) => {
      const loadedH = hours * (0.25 + 0.6 * noise(i, 1));
      const humans = humansOf(g);
      return {
        id: g.game.id,
        name: g.game.name,
        mode: g.game.mode,
        status: g.game.status,
        humans,
        createdBy: humans[0] ?? null,
        storageBytes: 420_000 * 3 + 900_000 * (0.5 + noise(i, 2)),
        usage: {
          ...ZERO_USAGE,
          cpuSimMs: loadedH * 3600 * 1000 * 0.012 * (0.5 + noise(i, 3)),
          cpuFlushMs: loadedH * 3600 * 1000 * 0.004 * Math.max(1, humans.length),
          cpuOtherMs: loadedH * 60 * 75,
          memMbH: loadedH * (20 + humans.length * 1.2),
          playS: loadedH * 3600 * 0.3 * Math.max(1, humans.length),
        },
      };
    });
    const people = users.map((u, i) => {
      const played = gameInputs.filter((g) => g.humans.includes(u.id));
      const playS = played.reduce((a, g) => a + g.usage.playS / Math.max(1, g.humans.length), 0);
      const paid = purchases.filter(
        (p) => p.userId === u.id && p.paidAt && Date.parse(p.paidAt) >= from.getTime(),
      );
      const eur = (p: Purchase) =>
        p.currency === 'usd' ? p.priceCents / settings.eurToUsd : p.priceCents;
      return {
        id: u.id,
        name: u.displayName,
        kind: kindOf(u),
        usage: {
          ...ZERO_USAGE,
          playS,
          wsBytes: (playS / 60) * 48_000 + 280_000 * (1 + (i % 3)),
          httpBytes: 600_000 + 300_000 * noise(i, 4),
        },
        paidEurCents: paid.reduce((a, p) => a + eur(p), 0),
        refundedEurCents: paid
          .filter((p) => p.status === 'refunded')
          .reduce((a, p) => a + eur(p), 0),
        payments: paid.length,
      };
    });
    const ws = people.reduce((a, p) => a + p.usage.wsBytes, 0);
    const http = people.reduce((a, p) => a + p.usage.httpBytes, 0) + hours * 40e6;
    const entriesUsd = entries.reduce((a, e) => {
      const day = Date.parse(`${e.day}T00:00:00Z`);
      if (e.monthly)
        return (
          a + (e.amountUsd * Math.max(0, (now.getTime() - Math.max(day, from.getTime())) / H)) / 730
        );
      return day >= from.getTime() - 86_400_000 && day <= now.getTime() ? a + e.amountUsd : a;
    }, 0);
    return {
      from: from.toISOString(),
      to: now.toISOString(),
      now: now.toISOString(),
      server: {
        ...ZERO_USAGE,
        wsBytes: ws,
        httpBytes: http,
        cpuProcessMs: hours * H * 0.19,
        rssMbH: hours * 330,
        rssMaxMb: 402,
        peakPlayers: 14,
        peakGames: live.length,
      },
      games: gameInputs,
      users: people,
      entriesUsd,
      entriesByCategory: {},
      dbBytes: 610e6,
    };
  };

  const series = (period: CostPeriod, now = new Date()): CostSeriesPoint[] => {
    const hourly = period === '24h';
    const n = hourly ? 24 : Math.max(1, Math.ceil(periodHours(period, now) / 24));
    const step = hourly ? 1 : 24;
    const plan = planOf(settings);
    const fixedH =
      (plan.usdPerMonth * settings.compute.instances +
        settings.database.usdPerMonth +
        settings.database.storageGb * settings.database.storageUsdPerGbMonth) /
      730;
    return Array.from({ length: n }, (_, i) => {
      const t = new Date(now.getTime() - (n - i) * step * H);
      if (hourly) t.setUTCMinutes(0, 0, 0);
      else t.setUTCHours(0, 0, 0, 0);
      const wave = hourly
        ? 0.5 + 0.5 * Math.sin(((t.getUTCHours() - 14) / 24) * Math.PI * 2)
        : noise(i, 9);
      const rev =
        !hourly && noise(i, 7) > 0.55
          ? ((4.99 + 9.99 * Math.floor(noise(i, 8) * 3)) * 1.08) / 1.2
          : 0;
      return {
        t: t.toISOString(),
        costUsd: fixedH * step + (hourly ? 0 : 0.02 * noise(i, 5)),
        revenueNetUsd: rev,
        playHours: (hourly ? 6 : 90) * (0.3 + wave),
        cpuPct: 8 + 26 * wave,
        rssMb: 300 + 80 * wave,
        peakPlayers: Math.round(3 + 11 * wave),
        egressMb: (hourly ? 60 : 1400) * (0.3 + wave),
      };
    });
  };

  const report = (period: CostPeriod) => computeCostReport(inputFor(period), settings);
  const periodOf = (q: URLSearchParams) => (q.get('period') ?? 'month') as CostPeriod;

  on('GET', '/admin/api/costs/dashboard', (_p, _b, q) => {
    need('superadmin');
    const period = periodOf(q);
    const r = report(period);
    const live = {
      cpuPct: 21 + 6 * Math.sin(Date.now() / 7000),
      rssMb: 388,
      eventLoopP99Ms: 34,
      connectedPlayers: 14,
      games: games.filter((g) => g.game.status !== 'ended').length,
      gamesBehind: 0,
    };
    const { users: _u, games: _g, ...light } = r;
    return {
      period,
      report: light,
      ...costAlerts(r, live, settings),
      series: series(period),
      live,
    };
  });
  on('GET', '/admin/api/costs/report', (_p, _b, q) => {
    need('superadmin');
    const r = report(periodOf(q));
    if (q.get('full') === '1') return { report: r };
    const { users: _u, games: _g, ...light } = r;
    return { report: light };
  });
  on('GET', '/admin/api/costs/users/:id', ([id], _b, q) => {
    need('superadmin');
    return {
      period: periodOf(q),
      cost: report(periodOf(q)).users?.find((u) => u.id === id) ?? null,
    };
  });
  on('GET', '/admin/api/costs/games/:id', ([id], _b, q) => {
    need('superadmin');
    return {
      period: periodOf(q),
      cost: report(periodOf(q)).games?.find((g) => g.id === id) ?? null,
    };
  });
  on('GET', '/admin/api/costs/settings', () => {
    need('superadmin');
    return { settings };
  });
  on('PUT', '/admin/api/costs/settings', (_p, b) => {
    need('superadmin');
    const r = CostSettingsSchema.safeParse(b);
    if (!r.success) throw new ApiError(400, zodMsg(r.error), 'invalid_body');
    if (!r.data.compute.plans.some((p) => p.id === r.data.compute.plan))
      throw new ApiError(400, `offre inconnue : ${r.data.compute.plan}`, 'invalid_settings');
    log('costs.settings', 'costs:settings', settings, r.data);
    settings = r.data;
    return { settings };
  });
  on('GET', '/admin/api/costs/entries', () => {
    need('superadmin');
    return { entries: [...entries].sort((a, b) => b.day.localeCompare(a.day)) };
  });
  on('POST', '/admin/api/costs/entries', (_p, b) => {
    need('superadmin');
    const r = CostEntryBodySchema.safeParse(b);
    if (!r.success) throw new ApiError(400, zodMsg(r.error), 'invalid_body');
    const entry: CostEntry = {
      ...r.data,
      id: entrySeq++,
      source: 'manual',
      ref: null,
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    log('costs.entry.create', `cost:${entry.id}`, null, r.data);
    return { entry };
  });
  on('DELETE', '/admin/api/costs/entries/:id', ([id]) => {
    need('superadmin');
    const i = entries.findIndex((e) => e.id === Number(id));
    if (i < 0) throw new ApiError(404, 'Dépense introuvable', 'not_found');
    log('costs.entry.delete', `cost:${id}`, entries[i], null);
    entries.splice(i, 1);
    return { ok: true };
  });

  // ——— Annonces
  on('GET', '/api/announcements', () => ({
    announcements: announcements
      .filter(
        (a) =>
          a.active && Date.parse(a.startsAt) <= Date.now() && Date.parse(a.endsAt) > Date.now(),
      )
      .map(({ id, text, level, endsAt }) => ({ id, text, level, endsAt })),
  }));
  on('GET', '/admin/api/announcements', () => {
    need('superadmin');
    return { announcements: [...announcements].sort((a, b) => b.id - a.id) };
  });
  on('POST', '/admin/api/announcements', (_p, b) => {
    const me = need('superadmin');
    const r = AnnouncementBodySchema.safeParse(b);
    if (!r.success) throw new ApiError(400, zodMsg(r.error), 'invalid_body');
    const startsAt = r.data.startsAt ?? new Date().toISOString();
    if (Date.parse(r.data.endsAt) <= Date.parse(startsAt))
      throw new ApiError(400, 'La fin doit être postérieure au début', 'invalid_dates');
    const a: Announcement = {
      id: annSeq++,
      text: r.data.text,
      level: r.data.level,
      startsAt,
      endsAt: r.data.endsAt,
      active: r.data.active,
      createdAt: new Date().toISOString(),
      authorName: me.displayName,
    };
    announcements.push(a);
    log('announcement.create', `announcement:${a.id}`, null, r.data);
    return { announcement: a, sent: r.data.broadcast && r.data.active ? 14 : 0 };
  });
  on('PUT', '/admin/api/announcements/:id', ([id], b) => {
    need('superadmin');
    const a = announcements.find((x) => x.id === Number(id));
    if (!a) throw new ApiError(404, 'Annonce introuvable', 'not_found');
    if (typeof b.active === 'boolean') a.active = b.active;
    if (typeof b.endsAt === 'string') a.endsAt = b.endsAt;
    log('announcement.update', `announcement:${id}`, null, b);
    return { announcement: a };
  });
  on('DELETE', '/admin/api/announcements/:id', ([id]) => {
    need('superadmin');
    const i = announcements.findIndex((x) => x.id === Number(id));
    if (i < 0) throw new ApiError(404, 'Annonce introuvable', 'not_found');
    announcements.splice(i, 1);
    log('announcement.delete', `announcement:${id}`);
    return { ok: true };
  });

  // ——— Paramètres d'exploitation
  on('GET', '/admin/api/server/settings', () => {
    need('moderator');
    return {
      settings: runtime,
      info: {
        speeds: [1, 2, 4, 8, 16],
        dormancyRadiusKm: 2000,
        snapshotIntervalS: 60,
        createRateLimitPerMin: 10,
        instanceId: 'srv-demo-a1b2c3',
        nodeEnv: 'production',
        paymentsAvailable: true,
      },
    };
  });
  on('PUT', '/admin/api/server/settings', (_p, b) => {
    need('superadmin');
    const r = RuntimeSettingsSchema.safeParse(b);
    if (!r.success) throw new ApiError(400, zodMsg(r.error), 'invalid_body');
    log('server.settings', 'server:settings', runtime, r.data);
    runtime = r.data;
    return { settings: runtime };
  });

  // ——— Comptes
  const userOr = (id: string) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, 'Utilisateur introuvable', 'not_found');
    return u;
  };
  const notSelf = (me: { id: string }, id: string) => {
    if (me.id === id)
      throw new ApiError(400, 'Action impossible sur votre propre compte', 'self_lockout');
  };
  const sessionsOf = new Map<string, number>();
  on('GET', '/admin/api/users/:id/overview', ([id]) => {
    need('superadmin');
    const u = userOr(id!);
    const i = users.indexOf(u);
    const mine = games.filter((g) => g.players.some((p) => p.userName === u.displayName));
    const n = sessionsOf.get(u.id) ?? (u.bannedAt || u.isGuest ? 0 : 1 + (i % 3));
    return {
      sessions: Array.from({ length: n }, (_, k) => ({
        n: k + 1,
        createdAt: new Date(Date.now() - (k * 30 + 2) * H).toISOString(),
        expiresAt: new Date(Date.now() + (29 - k) * 24 * H).toISOString(),
        userAgent:
          k % 2
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1) Safari/605.1'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
      })),
      games: mine.map((g) => ({
        gameId: g.game.id,
        name: g.game.name,
        mode: g.game.mode,
        status: g.game.status,
        nationId: g.players.find((p) => p.userName === u.displayName)!.nationId,
        createdAt: g.game.createdAt ?? new Date().toISOString(),
        endedAt: null,
        lastActiveAt: g.players.find((p) => p.userName === u.displayName)!.lastActiveAt ?? null,
        isAi: false,
        owner: g.game.mode === 'solo',
        loaded: g.game.status === 'running',
        stateBytes: 430_000,
      })),
      results: { wins: i % 4, games: 3 + (i % 7), points: (i * 37) % 400 },
      wallet: { balance: u.premiumBalance, bought: u.premiumBalance + 200, spent: 200, admin: 0 },
      costMonth: report('month').users?.find((x) => x.id === u.id) ?? null,
      kind: kindOf(u),
    };
  });
  on('POST', '/admin/api/users/:id/suspend', ([id], b) => {
    const me = need('superadmin');
    notSelf(me, id!);
    const u = userOr(id!);
    const hours = Number(b.hours);
    if (!(hours > 0)) throw new ApiError(400, 'hours : nombre positif attendu', 'invalid_body');
    const before = { ...u };
    u.bannedAt = new Date().toISOString();
    u.bannedUntil = new Date(Date.now() + hours * H).toISOString();
    u.banReason = typeof b.reason === 'string' ? b.reason : null;
    sessionsOf.set(u.id, 0);
    log(
      'user.suspend',
      `user:${id}`,
      { bannedAt: before.bannedAt },
      { bannedUntil: u.bannedUntil },
    );
    return { ok: true, bannedUntil: u.bannedUntil };
  });
  on('POST', '/admin/api/users/:id/sessions/revoke', ([id]) => {
    const me = need('superadmin');
    notSelf(me, id!);
    userOr(id!);
    sessionsOf.set(id!, 0);
    log('user.sessions_revoke', `user:${id}`);
    return { ok: true, revoked: 1 };
  });
  on('POST', '/admin/api/users/:id/password-reset', ([id]) => {
    const me = need('superadmin');
    notSelf(me, id!);
    const u = userOr(id!);
    if (!u.email)
      throw new ApiError(409, 'Compte sans adresse e-mail (invité ou supprimé)', 'no_password');
    sessionsOf.set(u.id, 0);
    log('user.password_reset', `user:${id}`);
    return { ok: true, password: 'Dm0-' + Math.random().toString(36).slice(2, 10) };
  });
  on('POST', '/admin/api/users/:id/wallet', ([id], b) => {
    need('superadmin');
    const u = userOr(id!);
    const delta = Number(b.delta);
    if (!Number.isInteger(delta) || delta === 0 || !b.note)
      throw new ApiError(400, 'delta (entier non nul) et note requis', 'invalid_body');
    if (u.premiumBalance + delta < 0)
      throw new ApiError(402, 'Solde de monnaie premium insuffisant', 'insufficient_premium');
    u.premiumBalance += delta;
    log('user.wallet', `user:${id}`, null, { delta, note: b.note, balance: u.premiumBalance });
    return { ok: true, balance: u.premiumBalance };
  });
  on('GET', '/admin/api/users/:id/export', ([id]) => {
    need('superadmin');
    const u = userOr(id!);
    log('user.export', `user:${id}`);
    return {
      exportedAt: new Date().toISOString(),
      service: 'Red Line',
      account: u,
      purchases: purchases.filter((p) => p.userId === u.id),
      games: games
        .filter((g) => g.players.some((p) => p.userName === u.displayName))
        .map((g) => g.game.id),
    };
  });
  on('DELETE', '/admin/api/users/:id', ([id], b) => {
    const me = need('superadmin');
    notSelf(me, id!);
    const u = userOr(id!);
    if (u.deletedAt) throw new ApiError(409, 'Compte déjà supprimé', 'already_deleted');
    if (u.role === 'superadmin')
      throw new ApiError(409, 'Retirez d’abord le rôle superadmin de ce compte', 'superadmin');
    if (b.confirm !== u.displayName)
      throw new ApiError(
        400,
        'Confirmation incorrecte (nom du compte attendu)',
        'confirm_mismatch',
      );
    const now = new Date().toISOString();
    Object.assign(u, {
      email: null,
      displayName: `Compte supprimé ${u.id.slice(0, 6)}`,
      role: 'player',
      unlimited: false,
      bannedAt: now,
      bannedUntil: null,
      banReason: 'Compte supprimé (RGPD)',
      deletedAt: now,
    });
    log('user.delete', `user:${id}`, null, { deletedAt: now });
    return { ok: true, deletedGames: 1 };
  });

  // ——— Parties
  on('GET', '/admin/api/games/archive', (_p, _b, q) => {
    need('moderator');
    const t = (q.get('q') ?? '').toLowerCase();
    return {
      games: archived.filter((g) => !t || g.name.toLowerCase().includes(t) || g.id.includes(t)),
    };
  });
  on('POST', '/admin/api/games/:id/end', ([id], b) => {
    need('superadmin');
    const i = games.findIndex((g) => g.game.id === id);
    if (i < 0) throw new ApiError(404, 'Partie introuvable', 'not_found');
    const g = games[i]!;
    games.splice(i, 1);
    archived.unshift({
      id: g.game.id,
      name: g.game.name,
      mode: g.game.mode,
      scenarioId: g.game.scenarioId,
      endReason: 'admin',
      winner: null,
      createdAt: g.game.createdAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      stateBytes: 430_000,
      unranked: true,
      humans: g.players.filter((p) => p.userId).length,
    });
    log('game.end', `game:${id}`, null, { message: b.message ?? null });
    return { ok: true };
  });
  on('DELETE', '/admin/api/games/:id', ([id], b) => {
    need('superadmin');
    const live = games.findIndex((g) => g.game.id === id);
    const arch = archived.findIndex((g) => g.id === id);
    const name = live >= 0 ? games[live]!.game.name : arch >= 0 ? archived[arch]!.name : null;
    if (name === null) throw new ApiError(404, 'Partie introuvable', 'not_found');
    if (b.confirm !== name && b.confirm !== id!.slice(0, 8))
      throw new ApiError(
        400,
        'Confirmation incorrecte (nom de la partie attendu)',
        'confirm_mismatch',
      );
    if (live >= 0) games.splice(live, 1);
    if (arch >= 0) archived.splice(arch, 1);
    log('game.delete', `game:${id}`, { name });
    return { ok: true };
  });
}
