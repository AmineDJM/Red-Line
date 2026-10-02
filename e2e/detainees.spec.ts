import { expect, test } from '@playwright/test';
import { closeWindows, openWindow, preparePage, setSpeed, startSoloGame } from './helpers.js';

/**
 * Détenus (Algérie, 2025) : en guerre contre le Maroc, nos opérations clandestines finissent par être
 * éventées et un de nos officiers (couverture non officielle) est arrêté ; l'IA marocaine l'interroge
 * puis le garde (ou l'exécute : on recommence alors). Dans la console de renseignement, onglet
 * « Détenus », l'agent figure parmi « nos agents détenus à l'étranger » ; le joueur négocie sa
 * libération contre de l'argent dans le dialogue de négociation ; l'IA accepte (ou contre-propose et
 * l'on accepte sa contre-proposition) : l'agent rentre au pays.
 */
test('nos agents détenus à l’étranger : négociation de leur libération', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors = await preparePage(page);
  await startSoloGame(page, 'Algérie');
  const send = (order: unknown) =>
    page.evaluate((o) => window.__rl.game.getState().connection.sendOrder(o), order);
  expect((await send({ kind: 'declareWar', nationId: 'mar' })).ok).toBe(true);

  const held = () =>
    page.evaluate(
      () =>
        (window.__rl.game.getState().view.intel?.agents ?? []).find(
          (a: any) =>
            a.nationId === 'mar' && ['held', 'interrogation', 'jailed'].includes(a.detention?.fate),
        )?.id ?? null,
    );
  // Accélération d'essai : implantations et intoxications répétées jusqu'à une arrestation.
  await setSpeed(page, 3600);
  await expect
    .poll(
      async () => {
        const id = await held();
        if (id) return id;
        await page.evaluate(async () => {
          const s = window.__rl.game.getState();
          const c = s.connection;
          const running = (s.view.intel?.operations ?? []).filter(
            (o: any) => o.status === 'running' && o.dept === 'exterior',
          ).length;
          if (running >= 2) return;
          await c.sendOrder({
            kind: 'intelOp',
            op: 'infiltrate_spy',
            target: { nationId: 'mar', cover: 'nonofficial' },
          });
          await c.sendOrder({
            kind: 'intelOp',
            op: 'plant_fake_report',
            target: { nationId: 'mar' },
          });
        });
        return null;
      },
      { timeout: 480_000, intervals: [3000] },
    )
    .not.toBeNull();
  await setSpeed(page, 1);
  const id = (await held())!;

  await closeWindows(page);
  await openWindow(page, 'intel', { tab: 'detainees' });
  const tab = page.getByTestId('intel-detainees');
  const row = tab.getByTestId(`abroad-${id}`);
  await expect(row).toContainText('Maroc');
  await row.getByTestId(`negotiate-${id}`).click();
  const dialog = page.getByRole('dialog', { name: /^Négociation/ });
  await expect(dialog).toContainText('Négociation');
  await expect(dialog.getByRole('checkbox').first()).toBeChecked();
  await dialog.getByRole('radio', { name: 'Nous payons' }).click();
  await dialog.locator('select').nth(1).selectOption({ index: 5 });
  await page.screenshot({ path: info.outputPath('1-negociation.png') });
  await dialog.getByTestId('swap-send').click();
  const swap = () =>
    page.evaluate(() => {
      const v = window.__rl.game.getState().view;
      return (v.intel?.swaps ?? []).map((s: any) => ({
        id: s.id,
        from: s.from,
        status: s.status,
        counter: !!s.counter,
      }));
    });
  await expect.poll(async () => (await swap()).length).toBeGreaterThan(0);
  // Réponse de l'IA (quelques heures de jeu) : acceptation, ou contre-proposition à accepter.
  await setSpeed(page, 3600);
  await expect
    .poll(
      async () => {
        const list = await swap();
        const counter = list.find((s) => s.from === 'mar' && s.status === 'open');
        if (counter) {
          await setSpeed(page, 1);
          await page.getByTestId(`swap-accept-${counter.id}`).click();
        }
        return list.some((s) => s.status === 'accepted');
      },
      { timeout: 90_000, intervals: [2000] },
    )
    .toBe(true);
  await setSpeed(page, 1);
  await expect
    .poll(() =>
      page.evaluate(
        (x) =>
          window.__rl.game.getState().view.intel.agents.find((a: any) => a.id === x)?.detention
            ?.fate,
        id,
      ),
    )
    .toBe('exchanged');
  await expect(row).toContainText('Échangé');
  await page.screenshot({ path: info.outputPath('2-libere.png') });
  expect(errors).toEqual([]);
});
