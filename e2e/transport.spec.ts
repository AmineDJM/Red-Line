import { expect, test, type Page } from '@playwright/test';
import { isMobile, preparePage, setSpeed, startSoloGame, type LngLat } from './helpers.js';

/**
 * Transport naval et escorte, sur ordinateur et sur mobile, partie réelle (France, ORBAT 2025) :
 *  1. un détachement d'infanterie gagne le port de Normandie où mouillent les Mistral ;
 *  2. « Embarquer » (bouton affiché près du navire de transport) → troupes à bord (cargaison) ;
 *  3. navire sélectionné → « Débarquer » → toucher la côte de Calais → confirmation → traversée,
 *     mise à terre, troupes de nouveau sur la carte ;
 *  4. Mirage 2000 → « Escorter » → toucher une frégate amie → mission d'escorte.
 */

async function tapAt(page: Page, x: number, y: number, mobile: boolean) {
  if (mobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function screenPoint(page: Page, p: LngLat) {
  return page.evaluate(([lng, lat]) => {
    const m = window.__rlMap.map;
    const pt = m.project([lng, lat]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + pt.x, y: r.top + pt.y };
  }, p);
}

function action(page: Page, id: string) {
  return page.getByTestId('unit-orders').locator(`[data-action="${id}"]`);
}

async function confirm(page: Page) {
  const bar = page.getByTestId('order-bar');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Confirmer' }).click();
  await expect(bar).toBeHidden();
}

const unit = (page: Page, id: string) =>
  page.evaluate((uid) => {
    const u = window.__rl.game.getState().view.units[uid];
    return u
      ? {
          pos: u.pos as LngLat,
          move: !!u.move,
          status: u.status as string | undefined,
          transportId: u.transportId as string | undefined,
          loading: !!u.loading,
          cargo: u.cargo as { unitIds: string[]; capacity: number; used: number } | undefined,
          mission: u.mission?.kind as string | undefined,
        }
      : null;
  }, id);

/** Port de Calais (nœud d'embarquement du réseau de routes, province du Nord). */
const CALAIS: LngLat = [1.9688185427883862, 50.943652120747274];

test('transport naval : embarquer, traverser, débarquer ; escorter', async ({ page }, info) => {
  test.setTimeout(600_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');

  // Navire de transport (Mistral) et pile terrestre capable de capturer la plus proche.
  const picks = await page.evaluate(() => {
    const { game, world } = window.__rl;
    const view = game.getState().view;
    const catalog = world.getState().catalog;
    const own = Object.values<any>(view.units).filter((u) => u.level === 'own');
    const ship = own.find((u) => (catalog[u.systemId]?.payload?.transport ?? 0) > 0 && u.cargo);
    const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    const stack = own
      .filter((u) => catalog[u.systemId]?.movement === 'land' && (u.parts?.length ?? 0) > 1)
      .sort((a, b) => d2(a.pos, ship.pos) - d2(b.pos, ship.pos))[0];
    const roads = world.getState().roads;
    const port = roads.nearestNode(ship.pos, 80, (i: number) => !!roads.nodes[i].port);
    const jet = own.find((u) => u.systemId === 'eu.mirage-2000');
    const frigate = own.find((u) => u.systemId === 'eu.fremm');
    return {
      ship: ship.id as string,
      stack: stack.id as string,
      port: roads.nodes[port].pos as LngLat,
      jet: jet?.id as string,
      frigate: frigate?.id as string,
    };
  });
  expect(picks.ship).toBeTruthy();

  // Mise en place : un détachement de deux bataillons d'infanterie gagne le port (ordres directs).
  const before = await page.evaluate(() =>
    Object.keys(window.__rl.game.getState().view.units).filter(
      (id) => window.__rl.game.getState().view.units[id].level === 'own',
    ),
  );
  const split = await page.evaluate(
    (id) =>
      window.__rl.game.getState().connection.sendOrder({
        kind: 'split',
        unitId: id,
        parts: [{ systemId: 'eu.infantry-light', count: 2 }],
      }),
    picks.stack,
  );
  expect(split.ok).toBe(true);
  let det = '';
  await expect
    .poll(async () => {
      det = await page.evaluate(
        (old) =>
          Object.values<any>(window.__rl.game.getState().view.units).find(
            (u) => u.level === 'own' && !old.includes(u.id) && u.systemId === 'eu.infantry-light',
          )?.id ?? '',
        before,
      );
      return det;
    })
    .not.toBe('');
  const go = await page.evaluate(
    ([id, to]) =>
      window.__rl.game.getState().connection.sendOrder({ kind: 'move', unitIds: [id], to }),
    [det, picks.port] as const,
  );
  expect(go.ok).toBe(true);
  // Le trajet arrive par la vue (diff) avant d'être attendu jusqu'au bout.
  await expect.poll(async () => (await unit(page, det))?.move).toBe(true);
  await setSpeed(page, 3600);
  await expect.poll(async () => (await unit(page, det))?.move, { timeout: 120_000 }).toBe(false);
  await setSpeed(page, 1);

  // ——— 1. Embarquer : bouton affiché (navire de transport à proximité), ordre direct ———
  await page.evaluate((id) => window.__rl.ui.getState().select([id]), det);
  await expect(action(page, 'embark')).toBeVisible();
  await expect(action(page, 'embark')).toHaveAttribute('aria-disabled', 'false');
  await page.screenshot({ path: info.outputPath('1-embarquer.png') });
  await action(page, 'embark').click();
  await expect.poll(async () => (await unit(page, det))?.loading).toBe(true);
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await unit(page, det))?.transportId, { timeout: 120_000 })
    .toBe(picks.ship);
  await setSpeed(page, 1);
  expect((await unit(page, det))?.status).toBe('embarked');
  expect((await unit(page, picks.ship))?.cargo?.unitIds).toContain(det);

  // ——— 2. Débarquer : navire sélectionné, cargaison affichée, côte de Calais ———
  await page.evaluate((id) => window.__rl.ui.getState().select([id]), picks.ship);
  if (!mobile) await expect(page.getByTestId('ship-cargo')).toBeVisible();
  await action(page, 'disembark').click();
  await expect(page.getByTestId('targeting-banner')).toBeVisible();
  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 8 }), CALAIS);
  await page.waitForTimeout(900);
  const cp = await screenPoint(page, CALAIS);
  await tapAt(page, cp.x, cp.y, mobile);
  await expect
    .poll(() => page.evaluate(() => window.__rl.ui.getState().pendingOrder?.kind))
    .toBe('disembark');
  await page.screenshot({ path: info.outputPath('2-debarquer.png') });
  await confirm(page);
  await expect.poll(async () => (await unit(page, picks.ship))?.move).toBe(true);
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await unit(page, det))?.transportId ?? null, { timeout: 180_000 })
    .toBeNull();
  await setSpeed(page, 1);
  const landed = await unit(page, det);
  expect(landed?.status).not.toBe('embarked');
  const km = Math.hypot(
    (landed!.pos[0] - CALAIS[0]) * 111 * Math.cos((CALAIS[1] * Math.PI) / 180),
    (landed!.pos[1] - CALAIS[1]) * 111,
  );
  expect(km).toBeLessThan(70);
  await page.screenshot({ path: info.outputPath('3-debarque.png') });

  // ——— 3. Escorter : Mirage 2000 → frégate amie ———
  if (picks.jet && picks.frigate) {
    await page.evaluate((id) => window.__rl.ui.getState().select([id]), picks.jet);
    await action(page, 'escort').click();
    await expect(page.getByTestId('targeting-banner')).toBeVisible();
    const fp = (await unit(page, picks.frigate))!.pos;
    await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 9 }), fp);
    await page.waitForTimeout(900);
    const sp = await screenPoint(page, (await unit(page, picks.frigate))!.pos);
    await tapAt(page, sp.x, sp.y, mobile);
    await expect
      .poll(() => page.evaluate(() => window.__rl.ui.getState().pendingOrder?.kind))
      .toBe('escort');
    await confirm(page);
    await expect
      .poll(async () => (await unit(page, picks.jet))?.mission, { timeout: 30_000 })
      .toBe('escort');
    await page.screenshot({ path: info.outputPath('4-escorte.png') });
  }
  expect(errors).toEqual([]);
});
