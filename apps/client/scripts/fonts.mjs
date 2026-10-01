// Polices de repli des écritures non latines (arabe, devanagari, chinois, japonais, coréen) :
// génère apps/client/src/styles/fonts/<langue>.css depuis les paquets @fontsource, en WOFF2
// seulement (pas de doublons WOFF dans dist). Chaque fichier n'est importé (chunk CSS séparé) que
// pour sa langue ; les tranches unicode-range ne sont téléchargées que si un glyphe les utilise.
//   node apps/client/scripts/fonts.mjs && pnpm exec prettier --write apps/client/src/styles/fonts
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = path.join(ROOT, 'src/styles/fonts');
const MOD = path.join(ROOT, 'node_modules/@fontsource');

/** Langue → paquets, fichiers CSS (sous-ensembles × graisses) et pile de polices. */
const SETS = {
  ar: {
    files: [
      'ibm-plex-sans-arabic/arabic-400.css',
      'ibm-plex-sans-arabic/arabic-600.css',
      'ibm-plex-sans-arabic/arabic-700.css',
    ],
    stack: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Segoe UI', Tahoma",
    // Lettres liées : aucun espacement de lettres ; corps un peu plus grand pour la lisibilité.
    extra: `html:lang(ar) body * {\n  letter-spacing: 0 !important;\n}\n`,
    scale: 1.08,
  },
  hi: {
    files: ['noto-sans-devanagari/devanagari-400.css', 'noto-sans-devanagari/devanagari-600.css'],
    stack: "'Noto Sans Devanagari', 'Nirmala UI', 'Kohinoor Devanagari'",
    extra: `html:lang(hi) body * {\n  letter-spacing: 0 !important;\n}\n`,
    scale: 1.06,
  },
  // CJK : polices du système d'abord (aucun téléchargement), Noto en dernier recours (400 seul).
  zh: {
    files: ['noto-sans-sc/400.css'],
    stack: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC'",
    extra: '',
    scale: 1.04,
  },
  ja: {
    files: ['noto-sans-jp/400.css'],
    stack: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, 'Noto Sans CJK JP', 'Noto Sans JP'",
    extra: '',
    scale: 1.04,
  },
  ko: {
    files: ['noto-sans-kr/400.css'],
    stack: "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', 'Noto Sans KR'",
    extra: '',
    scale: 1.04,
  },
};

const SIZES = { '2xs': 10, xs: 10.5, sm: 11.5, '': 12.5, md: 13.5, lg: 15 };

fs.mkdirSync(OUT, { recursive: true });
for (const [lang, set] of Object.entries(SETS)) {
  let css = `/* Généré par apps/client/scripts/fonts.mjs : ne pas modifier. */\n`;
  for (const f of set.files) {
    const dir = path.dirname(path.join(MOD, f));
    const src = fs.readFileSync(path.join(MOD, f), 'utf8');
    const rel = path.relative(OUT, dir).split(path.sep).join('/');
    css += src
      .replace(/\/\*.*?\*\/\n/g, '')
      .replace(
        /src: url\(\.\/(files\/[^)]+\.woff2)\) format\('woff2'\), url\([^)]+\) format\('woff'\);/g,
        (_m, file) => `src: url(${rel}/${file}) format('woff2');`,
      );
  }
  const sizes = Object.entries(SIZES)
    .map(([k, v]) => `  --rl-fs${k ? `-${k}` : ''}: ${Math.round(v * set.scale * 10) / 10}px;`)
    .join('\n');
  css += `\n:root:lang(${lang}) {\n  --rl-font-mono: 'JetBrains Mono', ${set.stack}, ui-monospace, monospace;\n  --rl-track: 0.04em;\n${sizes}\n}\n${set.extra}`;
  fs.writeFileSync(path.join(OUT, `${lang}.css`), css);
  console.log(`${lang}.css`);
}
