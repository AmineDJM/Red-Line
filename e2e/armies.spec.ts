import { expect, test } from '@playwright/test';
import { isMobile, openWindow, preparePage, startSoloGame } from './helpers.js';

/**
 * Fenêtres (vraies données, France 2025) :
 *  - une seule fenêtre principale : en ouvrir une autre remplace la précédente ;
 *  - Mes armées : vue d'ensemble, fiche d'armée, « Centrer », fiche d'arme seule (sans encyclopédie) ;
 *  - Arsenal de guerre : inventaire, puis catalogue par catégorie (défense antiaérienne) ;
 *  - province étrangère → fiche pays (diplomatie).
 */
test('Mes armées → centrer → fiche seule', async ({ page }, info) => {
  // Parcours long (connexion, carte WebGL logicielle) : marge sur machine chargée.
  test.setTimeout(900_000);
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');
  const mobile = isMobile(info);

  // Une fenêtre à la fois.
  await openWindow(page, 'production');
  await openWindow(page, 'armies');
  await expect(page.locator('.rl-win')).toHaveCount(1);
  const win = page.locator('#win-armies');
  await expect(win.getByTestId('armies-summary')).toBeVisible();
  await expect(win.getByTestId('armies-summary')).toContainText('Terre');

  // Fiche d'une armée.
  await win.locator('.rl-table tbody tr').first().click();
  const detail = win.getByTestId('army-detail');
  await expect(detail).toBeVisible();
  await page.screenshot({ path: info.outputPath('1-mes-armees.png') });

  const center = () =>
    page.evaluate(() => {
      const c = window.__rlMap.map.getCenter();
      return [c.lng, c.lat] as [number, number];
    });
  const centered = async () => {
    // Carte éloignée (océan Indien), puis « Centrer » : la caméra rejoint l'armée (Europe).
    await page.evaluate(() => window.__rlMap.map.jumpTo({ center: [80, -20], zoom: 3 }));
    await detail.getByTestId('army-center').click();
    await expect
      .poll(
        async () => {
          const c = await center();
          return Math.abs(c[0] - 80) + Math.abs(c[1] + 20);
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(20);
  };
  const sheetOnly = async () => {
    await detail.getByTestId('pile-sheet').first().click();
    const sheet = page.getByTestId('weapon-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.rl-weapon')).toBeVisible();
    // La fiche se superpose : la fenêtre reste ouverte, aucune encyclopédie ni catalogue.
    await expect(page.locator('.rl-win')).toHaveCount(1);
    await expect(win).toBeAttached();
    await page.screenshot({ path: info.outputPath('2-fiche-seule.png') });
    await page.getByTestId('weapon-sheet-close').click();
    await expect(sheet).toHaveCount(0);
    await expect(win).toBeVisible();
  };

  if (mobile) {
    // Mobile : « Centrer » ramène à la carte ; la fiche seule d'abord.
    await sheetOnly();
    await centered();
    await expect(page.locator('.rl-win')).toHaveCount(0);
  } else {
    await centered();
    await expect(win).toBeVisible();
    await sheetOnly();
  }

  // Arsenal de guerre : inventaire puis catalogue par catégorie (remplace Mes armées).
  await openWindow(page, 'army');
  await expect(page.locator('.rl-win')).toHaveCount(1);
  const arsenal = page.locator('#win-army');
  await expect(arsenal.getByTestId('inventory-summary')).toBeVisible();
  await arsenal.getByRole('tab', { name: /Catalogue/ }).click();
  await arsenal.getByTestId('arsenal-cat-air_defense').click();
  const tiles = arsenal.locator('.arsenal__grid .rl-wtile, .arsenal__grid > *');
  await expect(tiles.first()).toBeVisible();
  await expect(arsenal.getByTestId('arsenal-list')).not.toContainText('Chasseur');
  await page.screenshot({ path: info.outputPath('3-catalogue-defense-aa.png') });

  // Province étrangère → fiche pays.
  await page.evaluate(() => {
    const ui = window.__rl.ui.getState();
    ui.closeAllWindows();
    const provinces = window.__rl.world.getState().provinces as Record<string, any>;
    const de = Object.values(provinces).find((p) => p.nationId === 'deu' && p.isCapital);
    window.__rlMap.map.jumpTo({ center: de.cityPoint, zoom: 6 });
    ui.selectProvince(de.id);
  });
  await page.getByTestId('province-country').click();
  const country = page.getByTestId('country-panel');
  await expect(country).toBeVisible();
  await expect(country).toContainText('Allemagne');
  await expect(country.getByTestId('country-message')).toBeVisible();
  await page.screenshot({ path: info.outputPath('4-pays.png') });

  expect(errors).toEqual([]);
});
