import { expect, test } from '@playwright/test';
import {
  capitalOf,
  closeWindows,
  openWindow,
  preparePage,
  selectProvince,
  setSpeed,
  startSoloGame,
} from './helpers.js';

/**
 * Renseignement et chantiers (Algérie, 2025) :
 *  - mission « Reco. militaire » sur Madrid depuis la fiche de province → révélation progressive des
 *    bâtiments espagnols (vue, fiche et carte), rapport dans la console de renseignement ;
 *  - construction d'un bâtiment neuf et amélioration d'un bâtiment existant dans sa capitale, au coût
 *    exact publié par le moteur.
 */
test('mission de renseignement et révélation des bâtiments', async ({ page }, info) => {
  const errors = await preparePage(page);
  await startSoloGame(page, 'Algérie');
  const madrid = await capitalOf(page, 'esp');
  const known = () =>
    page.evaluate((id) => window.__rl.game.getState().view.provinces[id].buildings.length, madrid);
  expect(await known()).toBe(0);

  await selectProvince(page, madrid);
  const panel = page.getByTestId('province-panel');
  await expect(panel).toContainText('Madrid');
  await panel.getByTestId('recon-button').click();
  await expect(
    page.locator('.rl-toast').filter({ hasText: /Reconnaissance militaire/ }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__rl.game
            .getState()
            .view.intel.operations.some(
              (o: any) => o.kind === 'recon_military' && o.target.provinceId === id,
            ),
        madrid,
      ),
    )
    .toBe(true);
  await expect(panel.getByTestId('recon-button')).toBeDisabled();

  // Accélération d'essai : la mission dure 12 h de jeu. Une mission peut échouer (≈ 30 %) : on
  // relance comme le ferait un joueur, jusqu'à la révélation.
  await setSpeed(page, 3600);
  for (let attempt = 0; attempt < 5 && (await known()) === 0; attempt++) {
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.__rl.game
                .getState()
                .view.intel.operations.filter(
                  (o: any) => o.kind === 'recon_military' && o.target.provinceId === id,
                )
                .every((o: any) => o.status !== 'running'),
            madrid,
          ),
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    await expect.poll(known, { timeout: 5_000 }).toBeGreaterThanOrEqual(0);
    if ((await known()) === 0) await panel.getByTestId('recon-button').click();
  }
  await setSpeed(page, 1);
  expect(await known()).toBeGreaterThan(0);
  await expect(panel.locator('.bldgs--known .bldg').first()).toBeVisible();
  // Les bâtiments révélés sont dessinés sur la carte.
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const m = window.__rlMap.map;
        const d = window.__rl.world.getState().provinces[id];
        m.jumpTo({ center: d.cityPoint, zoom: 7 });
        const style = m.getStyle();
        const layers = style.layers
          .map((l: { id: string }) => l.id)
          .filter((l: string) => l === 'bld' || l === 'bld-reveal');
        return m.queryRenderedFeatures({ layers }).length;
      }, madrid),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('1-madrid-revele.png') });

  await openWindow(page, 'intel');
  await expect(page.locator('#win-intel')).toContainText('Reconnaissance militaire');
  await page.screenshot({ path: info.outputPath('2-rapport.png') });
  expect(errors).toEqual([]);
});

test('construire et améliorer un bâtiment', async ({ page }, info) => {
  const errors = await preparePage(page);
  await startSoloGame(page, 'Algérie');
  const alger = await capitalOf(page, 'dza');
  await selectProvince(page, alger, 7);
  const panel = page.getByTestId('province-panel');

  // Option de construction abordable (coût publié par le moteur) dans la première famille.
  const opt = await page.evaluate((id) => {
    const v = window.__rl.game.getState().view;
    const first = ['oil_field', 'refinery', 'mine', 'farm', 'electronics_plant', 'power_plant'];
    return (
      v.provinces[id].buildOptions.find(
        (o: any) => first.includes(o.type) && !o.blocked && o.cost < v.economy.money,
      ) ?? null
    );
  }, alger);
  expect(opt).not.toBeNull();
  const money0 = await page.evaluate(() => window.__rl.game.getState().view.economy.money);
  await panel.getByTestId('build-toggle').click();
  await panel.getByTestId(`build-${opt.type}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        ([id, type]) =>
          window.__rl.game
            .getState()
            .view.provinces[id].buildingState.find((b: any) => b.type === type)?.buildUntil ?? 0,
        [alger, opt.type] as const,
      ),
    )
    .toBeGreaterThan(0);
  const money1 = await page.evaluate(() => window.__rl.game.getState().view.economy.money);
  // Coût exact (à la seconde de revenus près).
  expect(Math.abs(money0 - money1 - opt.cost)).toBeLessThan(opt.cost * 0.01 + 5e6);
  await expect(panel.locator(`[data-building="${opt.type}"]`)).toContainText('En construction');

  // Amélioration d'un bâtiment existant (niveau suivant, coût publié).
  const up = await page.evaluate((id) => {
    const v = window.__rl.game.getState().view;
    return (
      v.provinces[id].buildingState.find(
        (b: any) =>
          b.next &&
          b.health >= 1 &&
          !b.upgradeUntil &&
          !b.buildUntil &&
          b.next.cost < v.economy.money,
      ) ?? null
    );
  }, alger);
  expect(up).not.toBeNull();
  await panel.getByTestId(`upgrade-${up.type}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        ([id, type]) =>
          window.__rl.game
            .getState()
            .view.provinces[id].buildingState.find((b: any) => b.type === type)?.upgradeUntil ?? 0,
        [alger, up.type] as const,
      ),
    )
    .toBeGreaterThan(0);

  // Les deux chantiers apparaissent dans le tableau de bord économique.
  await openWindow(page, 'economy');
  const eco = page.locator('#win-economy');
  await expect(eco.getByRole('heading', { name: 'Chantiers' })).toBeVisible();
  await expect(eco.getByText('Construction N1').first()).toBeVisible();
  await expect(eco.getByText(`Amélioration N${up.next.level}`).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('1-chantiers.png') });
  await closeWindows(page);
  expect(errors).toEqual([]);
});
