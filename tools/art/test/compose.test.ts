import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeCutout, keepBox, prepareSubject } from '../src/compose.js';

const TOOL = resolve(__dirname, '..');

/** Découpe synthétique : rectangle opaque rouge au centre d'une image transparente. */
async function fakeCutout(w = 400, h = 300): Promise<Buffer> {
  const subject = await sharp({
    create: {
      width: 200,
      height: 100,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subject, left: 100, top: 100 }])
    .png()
    .toBuffer();
}

describe('composition des fiches détourées', () => {
  it('produit une image à la taille demandée, sujet centré sur ~80 % de la largeur', async () => {
    const subject = await prepareSubject(await fakeCutout());
    expect([subject.w, subject.h]).toEqual([200, 100]);
    const img = await (await composeCutout(subject, 1280, 800)).png().toBuffer();
    const meta = await sharp(img).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 800]);
    // Le pixel central appartient au sujet (rouge dominant après étalonnage).
    const { data } = await sharp(img)
      .extract({ left: 640, top: 392, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]!).toBeGreaterThan(data[2]! + 60);
    // Les bords restent le fond sombre.
    const corner = await sharp(img)
      .extract({ left: 4, top: 4, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(Math.max(corner[0]!, corner[1]!, corner[2]!)).toBeLessThan(40);
  });

  it('keepBox écarte ce qui sort de la zone gardée', async () => {
    const boxed = await keepBox(await fakeCutout(), [0, 0, 0.5, 1]);
    const subject = await prepareSubject(boxed);
    expect(subject.w).toBe(100);
  });
});

describe('décisions de détourage (cutouts.json)', () => {
  const cutouts = JSON.parse(readFileSync(resolve(TOOL, 'cutouts.json'), 'utf8')) as Record<
    string,
    { title: string; use: boolean; reason: string }
  >;
  const selection = JSON.parse(readFileSync(resolve(TOOL, 'selection.json'), 'utf8')) as Record<
    string,
    { title?: string; none?: string }
  >;
  it('chaque décision cite la photo retenue et donne une raison', () => {
    for (const [id, c] of Object.entries(cutouts)) {
      expect(selection[id]?.title, id).toBe(c.title);
      expect(c.reason.length, id).toBeGreaterThan(0);
    }
  });
});
