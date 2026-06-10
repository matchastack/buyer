/**
 * Per-domain rate limiter.
 *
 * Enforces a minimum interval between requests to the same domain,
 * plus random jitter to avoid machine-like request patterns.
 *
 * Concurrent callers for the same domain are serialised via a promise
 * chain so they never overlap, regardless of how many workers call
 * acquire() simultaneously.
 */

import { RateLimiterOptions } from "./types";

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxJitterMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastUsed = new Map<string, number>();

  constructor(options: RateLimiterOptions) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxJitterMs = options.maxJitterMs;
  }

  /**
   * Waits until a request to `domain` is permitted, then marks the slot used.
   * Each caller chains off the previous caller's slot, so concurrent callers
   * are serialised and spaced at least minIntervalMs + jitter apart.
   */
  async acquire(domain: string): Promise<void> {
    const jitter = Math.floor(Math.random() * this.maxJitterMs);
    const waitMs = this.minIntervalMs + jitter;

    const prev = this.queues.get(domain) ?? Promise.resolve();
    const next = prev.then(() => delay(waitMs));
    this.queues.set(domain, next);
    await next;

    this.lastUsed.set(domain, Date.now());
  }

  /** Reset state for a domain (used in tests). */
  reset(domain: string): void {
    this.queues.delete(domain);
    this.lastUsed.delete(domain);
  }

  /** Reset all domain state. */
  resetAll(): void {
    this.queues.clear();
    this.lastUsed.clear();
  }

  /** Returns the timestamp (ms) of the last completed request to `domain`, or null. */
  getLastUsed(domain: string): number | null {
    return this.lastUsed.get(domain) ?? null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
