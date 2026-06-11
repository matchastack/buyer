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
});
