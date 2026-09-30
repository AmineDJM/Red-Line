/**
 * Animations peu coûteuses de la carte : tirets qui défilent le long des trajectoires (cycle de
 * `line-dasharray`, technique « ant path »), pulsations (propriétés de peinture), sans jamais
 * toucher aux données des sources. Cadence ~14 i/s, arrêtée quand rien n'est animé.
 */

/**
 * Suite de motifs [tiret, espace] décalés de `steps` pas sur une période : parcourue dans l'ordre,
 * les tirets avancent dans le sens du tracé.
 */
export function dashSequence(dash: number, gap: number, steps: number): number[][] {
  const period = dash + gap;
  const out: number[][] = [];
  for (let k = steps - 1; k >= 0; k--) {
    const o = (period * k) / steps;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    if (o < dash) out.push([r(dash - o), r(gap), r(o)]);
    else out.push([0, r(gap - (o - dash)), r(dash), r(o - dash)]);
  }
  return out;
}

/** Valeur d'une pulsation sinusoïdale entre `lo` et `hi` (période en ms). */
export function pulse(now: number, periodMs: number, lo: number, hi: number): number {
  return lo + (hi - lo) * (0.5 + 0.5 * Math.sin((now / periodMs) * Math.PI * 2));
}
