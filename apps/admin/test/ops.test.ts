/** Économie du service et gestion complète : serveur factice (contrat REST), CSV, formats, routes. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_SETTINGS } from '@redline/shared';
import { createApi } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { toCsv } from '../src/lib/csv';
import { money } from '../src/lib/money';
import { href, parseHash } from '../src/lib/router';
import { SCREENS, screenOf } from '../src/lib/screens';

const login = async (role?: 'moderator' | 'balance' | 'superadmin') => {
  const api = createApi(createMockTransport({ role, latencyMs: 0 }));
  await api.login({ email: 'a@b.fr', password: 'x' });
  return api;
};

describe('économie du service (serveur factice)', () => {
  it('tableau de bord : coûts attribués, cohortes, séries, alertes', async () => {
    const api = await login();
    const d = await api.costDashboard('month');
    expect(d.report.cost.total).toBeGreaterThan(0);
    expect(d.report.cohorts.free.users).toBeGreaterThan(0);
    expect(d.report.topUsers.length).toBeGreaterThan(0);
    expect(d.report.users).toBeUndefined();
    expect(d.series.length).toBeGreaterThan(0);
    const total = Object.entries(d.report.cost)
      .filter(([k]) => k !== 'total')
      .reduce((a, [, v]) => a + v, 0);
    expect(d.report.cost.total).toBeCloseTo(total, 9);
    const full = await api.costReportFull('7d');
    expect(full.report.users!.length).toBeGreaterThanOrEqual(full.report.topUsers.length);
  });

  it('RBAC : coûts et annonces réservés au superadmin, paramètres serveur lisibles par la modération', async () => {
    const mod = await login('moderator');
    await expect(mod.costDashboard('month')).rejects.toMatchObject({ status: 403 });
    await expect(mod.announcements()).rejects.toMatchObject({ status: 403 });
    const s = await mod.serverSettings();
    expect(s.settings.maxActiveSoloPerUser).toBe(10);
    await expect(mod.saveServerSettings(s.settings)).rejects.toMatchObject({ status: 403 });
    await expect(mod.deleteGame('x', 'x')).rejects.toMatchObject({ status: 403 });
  });

  it('paramètres de coût : validation et journal', async () => {
    const api = await login();
    const bad = {
      ...DEFAULT_COST_SETTINGS,
      compute: { ...DEFAULT_COST_SETTINGS.compute, plan: 'zzz' },
    };
    await expect(api.saveCostSettings(bad)).rejects.toMatchObject({ status: 400 });
    const ok = await api.saveCostSettings({
      ...DEFAULT_COST_SETTINGS,
      compute: { ...DEFAULT_COST_SETTINGS.compute, plan: 'pro' },
    });
    expect(ok.settings.compute.plan).toBe('pro');
    const d = await api.costDashboard('24h');
    expect(d.report.plan.id).toBe('pro');
    const { entries } = await api.auditQuery({ action: 'costs.' });
    expect(entries[0]!.action).toBe('costs.settings');
  });

  it('dépenses et annonces', async () => {
    const api = await login();
    const { entry } = await api.addCostEntry({
      day: new Date().toISOString().slice(0, 10),
      category: 'video_api',
      label: 'Essai',
      amountUsd: 3,
      monthly: false,
    });
    expect((await api.costEntries()).entries.some((e) => e.id === entry.id)).toBe(true);
    await api.deleteCostEntry(entry.id);
    expect((await api.costEntries()).entries.some((e) => e.id === entry.id)).toBe(false);
    const r = await api.createAnnouncement({
      text: 'Bonjour',
      level: 'info',
      endsAt: new Date(Date.now() + 3600_000).toISOString(),
      active: true,
      broadcast: true,
    });
    expect(r.sent).toBeGreaterThan(0);
    await api.updateAnnouncement(r.announcement.id, { active: false });
    expect(
      (await api.announcements()).announcements.find((a) => a.id === r.announcement.id)!.active,
    ).toBe(false);
  });

  it('comptes : filtre, suspension, portefeuille, mot de passe provisoire, suppression RGPD', async () => {
    const api = await login();
    const { users } = await api.searchUsers({ filter: 'guest' });
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => u.isGuest)).toBe(true);
    const target = (await api.listUsers()).users.find((u) => u.role === 'player' && u.email)!;
    const s = await api.suspendUser(target.id, 24, 'test');
    expect(Date.parse(s.bannedUntil)).toBeGreaterThan(Date.now());
    const w = await api.adjustWallet(target.id, 50, 'geste');
    expect(w.balance).toBe(target.premiumBalance + 50);
    await expect(api.adjustWallet(target.id, -1e6, 'trop')).rejects.toMatchObject({ status: 402 });
    expect((await api.resetPassword(target.id)).password.length).toBeGreaterThan(6);
    const ov = await api.userOverview(target.id);
    expect(ov.sessions).toHaveLength(0);
    await expect(api.deleteUser(target.id, 'mauvais')).rejects.toMatchObject({ status: 400 });
    await api.deleteUser(target.id, target.displayName);
    const after = await api.getUser(target.id);
    expect(after.user.email).toBeNull();
    expect(after.user.deletedAt).toBeTruthy();
  });

  it('parties : fin imposée (archives) puis suppression confirmée', async () => {
    const api = await login();
    const g = (await api.listGames()).games.find((x) => x.game.status === 'running')!;
    await api.endGame(g.game.id, 'Fin');
    const { games } = await api.archivedGames();
    expect(games[0]).toMatchObject({ id: g.game.id, endReason: 'admin' });
    await expect(api.deleteGame(g.game.id, 'non')).rejects.toMatchObject({ status: 400 });
    await api.deleteGame(g.game.id, g.game.id.slice(0, 8));
    expect((await api.archivedGames()).games.some((x) => x.id === g.game.id)).toBe(false);
  });
});

describe('outils', () => {
  it('CSV : séparateur « ; », guillemets, décimales à la française', () => {
    const csv = toCsv(
      [{ a: 'x;y', b: 1.5, c: null }],
      [
        ['a', (r) => r.a],
        ['b', (r) => r.b],
        ['c', (r) => r.c],
      ],
    );
    expect(csv).toBe('a;b;c\r\n"x;y";1,5;');
  });
  it('montants en dollars précis', () => {
    expect(money(0.0042)).toMatch(/^0,0042\s\$$/);
    expect(money(12.5)).toMatch(/^12,50\s\$$/);
    expect(money(-3)).toMatch(/^−3,00\s\$$/);
  });
  it('routes et écrans ajoutés en fin de menu', () => {
    expect(parseHash('#/economy/settings')).toEqual({ name: 'economy', tab: 'settings' });
    expect(parseHash('#/economy/zzz')).toEqual({ name: 'economy', tab: 'dashboard' });
    expect(href({ name: 'economy', tab: 'entries' })).toBe('#/economy/entries');
    for (const n of ['announcements', 'settings', 'archive'] as const) {
      expect(parseHash(href({ name: n }))).toEqual({ name: n });
      expect(screenOf({ name: n })).toBeDefined();
    }
    expect(SCREENS.find((s) => s.id === 'economy')!.role).toBe('superadmin');
  });
});
