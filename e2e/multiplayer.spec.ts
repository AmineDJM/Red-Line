import { expect, test, type Page } from '@playwright/test';
import { newPlayerPage, preparePage, waitGameReady } from './helpers.js';

/**
 * Multijoueur à deux comptes (deux contextes de navigateur) puis spectateur :
 *  - A crée un salon (France) → salle d'attente ;
 *  - B le rejoint depuis la liste du lobby (Allemagne) → salle d'attente, où A le voit arriver ;
 *  - A lance la partie → A et B basculent dans la partie, chacun avec sa nation ;
 *  - C observe la partie en spectateur (vue publique, sans ordres).
 */
async function pickNation(page: Page, name: string, confirm: string) {
  await page.getByPlaceholder('Rechercher une nation…').fill(name);
  await page
    .locator('.nation-row', { hasText: new RegExp(`^${name}`) })
    .first()
    .click();
  await page.getByRole('button', { name: confirm }).click();
}

test('lobby à deux joueurs et spectateur', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const lobbyName = `E2E ${info.project.name} ${Date.now() % 100000}`;
  const errorsA = await preparePage(page);

  // A : accueil → Multijoueur → créer un salon.
  await page.goto('/');
  await page.getByRole('button', { name: 'Jouer en invité' }).click();
  await page.waitForURL('**/new');
  await page.goto('/lobby');
  await page.getByTestId('lobby-create').click();
  await page.waitForURL('**/lobby/new');
  const name = page.getByLabel('Nom de la partie');
  await name.fill(lobbyName);
  await page.getByRole('button', { name: 'Choisir ma nation' }).click();
  await pickNation(page, 'France', 'Créer la partie');
  await page.waitForURL('**/room');
  const gameId = decodeURIComponent(page.url().split('/lobby/')[1]!.split('/')[0]!);
  await expect(page.getByTestId('lobby-players')).toContainText('France');
  await page.screenshot({ path: info.outputPath('1-salle-hote.png') });

  // B : rejoint depuis la liste du lobby.
  const b = await newPlayerPage(browser, info, page);
  const errorsB = await preparePage(b);
  await b.goto('/');
  await b.getByRole('button', { name: 'Jouer en invité' }).click();
  await b.waitForURL('**/new');
  await b.goto('/lobby');
  const row = b.locator('tr', { hasText: lobbyName });
  await row.getByRole('button', { name: 'Rejoindre' }).click();
  await b.waitForURL(`**/lobby/${gameId}`);
  await pickNation(b, 'Allemagne', 'Rejoindre');
  await b.waitForURL('**/room');
  await expect(b.getByTestId('lobby-players')).toContainText('Allemagne');
  await expect(b.getByTestId('lobby-start')).toHaveCount(0);
  // L'hôte voit arriver le second joueur (rafraîchissement automatique).
  await expect(page.getByTestId('lobby-players')).toContainText('Allemagne', { timeout: 15_000 });

  // A lance : les deux joueurs basculent dans la partie.
  await page.getByTestId('lobby-start').click();
  await page.waitForURL(`**/game/${gameId}`);
  await b.waitForURL(`**/game/${gameId}`, { timeout: 30_000 });
  await Promise.all([waitGameReady(page), waitGameReady(b)]);
  expect(await page.evaluate(() => window.__rl.game.getState().me)).toBe('fra');
  expect(await b.evaluate(() => window.__rl.game.getState().me)).toBe('deu');
  const players = await page.evaluate(() =>
    Object.values<any>(window.__rl.game.getState().view.nations)
      .filter((n) => n.isPlayer)
      .map((n) => n.id)
      .sort(),
  );
  expect(players).toEqual(['deu', 'fra']);
  await b.screenshot({ path: info.outputPath('2-partie-joueur-b.png') });
  // Libère le moteur de rendu logiciel des tests avant d'ouvrir une troisième carte.
  await b.context().close();
  await page.goto('about:blank');

  // C : spectateur (partie multijoueur publique lancée).
  const c = await newPlayerPage(browser, info, page);
  const errorsC = await preparePage(c);
  await c.goto('/');
  await c.getByRole('button', { name: 'Jouer en invité' }).click();
  await c.waitForURL('**/new');
  await c.goto('/lobby');
  await c.getByRole('button', { name: 'Tout' }).click();
  await c.locator('tr', { hasText: lobbyName }).getByRole('button', { name: 'Observer' }).click();
  await c.waitForURL(`**/spectate/${gameId}`);
  await waitGameReady(c);
  expect(await c.evaluate(() => window.__rl.game.getState().view.spectator)).toBe(true);
  await expect(c.locator('.topbar__spect').first()).toBeVisible();
  await c.screenshot({ path: info.outputPath('3-spectateur.png') });

  expect([...errorsA, ...errorsB, ...errorsC]).toEqual([]);
  await c.context().close();
});
