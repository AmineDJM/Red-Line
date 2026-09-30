/**
 * Ordonnanceur global unique du processus : un tas binaire des parties triées par leur prochaine
 * échéance réelle, et UN SEUL setTimeout, réarmé quand la tête du tas change.
 * Suppression paresseuse : chaque clé a une version ; les entrées obsolètes sont ignorées au dépilement.
 */
interface Entry {
  key: string;
  at: number;
  version: number;
}

const MAX_DELAY_MS = 60 * 60_000; // on se réveille au moins toutes les heures (setTimeout borné à 2^31 ms)

export class Scheduler {
  private heap: Entry[] = [];
  private live = new Map<string, { at: number; version: number }>();
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  private versionCounter = 0;
  private stopped = false;
  private firing = false;

  constructor(
    private readonly run: (key: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Programme (ou reprogramme) la clé à l'instant réel `at` ; null = plus rien à faire. */
  set(key: string, at: number | null): void {
    if (at === null || !Number.isFinite(at)) {
      this.live.delete(key);
      return;
    }
    const cur = this.live.get(key);
    if (cur && cur.at === at) return;
    const version = ++this.versionCounter;
    this.live.set(key, { at, version });
    this.push({ key, at, version });
    if (this.heap.length > 64 && this.heap.length > 2 * this.live.size) this.compact();
    if (!this.firing) this.arm();
  }

  delete(key: string): void {
    this.live.delete(key);
  }

  get size(): number {
    return this.live.size;
  }

  /** Prochaine échéance programmée pour une clé (tests, métriques). */
  dueAt(key: string): number | null {
    return this.live.get(key)?.at ?? null;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.heap = [];
    this.live.clear();
  }

  private arm(): void {
    if (this.stopped) return;
    this.dropStale();
    const top = this.heap[0];
    if (!top) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.timerAt = Infinity;
      return;
    }
    if (this.timer && this.timerAt <= top.at) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, top.at - this.now()));
    this.timerAt = top.at;
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    this.timerAt = Infinity;
    if (this.stopped) return;
    this.firing = true;
    try {
      const now = this.now();
      const due: string[] = [];
      for (;;) {
        this.dropStale();
        const top = this.heap[0];
        if (!top || top.at > now) break;
        this.pop();
        this.live.delete(top.key);
        due.push(top.key);
      }
      for (const key of due) {
        try {
          this.run(key);
        } catch {
          // `run` isole déjà les erreurs de chaque partie ; ceinture et bretelles.
        }
      }
    } finally {
      this.firing = false;
    }
    this.arm();
  }

  private dropStale(): void {
    for (;;) {
      const top = this.heap[0];
      if (!top) return;
      const cur = this.live.get(top.key);
      if (cur && cur.version === top.version) return;
      this.pop();
    }
  }

  private compact(): void {
    this.heap = [];
    for (const [key, { at, version }] of this.live) this.push({ key, at, version });
  }

  private less(a: Entry, b: Entry): boolean {
    return a.at < b.at || (a.at === b.at && a.version < b.version);
  }

  private push(e: Entry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  private pop(): Entry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
