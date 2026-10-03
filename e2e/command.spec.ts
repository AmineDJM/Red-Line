import { expect, test, type Page } from '@playwright/test';
import { isMobile, preparePage, setSpeed, startSoloGame, type LngLat } from './helpers';

/**
 * Centre de commandement, de bout en bout (vrai serveur, vraies données) : le joueur forme une armée
 * avec ses piles proches de la Belgique, lui donne la mission « Conquérir » sur une province belge
 * frontalière désignée sur la carte, recrute un général du vivier, autorise la guerre que le général
 * demande, et voit la province prise par l'armée — sur ordinateur et sur mobile.
 */

async function tap(page: Page, x: number, y: number, mobile: boolean) {
  if (mobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

test('centre de commandement : armée, mission Conquérir, général, province prise', async ({
  page,
}, info) => {
  test.setTimeout(900_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');

  // Province belge frontalière la plus proche des piles terrestres françaises (d'après la carte).
  const plan = await page.evaluate(() => {
    const { game, world } = window.__rl;
    const view = game.getState().view;
    const { catalog, provinces } = world.getState();
    const km = (a: number[], b: number[]) =>
      Math.hypot((a[0]! - b[0]!) * Math.cos((a[1]! * Math.PI) / 180), a[1]! - b[1]!) * 111;
    const land = Object.values<any>(view.units).filter((u) => {
      const s = catalog[u.systemId];
      return u.level === 'own' && s?.movement === 'land' && s.speedKmh > 0;
    });
    let best: { pid: string; at: [number, number]; ids: string[]; score: number } | null = null;
    for (const p of Object.values<any>(provinces)) {
      if (view.provinces[p.id]?.owner !== 'bel' || p.isCapital) continue;
      if (!p.neighbors?.some((x: string) => view.provinces[x]?.owner === 'fra')) continue;
      const near = land
        .map((u) => ({ u, d: km(u.pos, p.cityPoint) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      const score = near.reduce((s, x) => s + x.d, 0);
      if (near.some((x) => catalog[x.u.systemId]?.canCapture) && (!best || score < best.score))
        best = { pid: p.id, at: p.cityPoint, ids: near.map((x) => x.u.id), score };
    }
    return best;
  });
  expect(plan).not.toBeNull();
  const { pid, at, ids } = plan!;

  // 1. Centre de commandement (barre du haut) : il s'ouvre sur les opérations ; onglet Armées,
  // nouvelle armée.
  await page.getByTestId('command-button').click();
  await page.getByRole('tab', { name: /Armées/ }).click();
  await page.getByTestId('army-new').click();
  await expect(page.getByTestId('army-wizard')).toBeVisible();
  await page.getByTestId('wizard-name').fill('1re Armée');
  for (const id of ids) await page.getByTestId(`pick-${id}`).check();
  await expect(page.getByTestId('wizard-summary')).toContainText(String(ids.length));
  await page.getByTestId('wizard-next').click();

  // 2. Mission « Conquérir », cible désignée sur la carte.
  await page.getByTestId('mission-conquer').click();
  await page.getByTestId('mission-pick').click();
  await expect(page.getByTestId('command-pick')).toBeVisible();
  await page.evaluate((p: LngLat) => window.__rlMap.map.jumpTo({ center: p, zoom: 7 }), at);
  await page.waitForTimeout(1500);
  const pt = await page.evaluate(([lng, lat]: LngLat) => {
    const m = window.__rlMap.map;
    const p = m.project([lng + 0.05, lat + 0.03]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, at);
  await tap(page, pt.x, pt.y, mobile);
  await expect(page.getByTestId('army-wizard')).toBeVisible();
  const city = await page.evaluate(
    (id: string) => window.__rl.world.getState().provinces[id].cityName,
    pid,
  );
  await expect(page.getByTestId('mission-target')).toContainText(city);
  await expect(page.getByTestId('mission-estimate')).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // 3. Général : un candidat du vivier (prime d'engagement), puis confirmation.
  await page.locator('[data-testid^="wizard-general-cand"]').first().click();
  await page.getByTestId('wizard-confirm').click();
  await expect(page.getByTestId('army-wizard')).toBeHidden();
  // La vue reçoit l'armée au diff suivant : on l'attend.
  const readArmy = () =>
    page.evaluate(() => window.__rl.game.getState().view.command?.armies[0]?.id as string);
  await expect.poll(readArmy).toBeTruthy();
  const armyId = await readArmy();
  // La nouvelle armée s'ouvre d'elle-même (sur mobile aussi) ; retour à la liste puis réouverture.
  await expect(page.getByTestId('army-detail')).toBeVisible();
  if (mobile) {
    await page.getByTestId('army-back').click();
    await page.getByTestId(`army-row-${armyId}`).click();
    await expect(page.getByTestId('army-detail')).toBeVisible();
  }
  await expect(page.getByTestId('army-general')).toContainText('Général');

  // 4. Règles standard : le général demande l'autorisation de franchir la frontière.
  await expect(page.getByTestId('army-request')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('army-request-accept').click();
  await expect(page.getByTestId('army-request')).toBeHidden();

  // 5. Vitesse d'essai : le général lance l'offensive et prend la province.
  await setSpeed(page, 3600);
  await expect
    .poll(
      () =>
        page.evaluate((id: string) => window.__rl.game.getState().view.provinces[id]?.owner, pid),
      {
        timeout: 600_000,
        intervals: [2_000],
      },
    )
    .toBe('fra');
  await expect
    .poll(
      () =>
        page.evaluate(() => window.__rl.game.getState().view.command.armies[0]?.status as string),
      { timeout: 120_000 },
    )
    .toBe('success');
  await expect(page.getByTestId('army-journal')).toContainText(`${city} est prise`);
  expect(errors).toEqual([]);
});
