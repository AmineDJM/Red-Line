import { expect, test, type Page } from '@playwright/test';

/**
 * Critère de fin de la phase 1 : conquérir une province ennemie, sur mobile et sur ordinateur.
 * Parcours réel : accueil → invité → nouvelle partie (France) → sélection d'unités sur la carte →
 * ordre de déplacement vers Bruxelles → confirmation → capture.
 */

type LngLat = [number, number];
const BRUSSELS: LngLat = [4.3314, 50.8353];

// Accès de diagnostic exposés par le client quand localStorage « rl.debug » vaut 1.
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

/** Position écran d'un point de la carte, dans le repère de la page. */
async function screenPoint(page: Page, p: LngLat) {
  return page.evaluate(([lng, lat]) => {
    const m = window.__rlMap.map;
    const pt = m.project([lng, lat]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + pt.x, y: r.top + pt.y };
  }, p);
}

test('conquérir une province ennemie', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  await page.addInitScript(() => {
    localStorage.setItem('rl.debug', '1');
    localStorage.setItem('rl.tutorial.done', '1');
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Acceptation des conditions si le serveur la demande (dialogue modal à tout moment).
  await page.addLocatorHandler(page.getByTestId('legal-accept'), async () => {
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByTestId('legal-accept').click();
  });

  // 1. Accueil → invité → nouvelle partie.
  await page.goto('/');
  await expect(page).toHaveTitle(/Red Line/);
  await page.getByRole('button', { name: 'Jouer en invité' }).click();
  await page.waitForURL('**/new');

  // 2. Choix de la France et lancement.
  await page.getByPlaceholder('Rechercher une nation…').fill('France');
  await page
    .locator('.nation-row', { hasText: /^France/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Lancer la partie' }).click();
  await page.waitForURL('**/game/**');

  // 3. La vue arrive par WebSocket et la carte est prête.
  await page.waitForFunction(
    () => window.__rl?.game.getState().view && window.__rlMap?.map?.loaded(),
  );
  const me = await page.evaluate(() => window.__rl.game.getState().me);
  expect(me).toBe('fra');

  // Unités françaises capables de capturer (infanterie).
  const capturers: { id: string; pos: LngLat }[] = await page.evaluate(() => {
    const { game, world } = window.__rl;
    const view = game.getState().view;
    const catalog = world.getState().catalog;
    return Object.values<any>(view.units)
      .filter((u) => u.level === 'own' && catalog[u.systemId]?.canCapture)
      .map((u) => ({ id: u.id, pos: u.pos }));
  });
  expect(capturers.length).toBeGreaterThan(0);

  // 4. Premier geste : sélectionner une unité en touchant son pion sur la carte. On prend la plus
  // isolée (arsenal réel de 2025 : les piles se chevauchent autour des grandes bases).
  const isolated = await page.evaluate(
    (ids: string[]) => {
      const units = Object.values<any>(window.__rl.game.getState().view.units);
      const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
      let best = ids[0]!;
      let bestD = -1;
      for (const id of ids) {
        const u = units.find((x) => x.id === id);
        const near = Math.min(...units.filter((x) => x.id !== id).map((x) => d2(x.pos, u.pos)));
        if (near > bestD) {
          bestD = near;
          best = id;
        }
      }
      return best;
    },
    capturers.map((c) => c.id),
  );
  const first = capturers.find((c) => c.id === isolated)!;
  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 9 }), first.pos);
  await page.waitForTimeout(1200);
  const at = await screenPoint(page, first.pos);
  await tapAt(page, at.x, at.y, mobile);
  await expect
    .poll(() => page.evaluate(() => window.__rl.ui.getState().selection as string[]))
    .toContain(first.id);
  // Les autres fantassins rejoignent la sélection (Maj+clic sur ordinateur).
  await page.evaluate(
    (ids) => window.__rl.ui.getState().select(ids),
    capturers.map((c) => c.id),
  );

  // 5. Deuxième geste : toucher la destination, Bruxelles (en évitant les unités ennemies).
  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 12 }), BRUSSELS);
  await page.waitForTimeout(1200);
  // Point libre à ~3 km de la ville (rayon de capture : 5 km), loin des hexagones ennemis.
  const target = await page.evaluate(([lng, lat]) => {
    const m = window.__rlMap.map;
    const r = m.getCanvas().getBoundingClientRect();
    const layers = ['units-hex', 'units-m-hex', 'focus-hex', 'cluster-hex'].filter((l) =>
      m.getLayer(l),
    );
    // Anneaux de 2 à 4 km (rayon de capture : 5 km), 24 directions, zone libre de 60 px.
    for (const f of [1, 0.75, 0.5, 1.2]) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        const p = m.project([lng + f * 0.043 * Math.cos(a), lat + f * 0.027 * Math.sin(a)]);
        const box = [
          [p.x - 30, p.y - 30],
          [p.x + 30, p.y + 30],
        ];
        const inside = p.x > 40 && p.y > 120 && p.x < r.width - 40 && p.y < r.height - 160;
        if (inside && !m.queryRenderedFeatures(box, { layers }).length)
          return { x: r.left + p.x, y: r.top + p.y };
      }
    }
    throw new Error('aucun point libre autour de Bruxelles');
  }, BRUSSELS);
  await tapAt(page, target.x, target.y, mobile);
  const pending = await page.evaluate(() => window.__rl.ui.getState().pendingOrder);
  expect(pending?.kind).toBe('move');
  await page.screenshot({ path: info.outputPath('1-ordre.png') });

  // 6. Troisième geste : confirmer.
  await page.getByTestId('order-bar').getByRole('button', { name: 'Confirmer' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (ids) => ids.some((id) => !!window.__rl.game.getState().view.units[id]?.move),
        capturers.map((c) => c.id),
      ),
    )
    .toBe(true);

  // Accélération d'essai (vitesse autorisée seulement hors production).
  await page.evaluate(() => window.__rl.game.getState().connection.setSpeed(3600));

  // 7. La province de Bruxelles change de propriétaire.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const { game, world } = window.__rl;
          const prov = Object.values<any>(world.getState().provinces).find(
            (p) => p.nationId === 'bel' && p.isCapital,
          );
          return game.getState().view.provinces[prov.id]?.owner;
        }),
      { timeout: 180_000, intervals: [1000] },
    )
    .toBe('fra');

  await page.evaluate((p) => window.__rlMap.map.jumpTo({ center: p, zoom: 7 }), BRUSSELS);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: info.outputPath('2-conquete.png') });
  expect(errors).toEqual([]);
});
