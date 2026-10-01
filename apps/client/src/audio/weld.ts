/**
 * Soudure d'une boucle décodée (fonction pure, testée).
 *
 * Les fichiers bouclés contiennent [fin de boucle] + boucle + [début de boucle] : la lecture tourne entre
 * `loopStart` et `loopEnd`. Les deux côtés de la jointure sont la même musique mais pas exactement les
 * mêmes échantillons (bruit de codec différent) : on fond les `k` échantillons précédant `loopEnd` vers
 * ceux qui précèdent `loopStart`. La lecture enchaîne alors x[a − 1] → x[a], continus dans le flux.
 */
export function weldLoop(data: Float32Array, a: number, b: number, k = 2048): void {
  const n = Math.min(k, a, b - a);
  if (n <= 0 || b > data.length) return;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const j = b - n + i;
    data[j] = data[j]! * (1 - f) + data[a - n + i]! * f;
  }
}
