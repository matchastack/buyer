import { describe, it, expect } from "vitest";
import { RestockRegistry } from "../src/restock-signal";

describe("RestockRegistry", () => {
  it("wakes a waiting buyer when its gate fires", async () => {
    const reg = new RestockRegistry();
    const gate = reg.register("123");
    const ac = new AbortController();

    let woke = false;
    const wait = gate.waitForRestock(ac.signal).then(() => {
      woke = true;
    });

    expect(woke).toBe(false);
    reg.fire("123");
    await wait;
    expect(woke).toBe(true);
  });

  it("returns false when firing an unknown id", () => {
    const reg = new RestockRegistry();
    reg.register("123");
    expect(reg.fire("999")).toBe(false);
    expect(reg.fire("123")).toBe(true);
  });

  it("stays latched: a second fire does not wake a freshly-waiting buyer until rearm", async () => {
    const reg = new RestockRegistry();
    const gate = reg.register("123");
    const ac = new AbortController();

    // First cycle: arm the wait, then fire to resolve it (latches the gate).
    const first = gate.waitForRestock(ac.signal);
    reg.fire("123");
    await first;

    // Gate is now latched. A fresh wait must NOT resolve on another fire.
    let woke = false;
    const wait = gate.waitForRestock(ac.signal).then(() => {
      woke = true;
    });
    reg.fire("123");
    await new Promise((r) => setTimeout(r, 5));
    expect(woke).toBe(false);

    // After rearm, a fire wakes it.
    reg.rearm("123");
    reg.fire("123");
    await wait;
    expect(woke).toBe(true);
  });

  it("resolves a pending wait when the signal aborts", async () => {
    const reg = new RestockRegistry();
    const gate = reg.register("123");
    const ac = new AbortController();

    let woke = false;
    const wait = gate.waitForRestock(ac.signal).then(() => {
      woke = true;
    });
    ac.abort();
    await wait;
    expect(woke).toBe(true);
  });

  it("returns immediately if the signal is already aborted", async () => {
    const reg = new RestockRegistry();
    const gate = reg.register("123");
    const ac = new AbortController();
    ac.abort();
    await gate.waitForRestock(ac.signal); // resolves without a fire
  });

  it("abortAll wakes every idle buyer", async () => {
    const reg = new RestockRegistry();
    const a = reg.register("a");
    const b = reg.register("b");
    const ac = new AbortController();

    const waits = Promise.all([a.waitForRestock(ac.signal), b.waitForRestock(ac.signal)]);
    reg.abortAll();
    await waits; // both resolve
  });
});
