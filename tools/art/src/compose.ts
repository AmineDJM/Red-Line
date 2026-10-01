// Composition des fiches photo, façon « terminal tactique » (couleurs de packages/ui/src/tokens.css) :
//   - sujet détouré : centré, ~80 % de la largeur, posé sur un fond sombre bleuté uniforme (dégradé, grille
//     discrète), ombre portée douce, vignettage léger ;
//   - photo non détourée : cadrage resserré, même étalonnage et même vignettage.
// Aucun pixel n'est inventé : le sujet est la photo d'origine, seul son arrière-plan est remplacé.
import sharp from 'sharp';

/** Jetons de couleur (repris de tokens.css : --rl-bg, --rl-panel-2, --rl-panel-3, --rl-cyan). */
const BG_EDGE = '#090d12';
const BG_MID = '#111a23';
const BG_CENTRE = '#1b2836';
const GRID = '#4cc9f0';

/** Place occupée par le sujet détouré : 80 % de la largeur au plus, 66 % de la hauteur au plus. */
export const SUBJECT_MAX_W = 0.8;
export const SUBJECT_MAX_H = 0.66;
/** Resserrement par défaut des photos non détourées. */
export const FRAME_TIGHTEN = 1.06;

/** Fond : dégradé radial sombre bleuté, grille fine et discrète (pas de 40 px en 1280 de large). */
export function backdropSvg(w: number, h: number): Buffer {
  const k = w / 1280;
  const step = Math.max(10, Math.round(40 * k));
  const op = w >= 800 ? 0.055 : 0.04;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <radialGradient id="g" cx="50%" cy="44%" r="72%">
      <stop offset="0" stop-color="${BG_CENTRE}"/>
      <stop offset="0.55" stop-color="${BG_MID}"/>
      <stop offset="1" stop-color="${BG_EDGE}"/>
    </radialGradient>
    <pattern id="p" width="${step}" height="${step}" patternUnits="userSpaceOnUse" x="${(w / 2) % step}" y="${(h / 2) % step}">
      <path d="M ${step} 0 L 0 0 0 ${step}" fill="none" stroke="${GRID}" stroke-opacity="${op}" stroke-width="1"/>
    </pattern>
    <radialGradient id="f" cx="50%" cy="50%" r="60%">
      <stop offset="0.3" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.25"/>
    </radialGradient>
    <mask id="m"><rect width="${w}" height="${h}" fill="url(#f)"/></mask>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#p)" mask="url(#m)"/>
</svg>`);
}

/** Vignettage léger, commun aux deux traitements. */
export function vignetteSvg(w: number, h: number, strength = 0.5): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <radialGradient id="v" cx="50%" cy="48%" r="75%">
      <stop offset="0.55" stop-color="#05080b" stop-opacity="0"/>
      <stop offset="1" stop-color="#05080b" stop-opacity="${strength}"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#v)"/>
</svg>`);
}

/** Ombre au sol : ellipse floue sous le sujet. */
function floorShadowSvg(w: number, h: number, cx: number, cy: number, rx: number, ry: number) {
  const blur = Math.max(2, Math.round(ry * 0.9));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000" fill-opacity="0.5" filter="url(#b)"/>
</svg>`);
}

/**
 * Étalonnage commun, discret : léger contraste, saturation réduite, dominante froide à peine perceptible,
 * accentuation légère, pour que des photos d'origines très diverses tiennent ensemble sur l'interface sombre.
 */
export function grade(img: sharp.Sharp, crisp = false): sharp.Sharp {
  return img
    .modulate({ saturation: 0.86, brightness: 0.99 })
    .linear(crisp ? 1.1 : 1.07, crisp ? -10 : -7)
    .recomb([
      [0.965, 0.025, 0.01],
      [0.01, 0.98, 0.01],
      [0.0, 0.03, 1.0],
    ])
    .sharpen(crisp ? { sigma: 0.8, m1: 0.6, m2: 1.6 } : { sigma: 0.6 });
}

type Rect = [number, number, number, number];

/**
 * Ne garde de la découpe que la zone `box` ([x0, y0, x1, y1] en fractions de l'image) et retire les zones
 * `erase` : écarte un second véhicule ou un élément de décor que le détourage a conservé à côté du sujet.
 * Seule la transparence change (aucun pixel n'est ajouté).
 */
export async function keepBox(
  png: Buffer,
  box?: Rect,
  erase: readonly Rect[] = [],
): Promise<Buffer> {
  if (!box && erase.length === 0) return png;
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const rect = ([x0, y0, x1, y1]: Rect, fill: string) =>
    `<rect x="${Math.round(x0 * width)}" y="${Math.round(y0 * height)}" ` +
    `width="${Math.max(1, Math.round((x1 - x0) * width))}" ` +
    `height="${Math.max(1, Math.round((y1 - y0) * height))}" fill="${fill}"/>`;
  const svg = (rects: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`,
    );
  // `dest-in` garde la zone `box`, `dest-out` retire les zones `erase`.
  const layers: sharp.OverlayOptions[] = [
    { input: svg(rect(box ?? [0, 0, 1, 1], '#fff')), blend: 'dest-in' },
  ];
  if (erase.length)
    layers.push({ input: svg(erase.map((r) => rect(r, '#fff')).join('')), blend: 'dest-out' });
  let img = await sharp(png).ensureAlpha().png().toBuffer();
  for (const layer of layers) img = await sharp(img).composite([layer]).png().toBuffer();
  return img;
}

/** Boîte englobante du sujet (pixels d'opacité ≥ 50 %). */
async function subjectBox(png: Buffer) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[y * w + x]! >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error('découpe vide');
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Prépare le sujet détouré : recadré sur sa boîte, masque nettoyé, étalonné (alpha conservé). */
export async function prepareSubject(
  png: Buffer,
): Promise<{ rgb: Buffer; alpha: Buffer; w: number; h: number }> {
  const box = await subjectBox(png);
  const cut = await sharp(png).ensureAlpha().extract(box).toBuffer();
  // Masque : on efface le voile très faible (< 4 %) laissé par le détourage.
  const alpha = await sharp(cut).extractChannel(3).linear(1.04, -10).toBuffer();
  const rgb = await sharp(cut).removeAlpha().toBuffer();
  return { rgb, alpha, w: box.width, h: box.height };
}

/** Fiche détourée w×h (RGB) : fond, ombre au sol, ombre portée, sujet, vignettage. */
export async function composeCutout(
  subject: { rgb: Buffer; alpha: Buffer; w: number; h: number },
  w: number,
  h: number,
): Promise<sharp.Sharp> {
  const scale = Math.min((w * SUBJECT_MAX_W) / subject.w, (h * SUBJECT_MAX_H) / subject.h);
  const sw = Math.max(1, Math.round(subject.w * scale));
  const sh = Math.max(1, Math.round(subject.h * scale));
  const x = Math.round((w - sw) / 2);
  const y = Math.round(h * 0.49 - sh / 2);
  const alpha = await sharp(subject.alpha)
    .resize(sw, sh, { kernel: 'lanczos3', fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  const rgb = await grade(
    sharp(subject.rgb).resize(sw, sh, { kernel: 'lanczos3', fit: 'fill' }),
    true,
  )
    .removeAlpha()
    .raw()
    .toBuffer();
  const subjectPng = await sharp(rgb, { raw: { width: sw, height: sh, channels: 3 } })
    .joinChannel(alpha, { raw: { width: sw, height: sh, channels: 1 } })
    .png()
    .toBuffer();
  // Ombre portée : masque flou, noir à 45 %, légèrement décalé vers le bas.
  const sigma = Math.max(1.5, w * 0.009);
  const pad = Math.ceil(sigma * 3);
  const shadow = await sharp(subjectPng)
    .linear([0, 0, 0, 0.45], [0, 0, 0, 0])
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .blur(sigma)
    .png()
    .toBuffer();
  const dy = Math.round(h * 0.018);
  const floor = floorShadowSvg(
    w,
    h,
    w / 2,
    Math.min(y + sh, h - 4),
    Math.round(sw * 0.44),
    Math.max(3, Math.round(h * 0.022)),
  );
  return sharp(backdropSvg(w, h)).composite([
    { input: floor, left: 0, top: 0 },
    { input: shadow, left: x - pad, top: y - pad + dy },
    { input: subjectPng, left: x, top: y },
    { input: vignetteSvg(w, h, 0.45), left: 0, top: 0 },
  ]);
}

/** Photo non détourée (déjà recadrée à w×h) : étalonnage et vignettage communs. */
export async function composeFramed(cropped: Buffer, w: number, h: number): Promise<sharp.Sharp> {
  const graded = await grade(sharp(cropped).resize(w, h, { fit: 'fill' })).toBuffer();
  return sharp(graded).composite([{ input: vignetteSvg(w, h, 0.55), left: 0, top: 0 }]);
}
