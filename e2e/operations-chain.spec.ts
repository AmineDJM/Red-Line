import { expect, test, type Page } from '@playwright/test';
import { isMobile, preparePage, setSpeed, startSoloGame } from './helpers';

/**
 * Opérations enchaînées, de bout en bout (vrai serveur, vraies données) — ordinateur et mobile :
 * 1. le joueur compose une opération en deux phases dans le QG (catalogue → « Neutraliser la défense
 *    antiaérienne », cible le Luxembourg, plan : phase 2 « Conquête totale » ajoutée, échéance de la
 *    phase 1), garde l'état-major proposé (aviation et armée de terre) et lance ;
 * 2. la phase 1 s'exécute, puis la phase 2 (conquête) prend le Luxembourg : l'opération réussit et
 *    ses forces tiennent les gains ;
 * 3. depuis le tableau de bord de l'opération close, « Nouvelle opération, même état-major » vise la
 *    Belgique : les mêmes généraux reprennent leurs armées et la nouvelle opération prend une province.
 * Aucune position ni premier élément supposé : tout est lu dans la partie.
 */

const SHOTS = process.env.E2E_SHOTS;

async function shot(page: Page, name: string, mobile: boolean) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${SHOTS}/chain-${mobile ? 'mobile' : 'desktop'}-${name}.png`,
    animations: 'disabled',
  });
}

interface OpRead {
  id: string;
  status: string;
  step: number;
  goal: string;
  phases: string[];
  generals: string[];
  done: number;
  total: number;
}

function readOps(page: Page): Promise<OpRead[]> {
  return page.evaluate(() =>
    ((window.__rl.game.getState().view.command?.ops ?? []) as any[]).map((o) => ({
      id: o.id as string,
      status: o.status as string,
      step: (o.step ?? 0) as number,
      goal: o.goal as string,
      phases: ((o.phases ?? []) as { goal: string }[]).map((p) => p.goal),
      generals: (o.commanders as { generalId: string | null }[])
        .map((c) => c.generalId ?? '')
        .sort(),
      done: (o.progress.find((p: { key: string }) => p.key === 'provinces')?.done ?? 0) as number,
      total: (o.progress.find((p: { key: string }) => p.key === 'provinces')?.total ?? 0) as number,
    })),
  );
}

test('opérations : chaîne SEAD → conquête, puis nouvelle opération pour le même état-major', async ({
  page,
}, info) => {
  test.setTimeout(900_000);
  const mobile = isMobile(info);
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');

  // 1. Nouvelle opération : catalogue, catégorie Air, « Neutraliser la défense antiaérienne ».
  await page.getByTestId('command-button').click();
  await page.getByTestId('op-new').click();
  await expect(page.getByTestId('op-wizard')).toBeVisible();
  await page.getByTestId('op-cat-air').click();
  await page.getByTestId('op-goal-sead').click();
  await expect(page.getByTestId('op-estimate')).toBeVisible();
  await shot(page, '1-catalog', mobile);
  await page.getByTestId('op-next').click();

  // 2. Cible : le Luxembourg.
  await page.getByTestId('op-search').fill('Luxem');
  await page.getByTestId('op-nation-lux').click();
  await expect(page.getByTestId('op-targets')).toContainText('Luxembourg');
  await page.getByTestId('op-next').click();

  // 3. Plan : phase 2 « Conquête totale » ajoutée ; la phase 1 a une échéance (6 h).
  await expect(page.getByTestId('op-plan')).toBeVisible();
  await page.getByTestId('op-phase-add').click();
  await page.getByTestId('op-phase-goal-conquest').click();
  await expect(page.getByTestId('op-phase-0')).toContainText('Conquête totale');
  await page.getByTestId('op-phase-timebox-first').selectOption('6');
  await shot(page, '2-plan', mobile);
  await page.getByTestId('op-next').click();

  // 4. État-major proposé : aviation (phase 1) et armée de terre (phase 2).
  await expect(page.getByTestId('op-branch-air')).toBeVisible();
  await expect.poll(() => page.locator('.ops-grow.is-on').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('op-branch-land').locator('.ops-grow.is-on')).not.toHaveCount(0);
  await page.getByTestId('op-next').click();
  await expect(page.getByTestId('op-summary-chain')).toContainText('Conquête totale');
  await page.getByTestId('op-name').fill('Ciel puis terre');
  await shot(page, '3-confirm', mobile);
  await page.getByTestId('op-confirm').click();
  await expect(page.getByTestId('op-wizard')).toBeHidden();

  await expect.poll(async () => (await readOps(page)).length).toBe(1);
  const op1 = (await readOps(page))[0]!;
  expect(op1.phases).toEqual(['sead', 'conquest']);
  expect(op1.goal).toBe('sead');
  await expect(page.getByTestId('op-detail')).toBeVisible();
  await expect(page.getByTestId('op-phases')).toContainText('Phase 1/2');
  await expect(page.getByTestId('op-next-phase')).toContainText('Conquête totale');
  await shot(page, '4-dashboard-phase1', mobile);

  // 5. Vitesse d'essai : la phase 1 se termine, la phase 2 (conquête) s'exécute et réussit.
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await readOps(page))[0]?.step ?? 0, {
      timeout: 600_000,
      intervals: [1_000],
    })
    .toBe(1);
  await expect(page.getByTestId('op-phases')).toContainText('Phase 2/2');
  await shot(page, '5-dashboard-phase2', mobile);
  await expect
    .poll(async () => (await readOps(page))[0]?.status, { timeout: 600_000, intervals: [2_000] })
    .toBe('success');
  const end1 = (await readOps(page))[0]!;
  expect(end1.goal).toBe('conquest');
  expect(end1.done).toBe(end1.total);
  await setSpeed(page, 1);
  await expect(page.getByTestId('op-closed')).toBeVisible();
  await expect(page.getByTestId('op-journal')).toContainText('Phase 2/2');
  await shot(page, '6-success', mobile);

  // 6. Nouvelle opération pour le même état-major : conquête de la Belgique.
  await page.getByTestId('op-new-same-staff').click();
  await expect(page.getByTestId('op-wizard')).toBeVisible();
  await page.getByTestId('op-goal-conquest').click();
  await page.getByTestId('op-next').click();
  await page.getByTestId('op-search').fill('Belg');
  await page.getByTestId('op-nation-bel').click();
  await page.getByTestId('op-next').click();
  await expect(page.getByTestId('op-plan')).toBeVisible();
  await page.getByTestId('op-next').click();
  await expect.poll(() => page.locator('.ops-grow.is-on').count()).toBe(end1.generals.length);
  await page.getByTestId('op-next').click();
  await page.getByTestId('op-confirm').click();
  await expect(page.getByTestId('op-wizard')).toBeHidden();
  await expect.poll(async () => (await readOps(page)).length).toBe(2);
  const op2 = (await readOps(page)).find((o) => o.id !== op1.id)!;
  // Les mêmes généraux commandent la nouvelle opération.
  expect(op2.generals).toEqual(end1.generals);
  await setSpeed(page, 3600);
  await expect
    .poll(async () => (await readOps(page)).find((o) => o.id === op2.id)?.done ?? 0, {
      timeout: 600_000,
      intervals: [2_000],
    })
    .toBeGreaterThan(0);
  await setSpeed(page, 1);
  await shot(page, '7-same-staff-acts', mobile);
  expect(errors).toEqual([]);
});
