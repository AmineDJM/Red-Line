/** Précompresse (Brotli + gzip) les fichiers texte des dossiers donnés. */
export function precompress(
  dirs: string[],
): Promise<{ files: number; before: number; after: number }>;
