import { expect, test, type Page } from '@playwright/test';
import { isMobile, preparePage, setSpeed, startSoloGame, type LngLat } from './helpers.js';

/**
 * Transport naval et escorte, sur ordinateur et sur mobile, partie réelle (Italie, ORBAT 2025) :
 *  1. un détachement d'infanterie gagne le port où mouille le navire de transport le plus proche ;
 *  2. « Embarquer » (bouton affiché près du navire de transport) → troupes à bord (cargaison) ;
 *  3. navire sélectionné → « Débarquer » → toucher un autre port national (150 à 700 km) →
 *     confirmation → traversée, mise à terre, troupes de nouveau sur la carte ;
 *  4. chasseur → « Escorter » → toucher une frégate amie → mission d'escorte.
 * Les lieux sont choisis d'après la partie (la carte et le placement de départ peuvent changer).
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

test('transport naval : embarquer, traverser, débarquer ; escorter', async ({ page }, info) => {
  test.setTimeout(600_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'Italie');

  // Navire de transport et pile terrestre la plus proche ; port d'embarquement ; port de
  // débarquement national dans une autre province.
  const picks = await page.evaluate(() => {
    const { game, world } = window.__rl;
    const view = game.getState().view;
    const me = game.getState().me;
    const catalog = world.getState().catalog;
    const own = Object.values<any>(view.units).filter((u) => u.level === 'own');
    const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    const km = (a: number[], b: number[]) => {
      const r = Math.PI / 180;
      const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
      const y = (b[1] - a[1]) * r;
      return Math.sqrt(x * x + y * y) * 6371;
    };
    const stacks = own.filter(
      (u) => catalog[u.systemId]?.movement === 'land' && (u.parts?.length ?? 0) > 1,
    );
    let ship: any = null;
    let stack: any = null;
    for (const sh of own.filter(
      (u) => (catalog[u.systemId]?.payload?.transport ?? 0) > 0 && u.cargo,
    ))
      for (const st of stacks)
        if (!ship || d2(st.pos, sh.pos) < d2(stack.pos, ship.pos)) {
          ship = sh;
          stack = st;
        }
    const roads = world.getState().roads;
    const port = roads.nearestNode(ship.pos, 80, (i: number) => !!roads.nodes[i].port);
    const from = roads.nodes[port];
    const dest = roads.nodes
      .filter(
        (n: any) =>
          n.port &&
          n.province !== from.province &&
          view.provinces[n.province]?.owner === me &&
          km(n.pos, from.pos) > 150 &&
          km(n.pos, from.pos) < 700,
      )
      .sort(
        (a: any, b: any) =>
          Math.abs(km(a.pos, from.pos) - 300) - Math.abs(km(b.pos, from.pos) - 300),
      )[0];
    const jet = own.find((u) => catalog[u.systemId]?.category === 'fighter');
    const frigate = own.find(
      (u) => catalog[u.systemId]?.category === 'surface_ship' && u.id !== ship.id && !u.cargo,
    );
    return {
      ship: ship.id as string,
      stack: stack.id as string,
      port: from.pos as LngLat,
      dest: (dest?.pos ?? null) as LngLat | null,
      jet: jet?.id as string,
      frigate: frigate?.id as string,
    };
  });
  expect(picks.ship).toBeTruthy();
  expect(picks.dest).not.toBeNull();
  const DEST = picks.dest!;

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
  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 8 }), DEST);
  await page.waitForTimeout(900);
  const cp = await screenPoint(page, DEST);
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
    (landed!.pos[0] - DEST[0]) * 111 * Math.cos((DEST[1] * Math.PI) / 180),
    (landed!.pos[1] - DEST[1]) * 111,
  );
  expect(km).toBeLessThan(70);
  await page.screenshot({ path: info.outputPath('3-debarque.png') });

  // ——— 3. Escorter : chasseur → frégate amie ———
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
