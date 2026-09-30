// Planches contact : grilles de vignettes légendées, pour contrôler visuellement les choix.
import sharp from 'sharp';

export interface Tile {
  image: Buffer | null;
  label: string;
  sub?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function contactSheet(
  tiles: Tile[],
  out: string,
  {
    cols = 6,
    w = 320,
    h = 200,
    fit = 'cover',
  }: { cols?: number; w?: number; h?: number; fit?: 'cover' | 'contain' } = {},
): Promise<void> {
  const labelH = 34;
  const gap = 6;
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * (w + gap) + gap;
  const H = rows * (h + labelH + gap) + gap;
  const layers: sharp.OverlayOptions[] = [];
  for (const [i, t] of tiles.entries()) {
    const x = gap + (i % cols) * (w + gap);
    const y = gap + Math.floor(i / cols) * (h + labelH + gap);
    if (t.image) {
      const img = await sharp(t.image)
        .resize(w, h, { fit, background: '#0a0e13' })
        .flatten({ background: '#0a0e13' })
        .toBuffer();
      layers.push({ input: img, left: x, top: y });
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${labelH}">
      <rect width="100%" height="100%" fill="#0e141b"/>
      <text x="4" y="14" font-family="DejaVu Sans Mono" font-size="12" fill="#4cc9f0">${esc(t.label.slice(0, 44))}</text>
      <text x="4" y="29" font-family="DejaVu Sans Mono" font-size="10" fill="#7d8b99">${esc((t.sub ?? '').slice(0, 52))}</text>
    </svg>`;
    layers.push({ input: Buffer.from(svg), left: x, top: y + h });
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#0a0e13' } })
    .composite(layers)
    .jpeg({ quality: 82 })
    .toFile(out);
}
