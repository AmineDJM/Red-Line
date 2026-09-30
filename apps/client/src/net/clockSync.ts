/**
 * Synchronisation d'horloge par ping/pong : estime `offset = heureServeur - heureLocale`.
 * On garde les N derniers échantillons et on retient celui de plus petit aller-retour
 * (le moins perturbé par la file réseau), méthode classique type NTP simplifié.
 */
export interface ClockSample {
  rtt: number;
  offset: number;
}

export class ClockSync {
  private samples: ClockSample[] = [];
  constructor(private readonly keep = 8) {}

  /** `sent` et `received` en heure locale, `serverTime` lu dans le pong. */
  add(sent: number, serverTime: number, received: number): ClockSample {
    const rtt = Math.max(0, received - sent);
    const offset = serverTime + rtt / 2 - received;
    const s = { rtt, offset };
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.shift();
    return s;
  }

  get offset(): number {
    if (this.samples.length === 0) return 0;
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    return best.offset;
  }

  get rtt(): number | null {
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples.map((s) => s.rtt));
  }

  get size() {
    return this.samples.length;
  }

  reset() {
    this.samples = [];
  }
}
