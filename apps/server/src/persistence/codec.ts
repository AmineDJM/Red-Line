import { promisify } from 'node:util';
import { brotliDecompress, gunzip, gzip, constants as zc } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const brotliDecompressAsync = promisify(brotliDecompress);

export type Codec = 'gzip' | 'br' | 'none';

/** Compression des instantanés (gzip : bon compromis vitesse/taille, asynchrone hors de la boucle). */
export async function compressSnapshot(bytes: Uint8Array): Promise<{ codec: Codec; data: Buffer }> {
  const data = await gzipAsync(bytes, { level: zc.Z_DEFAULT_COMPRESSION });
  return { codec: 'gzip', data };
}

export async function decompressSnapshot(codec: string, data: Buffer): Promise<Uint8Array> {
  let out: Buffer;
  if (codec === 'gzip') out = await gunzipAsync(data);
  else if (codec === 'br') out = await brotliDecompressAsync(data);
  else out = data;
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
