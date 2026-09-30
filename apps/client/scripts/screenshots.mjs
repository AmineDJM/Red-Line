// Captures d'écran de vérification visuelle (mode ?mock=1), en viewport mobile et ordinateur.
// Usage : REDLINE_LOCAL_DATA=1 pnpm --filter @redline/client dev  (dans un autre terminal)
//         node scripts/screenshots.mjs [baseUrl] [dossierDeSortie]
// Chromium préinstallé : PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (ne jamais lancer `playwright install`).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const base = process.argv[2] ?? 'http://localhost:5173';
const out = path.resolve(process.argv[3] ?? 'screenshots');
const only = process.env.SHOTS ? process.env.SHOTS.split(',') : null;
fs.mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});

const logs = [];
async function page(vp, { tutorialDone = true } = {}) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], locale: 'fr-FR' });
  await ctx.addInitScript((done) => {
    try {
      if (done) localStorage.setItem('rl.tutorial.done', '1');
      else localStorage.removeItem('rl.tutorial.done');
      localStorage.setItem('rl.legend.open', '1');
    } catch {}
  }, tutorialDone);
  const p = await ctx.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${vp}] ${m.type()}: ${m.text()}`);
  });
  p.on('pageerror', (e) => logs.push(`[${vp}] pageerror: ${e.message}`));
  return { ctx, p };
}

async function waitMap(p) {
  await p.waitForFunction(() => window.__rlMap?.map?.loaded?.() && window.__rlMap.map.areTilesLoaded(), null, { timeout: 12_000 }).catch(() => {});
  await p.waitForTimeout(1800);
}

async function shot(p, name) {
  const file = path.join(out, `${name}.png`);
  await p.screenshot({ path: file });
  console.log('✔', file);
}

const want = (n) => !only || only.some((o) => n.includes(o));

for (const vp of ['desktop', 'mobile']) {
  if (want(`home-${vp}`)) {
    const { ctx, p } = await page(vp);
    await p.goto(`${base}/?mock=1`);
    await p.waitForTimeout(800);
    await shot(p, `home-${vp}`);
    await ctx.close();
  }
  if (want(`new-${vp}`)) {
    const { ctx, p } = await page(vp);
    await p.goto(`${base}/new?mock=1`);
    await waitMap(p);
    const row = p.locator('.nation-row', { hasText: 'Algérie' }).first();
    if (await row.count()) await row.click();
    await p.waitForTimeout(1500);
    await waitMap(p);
    await shot(p, `new-${vp}`);
    await ctx.close();
  }
  if (want(`game-${vp}`) || want(`select-${vp}`) || want(`order-${vp}`) || want(`attack-${vp}`) || want(`drawer-${vp}`)) {
    const { ctx, p } = await page(vp);
    await p.goto(`${base}/game/demo?mock=1`);
    await waitMap(p);
    // Cadrage sur le théâtre d'opérations.
    await p.evaluate(() => {
      const m = window.__rlMap.map;
      m.jumpTo({ center: [8, 33.5], zoom: window.innerWidth < 768 ? 3.9 : 4.6 });
    });
    await waitMap(p);
    if (want(`game-${vp}`)) await shot(p, `game-${vp}`);

    // Sélection d'une unité (chasseur de préférence) → arc de portée + fiche d'arme.
    const picked = await p.evaluate(() => {
      const { game, ui, world } = window.__rl;
      const v = game.getState().view;
      const me = game.getState().me;
      const own = Object.values(v.units).filter((u) => u.owner === me);
      const cat = (u) => world.getState().catalog[u.systemId]?.category;
      const u = own.find((x) => cat(x) === 'air_defense') ?? own.find((x) => cat(x) === 'artillery') ?? own[0];
      ui.getState().select([u.id]);
      return u.id;
    });
    await p.waitForTimeout(900);
    if (want(`select-${vp}`)) await shot(p, `select-${vp}`);

    // Ordre de déplacement : aperçu de trajectoire.
    await p.evaluate((id) => {
      const { game, ui } = window.__rl;
      const u = game.getState().view.units[id];
      ui.getState().setPending({ kind: 'move', unitIds: [id], to: [u.pos[0] + 7, u.pos[1] - 2.5] });
    }, picked);
    await p.waitForTimeout(900);
    if (want(`order-${vp}`)) await shot(p, `order-${vp}`);

    // Ordre d'attaque : triangle de lancement + pastille + cible.
    await p.evaluate((id) => {
      const { game, ui } = window.__rl;
      const v = game.getState().view;
      const me = game.getState().me;
      const u = v.units[id];
      const enemies = Object.values(v.units).filter((x) => x.owner !== me);
      enemies.sort((a, b) => Math.hypot(a.pos[0] - u.pos[0], a.pos[1] - u.pos[1]) - Math.hypot(b.pos[0] - u.pos[0], b.pos[1] - u.pos[1]));
      if (enemies[0]) ui.getState().setPending({ kind: 'attack', unitIds: [id], targetId: enemies[0].id });
    }, picked);
    await p.waitForTimeout(900);
    if (want(`attack-${vp}`)) await shot(p, `attack-${vp}`);

    if (want(`drawer-${vp}`)) {
      await p.evaluate(() => {
        window.__rl.ui.getState().setPending(null);
        window.__rl.ui.getState().openDrawer('production');
      });
      await p.waitForTimeout(700);
      await shot(p, `drawer-production-${vp}`);
      await p.evaluate(() => window.__rl.ui.getState().openDrawer('alerts'));
      await p.waitForTimeout(700);
      await shot(p, `drawer-alerts-${vp}`);
      await p.evaluate(() => window.__rl.ui.getState().openDrawer('army'));
      await p.waitForTimeout(700);
      await shot(p, `drawer-army-${vp}`);
    }
    await ctx.close();
  }
  if (want(`tutorial-${vp}`)) {
    const { ctx, p } = await page(vp, { tutorialDone: false });
    await p.goto(`${base}/game/demo?mock=1`);
    await waitMap(p);
    await shot(p, `tutorial-${vp}`);
    await ctx.close();
  }
  if (want(`world-${vp}`)) {
    const { ctx, p } = await page(vp);
    await p.goto(`${base}/game/demo?mock=1`);
    await waitMap(p);
    await p.evaluate(() => window.__rlMap.map.jumpTo({ center: [20, 25], zoom: window.innerWidth < 768 ? 1.4 : 2.1 }));
    await waitMap(p);
    await shot(p, `world-${vp}`);
    await ctx.close();
  }
}

await browser.close();
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
console.log(`${logs.length} messages console → ${path.join(out, 'console.log')}`);
