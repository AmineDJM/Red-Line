import { expect, test } from '@playwright/test';
import {
  E2E_ADMIN,
  acceptLegalViaApi,
  closeWindows,
  isMobile,
  openWindow,
  preparePage,
  waitGameReady,
} from './helpers.js';

/**
 * Compte administrateur (ADMIN_EMAIL) en mode illimité d'office : « ∞ » et badge « ILLIMITÉ » dans la
 * barre du haut, production d'un matériel très cher acceptée (20 destroyers importés ≈ 57 Md$, bien
 * au-delà de la trésorerie de départ de la France).
 */
test('compte illimité : ∞ dans la barre du haut, production très chère acceptée', async ({
  page,
}, info) => {
  const errors = await preparePage(page);
  await page.goto('/');
  const login = await page.request.post('/api/auth/login', { data: E2E_ADMIN });
  expect(login.ok()).toBe(true);
  expect(((await login.json()) as { user: { unlimited?: boolean } }).user.unlimited).toBe(true);
  await acceptLegalViaApi(page);
  const res = await page.request.post('/api/games', {
    data: { scenarioId: 'world-today', nationId: 'fra', mode: 'solo', speed: 1, aiLevel: 'normal' },
  });
  expect(res.ok()).toBe(true);
  const game = ((await res.json()) as { game: { id: string } }).game;

  await page.goto(`/game/${game.id}`);
  await waitGameReady(page);
  await expect(page.getByTestId('unlimited-badge')).toHaveText('ILLIMITÉ');
  await expect(page.getByTestId('treasury')).toContainText('∞');
  await page.locator('header.topbar').screenshot({ path: info.outputPath('1-barre-du-haut.png') });

  const r = await page.evaluate(() =>
    window.__rl.game.getState().connection.sendOrder({
      kind: 'produce',
      provinceId: 'fra-1',
      systemId: 'us.arleigh-burke',
      count: 20,
    }),
  );
  expect(r).toMatchObject({ ok: true });
  await page.waitForFunction(() =>
    window.__rl.game
      .getState()
      .view.economy.production.some((p: { systemId: string }) => p.systemId === 'us.arleigh-burke'),
  );
  await openWindow(page, 'production', { tab: 'queue' });
  const prod = page.locator('#win-production');
  await expect(prod).toContainText('Arleigh Burke');
  // Trésor « ∞ » dans l'en-tête de la fenêtre (masqué sur mobile, faute de place).
  if (!isMobile(info)) await expect(prod).toContainText('∞');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('2-production.png') });
  await closeWindows(page);
  await openWindow(page, 'economy');
  const eco = page.locator('#win-economy');
  await expect(eco).toContainText('Réserve illimitée');
  await expect(eco).not.toContainText('Déficit');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('3-economie.png') });
  expect(errors).toEqual([]);
});
