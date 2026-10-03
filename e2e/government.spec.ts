import { expect, test, type Page } from '@playwright/test';
import { isMobile, preparePage, setSpeed, startSoloGame } from './helpers';

/**
 * Gouvernement, de bout en bout (vrai serveur, vraies données) : depuis la barre du haut, le joueur
 * ouvre le Gouvernement, nomme un ministre de l'Économie parmi les candidats, lui confie la mission
 * « Production de ressources : pétrole » avec une enveloppe, et voit un chantier de puits lancé dans
 * une province pétrolière (jamais à Alger) — sur ordinateur et sur mobile. Aucune position ni premier
 * élément de liste supposés : les éléments sont désignés par leur rôle et leurs données.
 */

const SHOTS = process.env.GOV_SHOTS;

async function shot(page: Page, name: string, mobile: boolean) {
  if (!SHOTS) return;
  // La carte occupe le fil principal : laisser la fenêtre se peindre avant la capture.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/gov-${mobile ? 'mobile' : 'desktop'}-${name}.png` });
}

test('gouvernement : nommer un ministre de l’Économie, mission pétrole, chantier lancé', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'Algérie');

  // 1. Gouvernement depuis la barre du haut, ministère de l'Économie.
  await page.getByTestId('government-button').click();
  await expect(page.locator('#win-government')).toBeVisible();
  await expect(page.getByTestId('gov-ministry-defense')).toBeVisible();
  await shot(page, '1-defense', mobile);
  await page.getByRole('tab', { name: /Économie/ }).click();
  await expect(page.getByTestId('gov-ministry-economy')).toBeVisible();

  // 2. Poste vacant : un candidat abordable est nommé (n'importe lequel, désigné par son bouton actif).
  await expect(page.getByTestId('gov-vacant-economy')).toBeVisible();
  await shot(page, '2-vacant', mobile);
  const appoint = page.getByTestId('gov-appoint-economy').and(page.locator(':enabled'));
  await expect(appoint.first()).toBeVisible();
  await appoint.first().click();
  await expect(page.getByTestId('gov-head-economy')).toBeVisible();
  const head = await page.evaluate(
    () =>
      window.__rl.game
        .getState()
        .view.government.offices.find((o: { id: string }) => o.id === 'economy').head,
  );
  expect(head).toBeTruthy();
  await expect(page.getByTestId('gov-head-economy')).toContainText(head.last);

  // 3. Assistant : mission « Production de ressources », pétrole, enveloppe par défaut.
  await page.getByTestId('gov-new-economy').click();
  await expect(page.getByTestId('gov-wizard')).toBeVisible();
  await page.getByTestId('gov-type-resource').click();
  await shot(page, '3-wizard-type', mobile);
  await page.getByTestId('gov-wizard-next').click();
  await page.getByRole('radio', { name: /Pétrole/ }).click();
  await page.getByTestId('gov-wizard-next').click();
  await expect(page.getByTestId('gov-estimate')).toBeVisible();
  await expect(page.getByTestId('gov-budget-amount')).toContainText('$');
  await shot(page, '4-wizard-budget', mobile);
  await page.getByTestId('gov-wizard-confirm').click();
  await expect(page.getByTestId('gov-wizard')).toBeHidden();

  // 4. La mission apparaît et agit : un chantier de puits est lancé dans une province pétrolière.
  const readMission = () =>
    page.evaluate(() => {
      const gv = window.__rl.game.getState().view.government;
      const m = gv.missions.find((x: { type: string }) => x.type === 'resource');
      return m ? { id: m.id as string, last: (m.last?.key ?? null) as string | null } : null;
    });
  await expect.poll(readMission).toBeTruthy();
  const { id } = (await readMission())!;
  const card = page.getByTestId(`gov-mission-${id}`);
  await expect(card).toBeVisible();
  // Partie solo : un pas de temps suffit (la réflexion du ministre est immédiate).
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await readMission())?.last, { timeout: 120_000 })
    .toBe('engine.gov.j.built');
  await page.evaluate(() => window.__rl.game.getState().connection.setPaused(true));
  await expect(card.getByTestId('gov-mission-last')).toContainText('Chantier lancé');
  const site = await page.evaluate(() => {
    const { view } = window.__rl.game.getState();
    const { provinces } = window.__rl.world.getState();
    const out: { pid: string; oil: boolean; capital: boolean }[] = [];
    for (const [pid, p] of Object.entries<any>(view.provinces)) {
      if (p.owner !== 'dza') continue;
      const b = (p.buildingState ?? []).find(
        (x: any) => x.type === 'oil_field' && (x.upgradeUntil || x.buildUntil),
      );
      if (!b) continue;
      const def = provinces[pid];
      out.push({
        pid,
        oil: !!def.resources?.some((r: any) => r.type === 'oil'),
        capital: !!def.isCapital,
      });
    }
    return out;
  });
  expect(site.length).toBeGreaterThan(0);
  for (const s of site) {
    expect(s.oil).toBe(true);
    expect(s.capital).toBe(false);
  }
  await card.scrollIntoViewIfNeeded();
  await shot(page, '5-mission', mobile);

  // 5. Défense : sections lisibles (commandements, armement, renseignement).
  await page.getByRole('tab', { name: /Défense/ }).click();
  await page.getByTestId('gov-section-intel').click();
  await expect(page.getByTestId('gov-office-intel_interior')).toBeVisible();
  await shot(page, '6-intel', mobile);
  await page.getByTestId('gov-section-commands').click();
  await expect(page.getByTestId('gov-commands')).toBeVisible();
  await shot(page, '7-commands', mobile);
  expect(errors).toEqual([]);
});
