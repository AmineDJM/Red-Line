// Capture réelle du jeu pour les pages publiques et l'image de partage (Open Graph / Twitter).
//
// Usage : serveur Red Line lancé (pnpm build && pnpm start, base locale), puis
//   node apps/site/scripts/capture.mjs [http://localhost:3000] [nation]
// Produit (à committer) :
//   apps/site/static/shots/game-1600.webp, game-800.webp   capture du jeu (pages publiques)
//   apps/site/static/og/og-<langue>.jpg                    1200×630, capture + titre par langue
// Chromium préinstallé : PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (ne jamais lancer `playwright install`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const require = createRequire(join(site, '../../package.json'));
const { chromium } = require('@playwright/test');

const base = process.argv[2] ?? 'http://localhost:3000';
const nation = process.argv[3] ?? 'France';
const CAMERA = { center: [18, 44], zoom: 3.4 };
// Image de partage : texte à gauche, la France et l'Europe à droite.
const OG_CAMERA = { center: [-8, 45], zoom: 3.75 };

const OG = {
  fr: {
    kicker: 'Jeu de stratégie géopolitique · temps réel · gratuit',
    title: 'La guerre mondiale, en temps réel, sur la vraie carte du monde.',
    foot: '201 nations · 406 matériels réels · jusqu’à 64 joueurs',
  },
  en: {
    kicker: 'Geopolitical strategy game · real time · free',
    title: 'World war, in real time, on the real world map.',
    foot: '201 nations · 406 real weapon systems · up to 64 players',
  },
};

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'fr-FR' });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('rl.debug', '1');
    localStorage.setItem('rl.tutorial.done', '1');
  } catch {
    /* about:blank */
  }
});
const page = await ctx.newPage();
page.setDefaultTimeout(120_000);
const accept = page.getByTestId('legal-accept');
await page.addLocatorHandler(accept, async () => {
  const box = page.getByRole('dialog').getByRole('checkbox');
  if (!(await box.isChecked())) await box.check();
  await accept.click();
});
await page.goto(base);
await page.getByRole('button', { name: 'Jouer en invité' }).click();
await page.waitForURL('**/new');
await page.getByPlaceholder('Rechercher une nation…').fill(nation);
await page
  .locator('.nation-row', { hasText: new RegExp(`^${nation}`) })
  .first()
  .click();
await page.getByRole('button', { name: 'Lancer la partie' }).click();
await page.waitForURL('**/game/**');
await page.waitForFunction(
  () => window.__rl?.game.getState().view && window.__rlMap?.map?.loaded(),
  null,
  { timeout: 180_000 },
);
await page.evaluate((c) => window.__rlMap.map.jumpTo(c), CAMERA);
await page
  .waitForFunction(() => window.__rlMap.map.areTilesLoaded(), null, { timeout: 30_000 })
  .catch(() => {});
await page.waitForTimeout(2500);
const png = await page.screenshot({ type: 'png' });
await page.evaluate((c) => window.__rlMap.map.jumpTo(c), OG_CAMERA);
await page
  .waitForFunction(() => window.__rlMap.map.areTilesLoaded(), null, { timeout: 30_000 })
  .catch(() => {});
await page.waitForTimeout(2500);
const ogPng = await page.screenshot({ type: 'png' });
await ctx.close();

// Conversions (WebP pour les pages, JPEG 1200×630 pour le partage) dans Chromium lui-même.
const tool = await browser.newPage({ viewport: { width: 1200, height: 630 } });
const src = `data:image/png;base64,${png.toString('base64')}`;
const ogSrc = `data:image/png;base64,${ogPng.toString('base64')}`;
const toWebp = (width) =>
  tool.evaluate(
    async ([s, w]) => {
      const img = new Image();
      img.src = s;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.round((img.height * w) / img.width);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', 0.82).split(',')[1];
    },
    [src, width],
  );
mkdirSync(join(site, 'static/shots'), { recursive: true });
for (const w of [1600, 800]) {
  writeFileSync(join(site, `static/shots/game-${w}.webp`), Buffer.from(await toWebp(w), 'base64'));
}

const tokens = readFileSync(join(site, '../../packages/ui/src/tokens.css'), 'utf8');
const font = (w) =>
  `data:font/woff2;base64,${readFileSync(
    require.resolve(`@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`, {
      paths: [site],
    }),
  ).toString('base64')}`;
mkdirSync(join(site, 'static/og'), { recursive: true });
for (const [lang, t] of Object.entries(OG)) {
  await tool.setContent(`<!doctype html><html><head><style>${tokens}
    @font-face{font-family:'JetBrains Mono';font-weight:400;src:url(${font(400)}) format('woff2')}
    @font-face{font-family:'JetBrains Mono';font-weight:700;src:url(${font(700)}) format('woff2')}
    body{margin:0;width:1200px;height:630px;overflow:hidden;background:var(--rl-bg);font-family:var(--rl-font-mono)}
    .shot{position:absolute;inset:0;background:url(${ogSrc}) 50% 45%/cover}
    .fade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(10,14,19,.97) 0%,rgba(10,14,19,.86) 44%,rgba(10,14,19,.15) 78%)}
    .box{position:absolute;left:64px;top:70px;width:600px;color:var(--rl-text)}
    .logo{font-size:44px;font-weight:700;letter-spacing:.08em;color:var(--rl-text-strong)}
    .logo span{position:relative;margin-left:.3ch;color:var(--rl-text-dim)}
    .logo span:after{content:'';position:absolute;left:-.3ch;right:-.15ch;top:52%;height:4px;background:var(--rl-red);box-shadow:0 0 14px rgba(255,77,94,.7)}
    .k{margin-top:40px;color:var(--rl-cyan);font-size:18px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
    h1{margin:16px 0 0;font-size:42px;line-height:1.15;color:var(--rl-text-strong)}
    .f{position:absolute;left:64px;bottom:58px;color:var(--rl-amber);font-size:20px;font-weight:700}
    .bar{position:absolute;left:0;right:0;bottom:0;height:6px;background:var(--rl-cyan)}
  </style></head><body><div class="shot"></div><div class="fade"></div>
  <div class="box"><div class="logo">RED<span>LINE</span></div><div class="k">${t.kicker}</div><h1>${t.title}</h1></div>
  <div class="f">${t.foot}</div><div class="bar"></div></body></html>`);
  await tool.evaluate(() => document.fonts.ready);
  await tool.waitForTimeout(300);
  writeFileSync(
    join(site, `static/og/og-${lang}.jpg`),
    await tool.screenshot({ type: 'jpeg', quality: 86 }),
  );
}
await browser.close();
console.log('captures écrites dans apps/site/static/{shots,og}');
