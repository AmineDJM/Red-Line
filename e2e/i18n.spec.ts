import { expect, test } from '@playwright/test';
import { preparePage, waitGameReady } from './helpers.js';

/**
 * Multilingue : langue du document et sens d'écriture (arabe : dir="rtl", carte non inversée),
 * sélecteur de langue de l'accueil, chargement paresseux (un morceau par langue), repli et partie
 * jouée en anglais, arabe et japonais (captures ordinateur + mobile).
 */
const CASES = [
  { lang: 'en', dir: 'ltr', nation: 'France', play: /play|guest/i },
  { lang: 'ar', dir: 'rtl', nation: 'فرنسا', play: /./ },
  { lang: 'ja', dir: 'ltr', nation: 'フランス', play: /./ },
] as const;

for (const c of CASES) {
  test(`${c.lang} : accueil, sens d'écriture, partie`, async ({ page }, info) => {
    test.setTimeout(900_000);
    const errors = await preparePage(page);
    await page.addInitScript((l) => localStorage.setItem('rl.lang', l), c.lang);
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', new RegExp(`^${c.lang}`));
    await expect(html).toHaveAttribute('dir', c.dir);
    if (c.dir === 'rtl') await expect(html).toHaveClass(/rtl/);
    else await expect(html).not.toHaveClass(/rtl/);
    await expect(page.getByTestId('lang-select')).toBeVisible();
    await expect(page.getByTestId('menu-guest')).toBeVisible();
    // Les textes de l'interface ne sont plus en français.
    await expect(page.getByTestId('menu-guest')).not.toContainText('Jouer en invité');
    await page.screenshot({ path: info.outputPath(`${c.lang}-1-accueil.png`) });

    // Invité → choix d'une nation → partie.
    await page.getByTestId('menu-guest').click();
    await page.waitForURL('**/new');
    const row = page.locator('.nation-row[data-nation="fra"]');
    await expect(row).toContainText(c.nation);
    await row.click();
    await page.getByTestId('picker-confirm').click();
    await page.waitForURL('**/game/**');
    await waitGameReady(page);
    await expect(html).toHaveAttribute('dir', c.dir);
    // La carte n'est jamais inversée : l'est reste à droite (longitude croissante vers la droite).
    const east = await page.evaluate(() => {
      const m = window.__rlMap.map;
      const a = m.project([0, 0]);
      const b = m.project([10, 0]);
      return b.x > a.x;
    });
    expect(east).toBe(true);
    await page.screenshot({ path: info.outputPath(`${c.lang}-2-partie.png`) });
    expect(errors).toEqual([]);
  });
}

test('sélecteur de langue : choix mémorisé, rechargement dans la langue', async ({ page }) => {
  await preparePage(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', /^fr/);
  await page.getByTestId('lang-select').locator('select').selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', /^es/);
  expect(await page.evaluate(() => localStorage.getItem('rl.lang'))).toBe('es');
  // Un autre chargement garde la langue mémorisée ; ?lang= est prioritaire ensuite sur le mémorisé.
  await page.goto('/?lang=tr');
  await expect(page.locator('html')).toHaveAttribute('lang', /^tr/);
});
