import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Métriques du processus pour /admin/api/metrics. */
export class ProcessMetrics {
  private readonly started = Date.now();
  private readonly loop: ReturnType<typeof monitorEventLoopDelay>;
  private cpuPct = 0;
  private lagMs = 0;
  private lagP99Ms = 0;
  private lagMaxMs = 0;
  /** Diffusions (vues + diffs) : coût CPU maximal sur la dernière fenêtre d'échantillonnage. */
  private flushMaxMs = 0;
  private flushMaxWindow = 0;
  private lastCpu = process.cpuUsage();
  private lastSample = process.hrtime.bigint();
  private readonly timer: NodeJS.Timeout;
  /** Événements traités, par seconde, sur une fenêtre glissante de 60 s. */
  private readonly buckets = new Array<number>(60).fill(0);
  private bucketSecond = Math.floor(Date.now() / 1000);

  constructor(sampleMs = 5000) {
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.timer = setInterval(() => this.sample(), sampleMs);
    this.timer.unref();
  }

  private sample(): void {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.lastSample) / 1000;
    const cpu = process.cpuUsage(this.lastCpu);
    this.cpuPct = elapsedUs > 0 ? ((cpu.user + cpu.system) / elapsedUs) * 100 : 0;
    this.lastCpu = process.cpuUsage();
    this.lastSample = now;
    const mean = this.loop.mean;
    this.lagMs = Number.isFinite(mean) ? mean / 1e6 : 0;
    const p99 = this.loop.percentile(99);
    this.lagP99Ms = Number.isFinite(p99) ? p99 / 1e6 : 0;
    const max = this.loop.max;
    this.lagMaxMs = Number.isFinite(max) ? max / 1e6 : 0;
    this.loop.reset();
    this.flushMaxMs = this.flushMaxWindow;
    this.flushMaxWindow = 0;
  }

  private rotate(): void {
    const sec = Math.floor(Date.now() / 1000);
    const gap = sec - this.bucketSecond;
    if (gap <= 0) return;
    for (let i = 1; i <= Math.min(gap, 60); i++) this.buckets[(this.bucketSecond + i) % 60] = 0;
    this.bucketSecond = sec;
  }

  recordEvents(n: number): void {
    if (n <= 0) return;
    this.rotate();
    this.buckets[this.bucketSecond % 60]! += n;
  }

  /** Coût CPU d'une diffusion complète d'une partie (toutes nations). */
  recordFlush(ms: number): void {
    this.count('flushes');
    this.count('flushMs', ms);
    this.flushMaxWindow = Math.max(this.flushMaxWindow, ms);
  }

  eventsPerMinute(): number {
    this.rotate();
    return this.buckets.reduce((a, b) => a + b, 0);
  }

  /** Compteurs nommés sur une fenêtre glissante de 60 s (octets WS, messages, chat, push…). */
  private readonly counters = new Map<string, { buckets: number[]; second: number }>();

  count(name: string, n = 1): void {
    if (n <= 0) return;
    const sec = Math.floor(Date.now() / 1000);
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { buckets: new Array<number>(60).fill(0), second: sec }));
    this.rotateCounter(c, sec);
    c.buckets[sec % 60]! += n;
  }

  perMinute(name: string): number {
    const c = this.counters.get(name);
    if (!c) return 0;
    this.rotateCounter(c, Math.floor(Date.now() / 1000));
    return c.buckets.reduce((a, b) => a + b, 0);
  }

  private rotateCounter(c: { buckets: number[]; second: number }, sec: number): void {
    const gap = sec - c.second;
    if (gap <= 0) return;
    for (let i = 1; i <= Math.min(gap, 60); i++) c.buckets[(c.second + i) % 60] = 0;
    c.second = sec;
  }

  snapshot(): {
    uptimeS: number;
    rssMb: number;
    heapMb: number;
    cpuPct: number;
    eventLoopLagMs: number;
    eventLoopP99Ms: number;
    eventLoopMaxMs: number;
    flushMaxMs: number;
  } {
    const mem = process.memoryUsage();
    const round = (x: number) => Math.round(x * 10) / 10;
    return {
      uptimeS: Math.round((Date.now() - this.started) / 1000),
      rssMb: round(mem.rss / 1048576),
      heapMb: round(mem.heapUsed / 1048576),
      cpuPct: round(this.cpuPct),
      eventLoopLagMs: round(this.lagMs),
      eventLoopP99Ms: round(this.lagP99Ms),
      eventLoopMaxMs: round(this.lagMaxMs),
      flushMaxMs: round(Math.max(this.flushMaxMs, this.flushMaxWindow)),
    };
  }

  stop(): void {
    clearInterval(this.timer);
    this.loop.disable();
  }
}
