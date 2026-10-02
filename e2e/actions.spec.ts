import { expect, test, type Page } from '@playwright/test';

/**
 * Actions de commandement (barre d'ordres de la sélection), sur ordinateur et sur mobile, partie
 * réelle (Allemagne, ORBAT 2025 ; avec la carte fusionnée, les SCALP français démarrent à Bordeaux,
 * hors de portée de toute unité étrangère visible) :
 *  1. sélection d'un chasseur → « Patrouiller » → point sur la carte → confirmation → décollage ;
 *  2. pile de missiles de croisière (Taurus) → « Attaquer » une unité étrangère à portée → tir, impact,
 *     dégâts ;
 *  3. chasseur posé → « Attaquer » la même cible → décollage, frappe aérienne, dégâts.
 */

type LngLat = [number, number];

declare global {
  interface Window {
    __rl: {
      game: { getState(): any; setState(fn: (s: any) => any): void };
      ui: { getState(): any };
      world: { getState(): any };
    };
    __rlMap: { map: any };
  }
}

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

/** Position affichée d'une unité (interpolée par la carte). */
async function unitPos(page: Page, id: string): Promise<LngLat> {
  return page.evaluate((uid) => window.__rl.game.getState().view.units[uid].pos, id);
}

async function startGermany(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('rl.debug', '1');
    localStorage.setItem('rl.tutorial.done', '1');
  });
  await page.addLocatorHandler(page.getByTestId('legal-accept'), async () => {
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByTestId('legal-accept').click();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Jouer en invité' }).click();
  await page.waitForURL('**/new');
  await page.getByPlaceholder('Rechercher une nation…').fill('Allemagne');
  await page
    .locator('.nation-row', { hasText: /^Allemagne/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Lancer la partie' }).click();
  await page.waitForURL('**/game/**');
  await page.waitForFunction(
    () => window.__rl?.game.getState().view && window.__rlMap?.map?.loaded(),
  );
}

/** Bouton d'action de la barre d'ordres (panneau de sélection). */
function action(page: Page, id: string) {
  return page.getByTestId('unit-orders').locator(`[data-action="${id}"]`);
}

async function confirm(page: Page) {
  const bar = page.getByTestId('order-bar');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Confirmer' }).click();
  await expect(bar).toBeHidden();
}

test('actions : patrouille, frappe de missiles, attaque aérienne', async ({ page }, info) => {
  test.setTimeout(480_000);
  const mobile = info.project.name === 'mobile';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await startGermany(page);

  // Matériel du joueur : missiles de croisière (Taurus), chasseur le plus proche, et une cible
  // étrangère visible (forces terrestres) à portée des deux.
  const picks = await page.evaluate(() => {
    const { game, world } = window.__rl;
    const view = game.getState().view;
    const catalog = world.getState().catalog;
    const km = (a: number[], b: number[]) => {
      const r = Math.PI / 180;
      const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
      const y = (b[1] - a[1]) * r;
      return Math.sqrt(x * x + y * y) * 6371;
    };
    const units = Object.values<any>(view.units);
    const own = units.filter((u) => u.level === 'own');
    const m = own.find(
      (u) =>
        catalog[u.systemId]?.missile?.kind === 'cruise' &&
        catalog[u.systemId].missile.warhead === 'conventional',
    );
    if (!m) return null;
    const s = catalog[m.systemId];
    const range = Math.max(s.weaponRangeKm.max, s.sheet?.rangeKm ?? 0, s.operationalRadiusKm ?? 0);
    const jets = own
      .filter((u) => catalog[u.systemId]?.category === 'fighter')
      .sort((a, b) => km(a.pos, m.pos) - km(b.pos, m.pos));
    const jet = jets[0];
    if (!jet) return null;
    const radius = catalog[jet.systemId].operationalRadiusKm ?? 1000;
    const target = units
      .filter(
        (u) =>
          u.owner !== game.getState().me &&
          u.level !== 'detected' &&
          !u.missile &&
          u.status !== 'embarked' &&
          catalog[u.systemId]?.movement === 'land' &&
          km(u.pos, m.pos) < range * 0.9 &&
          km(u.pos, jet.pos) < radius * 0.8,
      )
      .sort((a, b) => km(a.pos, m.pos) - km(b.pos, m.pos))[0];
    if (!target) return null;
    return {
      missiles: m.id as string,
      jet: jet.id as string,
      target: { id: target.id as string, hp: (target.hpRatio ?? 1) as number },
    };
  });
  expect(picks).not.toBeNull();
  const { jet: cap, missiles, target } = picks!;

  // ——— 1. Patrouille ———
  await page.evaluate((id) => window.__rl.ui.getState().select([id]), cap);
  await expect(page.getByTestId('unit-orders')).toBeVisible();
  await action(page, 'patrol').click();
  await expect(page.getByTestId('targeting-banner')).toBeVisible();
  const capAt = await unitPos(page, cap);
  const zone: LngLat = [capAt[0] + 0.6, capAt[1] + 0.4];
  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 7 }), zone);
  await page.waitForTimeout(800);
  const zp = await screenPoint(page, zone);
  await tapAt(page, zp.x, zp.y, mobile);
  await expect
    .poll(() => page.evaluate(() => window.__rl.ui.getState().pendingOrder?.kind))
    .toBe('patrol');
  await page.screenshot({ path: info.outputPath('1-patrouille.png') });
  await confirm(page);
  await expect
    .poll(() => page.evaluate((id) => window.__rl.game.getState().view.units[id]?.mission, cap))
    .toMatchObject({ kind: 'patrol', airborne: true });

  async function aimAt(id: string) {
    const p = await unitPos(page, id);
    await page.evaluate((q) => window.__rlMap.map.jumpTo({ center: q, zoom: 9 }), p);
    await page.waitForTimeout(900);
    const sp = await screenPoint(page, await unitPos(page, id));
    await tapAt(page, sp.x, sp.y, mobile);
  }
  const hpOf = (id: string) =>
    page.evaluate((uid) => {
      const u = window.__rl.game.getState().view.units[uid];
      return u ? (u.hpRatio ?? 1) : 0;
    }, id);

  // ——— 2. Frappe de missiles (« Attaquer » avec une pile de SCALP) ———
  const before = await page.evaluate(
    (id) => window.__rl.game.getState().view.units[id].count,
    missiles,
  );
  await page.evaluate((id) => window.__rl.ui.getState().select([id]), missiles);
  await action(page, 'attack').click();
  await expect(page.getByTestId('targeting-banner')).toBeVisible();
  await aimAt(target.id);
  await expect
    .poll(() => page.evaluate(() => window.__rl.ui.getState().pendingOrder?.kind))
    .toBe('attack');
  await page.screenshot({ path: info.outputPath('2-frappe.png') });
  await confirm(page);
  // La salve part : la pile diminue, une salve est en vol.
  await expect
    .poll(() =>
      page.evaluate((id) => window.__rl.game.getState().view.units[id]?.count ?? 0, missiles),
    )
    .toBeLessThan(before);
  await page.evaluate(() => window.__rl.game.getState().connection.setSpeed(16));
  // Impact : la cible est touchée (santé en baisse) ou détruite.
  await expect.poll(() => hpOf(target.id), { timeout: 90_000 }).toBeLessThan(target.hp);
  await page.evaluate(() => window.__rl.game.getState().connection.setSpeed(1));

  // ——— 3. Attaque aérienne : le chasseur en patrouille attaque une unité étrangère visible ———
  const target2 = await page.evaluate(
    ({ jet, first }) => {
      const { game, world } = window.__rl;
      const view = game.getState().view;
      const catalog = world.getState().catalog;
      const km = (a: number[], b: number[]) => {
        const r = Math.PI / 180;
        const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
        const y = (b[1] - a[1]) * r;
        return Math.sqrt(x * x + y * y) * 6371;
      };
      const j = view.units[jet];
      const radius = catalog[j.systemId].operationalRadiusKm ?? 1000;
      const c = Object.values<any>(view.units)
        .filter(
          (u) =>
            u.owner !== game.getState().me &&
            u.level !== 'detected' &&
            !u.missile &&
            u.status !== 'embarked' &&
            catalog[u.systemId]?.movement === 'land' &&
            km(u.pos, j.pos) < radius * 0.6,
        )
        .sort((a, b) =>
          a.id === first ? -1 : b.id === first ? 1 : km(a.pos, j.pos) - km(b.pos, j.pos),
        )[0];
      return c ? { id: c.id as string, hp: (c.hpRatio ?? 1) as number } : null;
    },
    { jet: cap, first: target.id },
  );
  expect(target2).not.toBeNull();
  await page.evaluate((id) => window.__rl.ui.getState().select([id]), cap);
  await action(page, 'attack').click();
  await aimAt(target2!.id);
  await expect
    .poll(() => page.evaluate(() => window.__rl.ui.getState().pendingOrder?.kind))
    .toBe('attack');
  await confirm(page);
  await expect
    .poll(() => page.evaluate((id) => window.__rl.game.getState().view.units[id]?.mission, cap))
    .toMatchObject({ kind: 'strike', airborne: true });
  await page.screenshot({ path: info.outputPath('3-attaque-aerienne.png') });
  await page.evaluate(() => window.__rl.game.getState().connection.setSpeed(16));
  await expect.poll(() => hpOf(target2!.id), { timeout: 150_000 }).toBeLessThan(target2!.hp);
  await page.screenshot({ path: info.outputPath('4-impact.png') });
  expect(errors).toEqual([]);
});
