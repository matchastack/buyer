/**
 * Lightweight phase timing for the buy path.
 *
 * Measures wall-clock durations between named marks so logs can show where the
 * in-stock → purchase-confirm time goes. The clock is injectable for tests.
 */

export interface TimingSummary {
  totalMs: number;
  phasesMs: Record<string, number>;
}

export class PhaseTimer {
  private readonly now: () => number;
  private readonly startMs: number;
  private lastMarkMs: number;
  private readonly phases: Record<string, number> = {};

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startMs = now();
    this.lastMarkMs = this.startMs;
  }

  /** Records the time since the previous mark (or start) under `name`. */
  mark(name: string): void {
    const t = this.now();
    this.phases[name] = t - this.lastMarkMs;
    this.lastMarkMs = t;
  }

  /** Milliseconds since the timer was created. */
  totalMs(): number {
    return this.now() - this.startMs;
  }

  summary(): TimingSummary {
    return { totalMs: this.totalMs(), phasesMs: { ...this.phases } };
  }
}
