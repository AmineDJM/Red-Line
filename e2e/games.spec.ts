import { expect, test } from '@playwright/test';
import { acceptLegalViaApi, preparePage, waitGameReady } from './helpers.js';

/**
 * « Mes parties » : suppression d'une partie solo (confirmation, liste rafraîchie) et partie supprimée
 * pendant qu'elle est ouverte (retour à l'accueil avec un message, sans boucle de reconnexion).
 */
test('supprimer une partie solo', async ({ page }, info) => {
  const errors = await preparePage(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Jouer en invité' }).click();
  await page.waitForURL('**/new');
  await acceptLegalViaApi(page);
  const create = async (nationId: string) => {
    const res = await page.request.post('/api/games', {
      data: { scenarioId: 'world-today', nationId, mode: 'solo', speed: 1, aiLevel: 'normal' },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { game: { id: string; name: string } }).game;
  };
  const a = await create('prt');
  const b = await create('irl');

  // 1. Suppression depuis la liste, avec confirmation.
  await page.goto('/games');
  const rowA = page.locator('tr', { hasText: a.name });
  await expect(rowA).toBeVisible();
  await rowA.getByTestId('game-delete').click();
  const dialog = page.getByRole('dialog', { name: 'Supprimer la partie' });
  await expect(dialog).toContainText('Supprimer définitivement cette partie ?');
  await page.screenshot({ path: info.outputPath('1-confirmation.png') });
  await dialog.getByTestId('game-delete-confirm').click();
  await expect(rowA).toHaveCount(0);
  await expect(page.locator('tr', { hasText: b.name })).toBeVisible();

  // 2. Partie ouverte supprimée ailleurs : retour à l'accueil avec un message.
  await page.goto(`/game/${b.id}`);
  await waitGameReady(page);
  const del = await page.request.delete(`/api/games/${b.id}`);
  expect(del.ok()).toBe(true);
  await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
  await expect(page.getByTestId('home-flash')).toContainText('supprimée');
  await page.screenshot({ path: info.outputPath('2-accueil.png') });
  expect(errors).toEqual([]);
});
