import { expect, test } from '@playwright/test';
import { openWindow, preparePage, startSoloGame } from './helpers.js';

/**
 * Diplomatie (France, 2025) : déclarer la guerre à la Belgique depuis la fenêtre Diplomatie (avec
 * confirmation), puis proposer la paix ; la proposition part (ou l'IA l'accepte aussitôt).
 */
test('déclarer la guerre puis proposer la paix', async ({ page }, info) => {
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');
  const relation = () =>
    page.evaluate(() => {
      const r = window.__rl.game
        .getState()
        .view.diplomacy.relations.find((x: any) => x.nationId === 'bel');
      return r ? { relation: r.relation, pending: r.pending?.from ?? null } : null;
    });

  await openWindow(page, 'diplomacy');
  const win = page.locator('#win-diplomacy');
  // La Belgique est frontalière : elle figure dans le filtre par défaut « Voisins et relations ».
  const row = win.locator('tr', { hasText: 'Belgique' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Déclarer la guerre' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Belgique');
  await dialog.getByRole('button', { name: 'Déclarer la guerre' }).click();
  await expect.poll(async () => (await relation())?.relation).toBe('war');
  await expect(row).toContainText('Guerre');
  await page.screenshot({ path: info.outputPath('1-guerre.png') });

  await row.getByRole('button', { name: 'Paix', exact: true }).click();
  await expect
    .poll(async () => {
      const r = await relation();
      return r?.pending === 'fra' || r?.relation === 'peace';
    })
    .toBe(true);
  const r = await relation();
  if (r?.relation === 'war') await expect(row).toContainText('proposition envoyée');
  await page.screenshot({ path: info.outputPath('2-paix.png') });
  expect(errors).toEqual([]);
});
