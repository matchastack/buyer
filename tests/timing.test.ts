import { describe, it, expect } from "vitest";
import { PhaseTimer } from "../src/timing";

/** A controllable clock so timing is deterministic in tests. */
function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe("PhaseTimer", () => {
  it("records each phase as the delta since the previous mark", () => {
    // construction reads 1000; marks read 1200, 1500
    const timer = new PhaseTimer(fakeClock([1000, 1200, 1500]));
    timer.mark("nav");
    timer.mark("buy");
    const { phasesMs } = timer.summary();
    expect(phasesMs).toEqual({ nav: 200, buy: 300 });
  });

  it("totalMs is measured from construction, not the last mark", () => {
    // construct 1000; mark reads 1200; total reads 1600
    const timer = new PhaseTimer(fakeClock([1000, 1200, 1600]));
    timer.mark("nav");
    expect(timer.totalMs()).toBe(600);
  });

  it("summary returns total and a copy of the phase map", () => {
    const timer = new PhaseTimer(fakeClock([0, 50, 50]));
    timer.mark("only");
    const s = timer.summary();
    expect(s.totalMs).toBe(50);
    expect(s.phasesMs).toEqual({ only: 50 });
    // mutating the returned map must not affect the timer's internal state
    s.phasesMs["injected"] = 999;
    expect(timer.summary().phasesMs).toEqual({ only: 50 });
  });

  it("defaults to a real clock and produces non-negative timings", () => {
    const timer = new PhaseTimer();
    timer.mark("x");
    expect(timer.summary().phasesMs["x"]).toBeGreaterThanOrEqual(0);
    expect(timer.totalMs()).toBeGreaterThanOrEqual(0);
  });

  it("markAt records the delta from the previous mark up to an absolute time", () => {
    // construct reads 1000; markAt uses the passed absolute time, not the clock
    const timer = new PhaseTimer(fakeClock([1000]));
    timer.markAt("buy_now_to_checkout", 1640); // 1640 - 1000 = 640
    // payment confirmed before the CTA was even seen → overlapped, residual 0
    timer.markAt("select_payment", 1640); // 1640 - 1640 = 0
    expect(timer.summary().phasesMs).toEqual({ buy_now_to_checkout: 640, select_payment: 0 });
  });

  it("a later mark measures from the time markAt set, and a residual phase shows through", () => {
    // construct 1000; the final relative mark reads 1900
    const timer = new PhaseTimer(fakeClock([1000, 1900]));
    timer.markAt("buy_now_to_checkout", 1640); // 640
    timer.markAt("select_payment", 1700); // 1700 - 1640 = 60 (payment was the residual bottleneck)
    timer.mark("place_order_to_confirm"); // clock reads 1900; 1900 - 1700 = 200
    expect(timer.summary().phasesMs).toEqual({
      buy_now_to_checkout: 640,
      select_payment: 60,
      place_order_to_confirm: 200,
    });
  });
});
