import { expect, test } from '@playwright/test';
import {
  capitalOf,
  closeWindows,
  isMobile,
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
 *  - reconnaissance de toute l'Espagne depuis un toucher sur la carte (bloc « pays » de la fiche) ;
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
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1-madrid-revele.png') });

  await openWindow(page, 'intel');
  await expect(page.locator('#win-intel')).toContainText('Reconnaissance militaire');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('2-rapport.png') });
  expect(errors).toEqual([]);
});

/**
 * Reconnaissance d'un pays entier : un toucher n'importe où sur l'Espagne (ici l'Estrémadure, loin de
 * Madrid) ouvre la fiche, dont le bloc « Renseignement sur le pays » lance la mission sans choisir de
 * province ; les phases révèlent les bâtiments de plusieurs provinces (vue, carte), rapport final.
 */
test('reconnaissance militaire de tout un pays depuis un clic sur la carte', async ({
  page,
}, info) => {
  // Mission de 48 h de jeu (≈ 1 min à la vitesse d'essai), relances possibles : délai élargi.
  test.setTimeout(480_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'Algérie');
  const spain = await page.evaluate(() =>
    Object.values<any>(window.__rl.world.getState().provinces)
      .filter((p) => p.nationId === 'esp')
      .map((p) => p.id as string),
  );
  expect(spain.length).toBeGreaterThan(5);
  const revealed = () =>
    page.evaluate((ids) => {
      const v = window.__rl.game.getState().view;
      return ids.filter((id) => v.provinces[id].buildings.length > 0);
    }, spain);
  expect(await revealed()).toEqual([]);

  // Toucher sur la carte, loin de la capitale (centre de la Castille-et-León).
  const target = await page.evaluate(() => {
    const p = Object.values<any>(window.__rl.world.getState().provinces).find(
      (x) => x.nationId === 'esp' && x.name === 'Castille-et-León',
    );
    return p.centroid as [number, number];
  });
  const panel = page.getByTestId('province-panel');
  for (let i = 0; i < 4 && !(await panel.isVisible()); i++) {
    const at = await page.evaluate(
      ([ll, k]) => {
        const m = window.__rlMap.map;
        // Léger décalage à chaque essai (unité ou étiquette sous le doigt).
        const c: [number, number] = [ll[0] + k * 0.25, ll[1] - k * 0.15];
        m.jumpTo({ center: c, zoom: 5.4 });
        const pt = m.project(c);
        const r = m.getCanvas().getBoundingClientRect();
        return { x: r.left + pt.x, y: r.top + pt.y };
      },
      [target, i] as const,
    );
    await page.waitForFunction(() => window.__rlMap.map.loaded());
    if (mobile) await page.touchscreen.tap(at.x, at.y);
    else await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(400);
  }
  await expect(panel).toBeVisible();
  const picked = await page.evaluate(() => window.__rl.ui.getState().selectedProvince);
  expect(spain).toContain(picked);
  const card = panel.getByTestId('nation-recon');
  await expect(card).toContainText('Espagne');
  await expect(card.getByTestId('nation-recon-count-recon_military')).toHaveText(
    `0/${spain.length}`,
  );
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1-fiche-pays.png') });

  const running = () =>
    page.evaluate(
      () =>
        window.__rl.game
          .getState()
          .view.intel.operations.find(
            (o: any) =>
              o.kind === 'recon_military' &&
              o.target.nationId === 'esp' &&
              !o.target.provinceId &&
              o.status === 'running',
          ) ?? null,
    );
  const launch = card.getByTestId('nation-recon-launch-recon_military');
  await launch.click();
  await expect(
    page.locator('.rl-toast').filter({ hasText: "Reconnaissance militaire lancée sur l'Espagne" }),
  ).toBeVisible();
  await expect.poll(running).not.toBeNull();
  const op = await running();
  expect(op.recon).toMatchObject({ waves: 4, done: 0 });
  await expect(launch).toBeDisabled();
  await expect(card.getByTestId('nation-recon-recon_military')).toContainText('Phase 0/4');

  // Accélération d'essai : 48 h de jeu en 4 phases. Une mission peut échouer ou être repérée : on
  // relance comme le ferait un joueur, jusqu'à la révélation de plusieurs provinces.
  await setSpeed(page, 3600);
  let sawPhase = false;
  for (let attempt = 0; attempt < 4 && (await revealed()).length < 2; attempt++) {
    if (attempt > 0) {
      await expect(launch).toBeEnabled();
      await launch.click();
      await expect.poll(running).not.toBeNull();
    }
    await expect
      .poll(
        async () => {
          const o = await running();
          if (o && o.recon.done > 0) sawPhase = true;
          return o;
        },
        { timeout: 150_000, intervals: [500] },
      )
      .toBeNull();
  }
  await setSpeed(page, 1);
  const shown = await revealed();
  expect(shown.length).toBeGreaterThanOrEqual(2);
  // Phases intermédiaires observées (révélation progressive, pas tout à la fin).
  expect(sawPhase).toBe(true);
  // Capitale et grandes villes d'abord.
  const madrid = await capitalOf(page, 'esp');
  expect(
    await page.evaluate((id) => window.__rl.game.getState().view.provinces[id].intel.m, madrid),
  ).toBeGreaterThanOrEqual(2);
  await expect(card.getByTestId('nation-recon-count-recon_military')).not.toHaveText(
    `0/${spain.length}`,
  );
  await page.screenshot({ animations: 'disabled', path: info.outputPath('2-fiche-apres.png') });

  // Les bâtiments révélés sont dessinés sur la carte, dans plusieurs provinces.
  let drawn = 0;
  for (const id of shown.slice(0, 3)) {
    const n = await page.evaluate(async (pid) => {
      const m = window.__rlMap.map;
      const d = window.__rl.world.getState().provinces[pid];
      m.jumpTo({ center: d.cityPoint, zoom: 7 });
      await new Promise((r) => m.once('idle', r));
      return m
        .queryRenderedFeatures({ layers: ['bld'] })
        .filter((f: any) => f.properties.prov === pid).length;
    }, id);
    if (n > 0) drawn++;
  }
  expect(drawn).toBeGreaterThanOrEqual(2);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('3-carte.png') });

  // Rapport final, en français, avec l'article du pays.
  await openWindow(page, 'intel');
  const win = page.locator('#win-intel');
  await expect(win).toContainText('Reconnaissance militaire');
  const report = await page.evaluate(
    () =>
      window.__rl.game
        .getState()
        .view.intel.reports.find(
          (r: any) =>
            r.title.startsWith('Reconnaissance militaire') && r.subject?.nationId === 'esp',
        ) ?? null,
  );
  expect(report).not.toBeNull();
  expect(report.body).toMatch(/de l'Espagne/);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('4-rapport.png') });

  // Fenêtre de renseignement : choix de la cible « Pays entier ».
  await win.getByTestId('intel-launch-military').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: 'Pays entier' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.getByTestId('nation-recon')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('5-lancement.png') });
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await closeWindows(page);
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
  // Alger : capitale « argent seulement » (le pétrole algérien est au Sahara) : ni puits ni mine.
  await expect(panel.getByTestId('province-resources')).toBeVisible();
  await panel.getByTestId('build-toggle').click();
  await expect(panel.getByTestId('build-oil_field')).toBeDisabled();
  await expect(panel.getByTestId('build-mine')).toBeDisabled();
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
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1-chantiers.png') });
  await closeWindows(page);
  expect(errors).toEqual([]);
});
