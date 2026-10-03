import { expect, test, type Page } from '@playwright/test';
import { isMobile, openWindow, preparePage, setSpeed, startSoloGame } from './helpers';

/**
 * Opérations du QG, de bout en bout (vrai serveur, vraies données) : le joueur ouvre le centre de
 * commandement, lance « Nouvelle opération », vise la Belgique (recherche), choisit « Conquête
 * totale », garde l'état-major proposé (plusieurs généraux, un par commandement recommandé, deux de
 * l'armée de terre), confirme, puis suit le tableau de bord jusqu'à la conquête — sur ordinateur et
 * sur mobile. Aucune position ni unité figée : tout est lu dans la partie.
 */

const SHOTS = process.env.E2E_SHOTS;

async function shot(page: Page, name: string, mobile: boolean) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${SHOTS}/ops-${mobile ? 'mobile' : 'desktop'}-${name}.png`,
    animations: 'disabled',
  });
}

test('opérations : conquête totale de la Belgique par plusieurs généraux', async ({
  page,
}, info) => {
  test.setTimeout(900_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');

  // 1. Centre de commandement : l'onglet Opérations s'ouvre d'office.
  await page.getByTestId('command-button').click();
  await expect(page.getByTestId('op-new')).toBeVisible();
  await shot(page, '0-empty', mobile);
  await page.getByTestId('op-new').click();
  await expect(page.getByTestId('op-wizard')).toBeVisible();

  // 2. Cibles : recherche, puis sélection de la Belgique.
  await page.getByTestId('op-search').fill('Belg');
  await page.getByTestId('op-nation-bel').click();
  await expect(page.getByTestId('op-targets')).toContainText('Belgique');
  await shot(page, '1-targets', mobile);
  await page.getByTestId('op-next').click();

  // 3. Objectif : conquête totale, audacieuse ; estimation affichée.
  await page.getByTestId('op-goal-conquest').click();
  const bold = page.getByTestId('op-params').getByRole('radio', { name: 'Audacieuse' });
  await bold.click();
  await expect(bold).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('op-estimate')).toBeVisible();
  await shot(page, '2-goal', mobile);
  await page.getByTestId('op-next').click();

  // 4. Généraux : état-major proposé d'office (plusieurs généraux, deux de l'armée de terre).
  await expect(page.getByTestId('op-branch-land')).toBeVisible();
  const picked = page.locator('.ops-grow.is-on');
  await expect.poll(() => picked.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('op-branch-land').locator('.ops-grow.is-on')).toHaveCount(2);
  await shot(page, '3-staff', mobile);
  await page.getByTestId('op-next').click();

  // 5. Confirmation.
  await expect(page.getByTestId('op-summary')).toBeVisible();
  await page.getByTestId('op-name').fill('Tempête');
  await shot(page, '4-confirm', mobile);
  await page.getByTestId('op-confirm').click();
  await expect(page.getByTestId('op-wizard')).toBeHidden();

  const readOp = () =>
    page.evaluate(() => {
      const o = window.__rl.game.getState().view.command?.ops?.[0];
      return o
        ? {
            id: o.id as string,
            status: o.status as string,
            commanders: o.commanders.length as number,
            roles: o.commanders.map((c: { role: string }) => c.role) as string[],
            done: (o.progress.find((p: { key: string }) => p.key === 'provinces')?.done ??
              0) as number,
            total: (o.progress.find((p: { key: string }) => p.key === 'provinces')?.total ??
              0) as number,
          }
        : null;
    });
  await expect.poll(readOp).not.toBeNull();
  const op = (await readOp())!;
  expect(op.commanders).toBeGreaterThanOrEqual(3);
  expect(op.roles.filter((r) => r === 'land').length).toBe(2);
  expect(op.total).toBeGreaterThan(0);

  // 6. Tableau de bord (mobile : il s'ouvre aussi d'office).
  await expect(page.getByTestId('op-detail')).toBeVisible();
  await expect(page.getByTestId('op-staff')).toContainText('Commandant terrestre');
  await expect(page.getByTestId('op-headline')).toContainText('provinces prises');
  await shot(page, '5-dashboard', mobile);

  // 7. Carte : pays visés soulignés (couche dédiée), flèches des généraux.
  expect(await page.evaluate(() => !!window.__rlMap.map.getLayer('cmd-targets-line'))).toBe(true);

  // 8. Général en chef de l'armée de terre (onglet Généraux), puis ministère de la Défense :
  // les commandements y affichent chef et opération en cours (contrat `command.commands`).
  await page.getByRole('tab', { name: /Généraux/ }).click();
  await expect(page.getByTestId('branch-land')).toBeVisible();
  await page.locator('[data-testid^="chief-"]:enabled').first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__rl.game.getState().view.command?.commands?.[0]?.chief?.name ?? null,
      ),
    )
    .not.toBeNull();
  const chief = (await page.evaluate(
    () => window.__rl.game.getState().view.command.commands[0].chief.name,
  )) as string;
  await expect(page.getByTestId('branch-land')).toContainText(chief);
  // Fenêtre Gouvernement (sur mobile, le QG plein écran recouvre la barre du haut).
  await openWindow(page, 'government');
  await expect(page.locator('#win-government')).toBeVisible();
  await page.getByTestId('gov-section-commands').click();
  const commands = page.getByTestId('gov-commands');
  await expect(commands).toContainText(chief);
  await expect(commands).toContainText('Opérations : 1');
  await shot(page, '8-gov-commands', mobile);
  // Retour au tableau de bord de l'opération.
  await page.evaluate(() => window.__rl.ui.getState().closeWindow('government'));
  await expect(page.locator('#win-government')).toBeHidden();
  if (!(await page.locator('#win-command').isVisible())) await openWindow(page, 'command');
  await page.getByRole('tab', { name: /Opérations/ }).click();
  if (!(await page.getByTestId('op-detail').isVisible()))
    await page.getByTestId(`op-row-${op.id}`).click();
  await expect(page.getByTestId('op-detail')).toBeVisible();

  // 9. Vitesse d'essai : les généraux prennent les provinces au fil du temps, jusqu'au succès.
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await readOp())?.done ?? 0, { timeout: 600_000, intervals: [2_000] })
    .toBeGreaterThan(0);
  await shot(page, '6-progress', mobile);
  await expect
    .poll(async () => (await readOp())?.status, { timeout: 600_000, intervals: [2_000] })
    .toBe('success');
  const end = (await readOp())!;
  expect(end.done).toBe(end.total);
  await setSpeed(page, 1);
  await expect(page.getByTestId('op-journal')).toContainText('est prise');
  await shot(page, '7-success', mobile);
  expect(errors).toEqual([]);
});
