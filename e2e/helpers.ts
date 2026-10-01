import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';

/**
 * Aides communes aux parcours de bout en bout (vrai serveur, vraies données).
 * Les accès de diagnostic `window.__rl` / `window.__rlMap` sont activés par localStorage « rl.debug ».
 */

export type LngLat = [number, number];

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

export const isMobile = (info: TestInfo) => info.project.name === 'mobile';

/** Prépare une page : diagnostic actif, tutoriel déjà vu, erreurs collectées, CGU acceptées. */
export async function preparePage(page: Page, opts: { tutorial?: boolean } = {}) {
  await page.addInitScript((tuto) => {
    try {
      localStorage.setItem('rl.debug', '1');
      if (!tuto) localStorage.setItem('rl.tutorial.done', '1');
    } catch {
      /* about:blank : pas de stockage */
    }
  }, !!opts.tutorial);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const accept = page.getByTestId('legal-accept');
  await page.addLocatorHandler(accept, async () => {
    const box = page.getByRole('dialog').getByRole('checkbox');
    if (!(await box.isChecked())) await box.check();
    await accept.click();
    await accept.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);
  });
  return errors;
}

/** Attend la vue (WebSocket) et le chargement de la carte. */
export async function waitGameReady(page: Page) {
  await page.waitForFunction(
    () => window.__rl?.game.getState().view && window.__rlMap?.map?.loaded(),
    null,
    { timeout: 180_000 },
  );
}

/** Accueil → invité → nouvelle partie solo avec la nation demandée (scénario par défaut : 2025). */
export async function startSoloGame(page: Page, nation: string) {
  await page.goto('/');
  await expect(page).toHaveTitle(/Red Line/);
  await page.getByRole('button', { name: 'Jouer en invité' }).click();
  await page.waitForURL('**/new');
  await page.getByPlaceholder('Rechercher une nation…').fill(nation);
  await page
    .locator('.nation-row', { hasText: new RegExp(`^${nation}`) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Lancer la partie' }).click();
  await page.waitForURL('**/game/**');
  await waitGameReady(page);
}

/** Ouvre une fenêtre de la coque (même effet que le raccourci ou le bouton de navigation). */
export async function openWindow(page: Page, id: string, params: Record<string, string> = {}) {
  await page.evaluate(([w, p]) => window.__rl.ui.getState().openWindow(w, p), [
    id,
    params,
  ] as const);
  await expect(page.locator('.rl-win').first()).toBeVisible();
}

export async function closeWindows(page: Page) {
  await page.evaluate(() => {
    const u = window.__rl.ui.getState();
    for (const w of [...u.windows]) u.closeWindow(w.id);
  });
}

/** Vitesse d'essai (refusée par le serveur en production). */
export async function setSpeed(page: Page, speed: number) {
  await page.evaluate((s) => window.__rl.game.getState().connection.setSpeed(s), speed);
}

/** Province (identifiant) : capitale d'une nation, d'après les données statiques de la carte. */
export async function capitalOf(page: Page, nationId: string): Promise<string> {
  return page.evaluate(
    (n) =>
      Object.values<any>(window.__rl.world.getState().provinces).find(
        (p) => p.nationId === n && p.isCapital,
      ).id,
    nationId,
  );
}

/** Sélectionne une province (comme un toucher sur la carte) et centre la caméra dessus. */
export async function selectProvince(page: Page, provinceId: string, zoom = 6) {
  await page.evaluate(
    ([id, z]) => {
      const d = window.__rl.world.getState().provinces[id];
      window.__rlMap.map.jumpTo({ center: d.cityPoint, zoom: z });
      window.__rl.ui.getState().selectProvince(id);
    },
    [provinceId, zoom] as const,
  );
  await expect(page.getByTestId('province-panel')).toBeVisible();
}

/** Nouveau contexte de navigateur (second joueur, spectateur), au format du projet courant. */
export async function newPlayerPage(browser: Browser, info: TestInfo, from: Page) {
  const u = info.project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    locale: 'fr-FR',
    baseURL: new URL(from.url()).origin,
  });
  return ctx.newPage();
}

/** Accepte les documents légaux en attente par l'API (parcours qui ne testent pas l'écran CGU). */
export async function acceptLegalViaApi(page: Page) {
  const me = await page.request.get('/api/me');
  const docs = ((await me.json()) as { legal?: { needsAcceptance?: unknown[] } }).legal
    ?.needsAcceptance;
  if (docs?.length) {
    const r = await page.request.post('/api/legal/accept', { data: { docs } });
    expect(r.ok()).toBe(true);
  }
}
