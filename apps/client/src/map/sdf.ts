/**
 * Champ de distance signée (SDF) à partir de la couche alpha d'un canvas, par transformée de
 * distance euclidienne exacte (Felzenszwalb & Huttenlocher), comme TinySDF.
 * Convention MapLibre : bord de la forme à alpha = 192/255 (cutoff 0,25).
 */
const INF = 1e20;

function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint16Array,
  z: Float64Array,
) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    const qr = q - r;
    grid[offset + q * stride] = f[r]! + qr * qr;
  }
}

function edt2d(grid: Float64Array, width: number, height: number) {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/**
 * Convertit une couche alpha (0..255, forme antialiasée) en SDF sur 0..255.
 * `radius` : distance (px) couverte de part et d'autre du bord.
 */
export function alphaToSdf(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  radius: number,
  cutoff = 0.25,
): Uint8ClampedArray {
  const size = width * height;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = alpha[i]! / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt2d(outer, width, height);
  edt2d(inner, width, height);
  const out = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i++) {
    const d = Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!);
    out[i] = Math.round(255 - 255 * (d / radius + cutoff));
  }
  return out;
}

/** Dessine via `draw` sur un canvas w×h, puis renvoie une image RGBA SDF (alpha = distance). */
export function renderSdf(
  width: number,
  height: number,
  radius: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): { width: number; height: number; data: Uint8ClampedArray } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  draw(ctx);
  const src = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = src[i * 4 + 3]!;
  const sdf = alphaToSdf(alpha, width, height, radius);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < sdf.length; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = sdf[i]!;
  }
  return { width, height, data };
}
