import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimiter } from "../src/rate-limiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately on first acquire for a domain", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 5_000, maxJitterMs: 0 });

    // Should not pend at all
    const promise = limiter.acquire("example.com");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
  });

  it("waits at least minIntervalMs before a second acquire", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 5_000, maxJitterMs: 0 });

    // First acquire — immediate
    const p1 = limiter.acquire("example.com");
    await vi.runAllTimersAsync();
    await p1;

    let resolved = false;
    const p2 = limiter.acquire("example.com").then(() => {
      resolved = true;
    });

    // Before the interval — not yet resolved
    await vi.advanceTimersByTimeAsync(3_000);
    expect(resolved).toBe(false);

    // After the full interval — should resolve
    await vi.advanceTimersByTimeAsync(3_000);
    await p2;
    expect(resolved).toBe(true);
  });

  it("does not block requests to different domains", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxJitterMs: 0 });

    const p1 = limiter.acquire("domain-a.com");
    await vi.runAllTimersAsync();
    await p1;

    // domain-b.com is fresh — should resolve immediately
    let resolved = false;
    const p2 = limiter.acquire("domain-b.com").then(() => {
      resolved = true;
    });
    await vi.runAllTimersAsync();
    await p2;
    expect(resolved).toBe(true);
  });

  it("reset() allows immediate reuse of a domain", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxJitterMs: 0 });

    const p1 = limiter.acquire("example.com");
    await vi.runAllTimersAsync();
    await p1;

    limiter.reset("example.com");

    // After reset, next acquire should be immediate
    let resolved = false;
    const p2 = limiter.acquire("example.com").then(() => {
      resolved = true;
    });
    // Run timers briefly — jitter is 0 so it should resolve in the next tick
    await vi.runAllTimersAsync();
    await p2;
    expect(resolved).toBe(true);
  });

  it("resetAll() clears all domain state", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxJitterMs: 0 });

    await Promise.all([
      limiter.acquire("a.com").then(() => vi.runAllTimersAsync()),
      limiter.acquire("b.com").then(() => vi.runAllTimersAsync()),
    ]);
    await vi.runAllTimersAsync();

    limiter.resetAll();

    expect(limiter.getLastUsed("a.com")).toBeNull();
    expect(limiter.getLastUsed("b.com")).toBeNull();
  });

  it("getLastUsed() returns null for an unseen domain", () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000, maxJitterMs: 0 });
    expect(limiter.getLastUsed("never-seen.com")).toBeNull();
  });

  it("getLastUsed() returns a recent timestamp after acquire", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000, maxJitterMs: 0 });
    const before = Date.now();

    const p = limiter.acquire("example.com");
    await vi.runAllTimersAsync();
    await p;

    const last = limiter.getLastUsed("example.com");
    expect(last).not.toBeNull();
    expect(last!).toBeGreaterThanOrEqual(before);
  });
});
