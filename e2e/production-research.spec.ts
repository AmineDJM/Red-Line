import { expect, test } from '@playwright/test';
import { closeWindows, openWindow, preparePage, startSoloGame } from './helpers.js';

/**
 * Production et recherche, avec les vraies données (France, 2025) :
 *  - produire un Rafale depuis l'arsenal (photo, prix, bouton Produire) → file de production ;
 *  - Su-57 : possédé ≠ savoir produire → « R&D requise » ouvre l'arbre sur le nœud manquant, que l'on
 *    planifie avec ses prérequis ;
 *  - lancer une recherche disponible.
 */
test('production et recherche', async ({ page }, info) => {
  const errors = await preparePage(page);
  await startSoloGame(page, 'France');

  // 1. Arsenal → Rafale → Produire.
  await openWindow(page, 'production');
  const win = page.locator('.rl-win').first();
  await win.getByPlaceholder('Rechercher un système…').fill('Rafale');
  await win.getByText('Rafale', { exact: true }).first().click();
  const produce = page.getByTestId('produce-button');
  await expect(produce).toBeEnabled();
  await produce.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__rl.game
          .getState()
          .view.economy.production.map((p: { systemId: string }) => p.systemId),
      ),
    )
    .toContain('eu.rafale');
  await expect(
    page
      .locator('.rl-toast')
      .filter({ hasText: /Rafale/ })
      .first(),
  ).toBeVisible();
  await win.getByRole('tab', { name: /File de production/ }).click();
  await expect(win.getByText('Rafale').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('1-file.png') });

  // 2. Su-57 : R&D requise → arbre ouvert sur la 5e génération, planifiée avec ses prérequis.
  await win.getByRole('tab', { name: /Arsenal/ }).click();
  await win.getByRole('tab', { name: /Tous/ }).click();
  await win.getByPlaceholder('Rechercher un système…').fill('Su-57');
  await win.getByText('Su-57', { exact: true }).first().click();
  const rd = win.getByRole('button', { name: /^R&D/ });
  await expect(rd).toBeVisible();
  await expect(page.getByTestId('produce-button')).toHaveCount(0);
  await rd.click();
  const research = page.locator('#win-research');
  await expect(research.locator('.rnode[aria-selected="true"]')).toContainText(/5e génération/);
  await expect(research.getByText('Verrouillée', { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId('research-chain')).toBeVisible();
  await page.screenshot({ path: info.outputPath('2-su57-verrou.png') });
  await closeWindows(page);

  // Un nœud verrouillé abordable : on le planifie avec ses prérequis (plusieurs ordres « research »).
  const target = await page.evaluate(() => {
    const nodes = window.__rl.world.getState().research as Record<string, any>;
    const view = window.__rl.game.getState().view;
    const done = new Set<string>(view.research.done);
    const busy = new Set<string>([view.research.current?.id, ...view.research.queue]);
    const chain = (id: string, out: string[] = []): string[] => {
      const n = nodes[id];
      if (!n || done.has(id) || busy.has(id) || out.includes(id)) return out;
      for (const r of n.requires) chain(r, out);
      out.push(id);
      return out;
    };
    const cands = Object.keys(nodes)
      .map((id) => ({ id, c: chain(id) }))
      .filter((x) => x.c.length >= 2)
      .map((x) => ({ ...x, cost: x.c.reduce((s, id) => s + nodes[id].cost.money, 0) }))
      .filter((x) => x.cost < view.economy.money * 0.6)
      .sort((a, b) => a.cost - b.cost);
    return cands[0] ?? null;
  });
  expect(target).not.toBeNull();
  await openWindow(page, 'research', { nodeId: target!.id });
  const before = await page.evaluate(() => {
    const r = window.__rl.game.getState().view.research;
    return (r.current ? 1 : 0) + r.queue.length;
  });
  await page.getByTestId('research-chain').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = window.__rl.game.getState().view.research;
        return [r.current?.id, ...r.queue];
      }),
    )
    .toContain(target!.id);
  const after = await page.evaluate(() => {
    const r = window.__rl.game.getState().view.research;
    return (r.current ? 1 : 0) + r.queue.length;
  });
  expect(after).toBe(before + target!.c.length);
  await page.screenshot({ path: info.outputPath('2-recherche.png') });
  await closeWindows(page);

  // 3. Une recherche disponible s'ajoute à la file.
  const avail = await page.evaluate(() => {
    const nodes = Object.values<any>(window.__rl.world.getState().research);
    const view = window.__rl.game.getState().view;
    const done = new Set<string>(view.research.done);
    const busy = new Set<string>([view.research.current?.id, ...view.research.queue]);
    return (
      nodes
        .filter(
          (n) =>
            !done.has(n.id) &&
            !busy.has(n.id) &&
            n.requires.every((r: string) => done.has(r)) &&
            n.cost.money < view.economy.money,
        )
        .sort((a, b) => a.cost.money - b.cost.money)[0]?.id ?? null
    );
  });
  expect(avail).not.toBeNull();
  await closeWindows(page);
  await openWindow(page, 'research', { nodeId: avail! });
  await expect(research.locator('.rnode[aria-selected="true"]')).toHaveClass(/rnode--available/);
  await page.getByTestId('research-start').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = window.__rl.game.getState().view.research;
        return (r.current ? 1 : 0) + r.queue.length;
      }),
    )
    .toBe(after + 1);
  expect(errors).toEqual([]);
});
