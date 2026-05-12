/**
 * Per-domain rate limiter.
 *
 * Enforces a minimum interval between requests to the same domain,
 * plus random jitter to avoid machine-like request patterns.
 */

import { RateLimiterOptions } from "./types";

interface DomainState {
  lastUsedMs: number;
}

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxJitterMs: number;
  private readonly state = new Map<string, DomainState>();

  constructor(options: RateLimiterOptions) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxJitterMs = options.maxJitterMs;
  }

  /**
   * Waits until a request to `domain` is permitted, then marks the slot used.
   * The effective wait = max(0, minIntervalMs - elapsed) + jitter.
   */
  async acquire(domain: string): Promise<void> {
    const now = Date.now();
    const prev = this.state.get(domain);
    const jitter = Math.floor(Math.random() * this.maxJitterMs);

    let waitMs = jitter;
    if (prev !== undefined) {
      const elapsed = now - prev.lastUsedMs;
      const remaining = this.minIntervalMs - elapsed;
      if (remaining > 0) {
        waitMs += remaining;
      }
    }

    if (waitMs > 0) {
      await delay(waitMs);
    }

    this.state.set(domain, { lastUsedMs: Date.now() });
  }

  /** Reset state for a domain (used in tests). */
  reset(domain: string): void {
    this.state.delete(domain);
  }

  /** Reset all domain state. */
  resetAll(): void {
    this.state.clear();
  }

  /** Returns the timestamp (ms) of the last request to `domain`, or null. */
  getLastUsed(domain: string): number | null {
    return this.state.get(domain)?.lastUsedMs ?? null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
