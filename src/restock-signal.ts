/**
 * Restock signal registry — the producer/consumer link between the single
 * wishlist watcher (producer) and the per-item buyer tasks (consumers).
 *
 * One gate per configured item, keyed by product id. The watcher classifies
 * every item each poll and `fire()`s the gate on an out-of-stock → in-stock
 * transition; the matching buyer is waiting on `waitForRestock()` and wakes up.
 * Multiple gates can fire in the same poll, so N buyers run concurrently.
 *
 * This module is intentionally impure (holds promises/state) and therefore lives
 * outside decision.ts, which must stay pure.
 *
 * Latched semantics: once fired, a gate stays latched until `rearm()` so a still
 * in-stock item is not re-fired on every poll. A buyer that finishes (success or
 * a failed attempt) loops back to `waitForRestock`; it only re-fires after the
 * watcher observes the item go OOS and back in stock again.
 */

export interface RestockGate {
  /** Buyer awaits this; resolves on the next fire, or when `signal` aborts. */
  waitForRestock(signal: AbortSignal): Promise<void>;
  /** Watcher: signal a restock. No-op while already latched. */
  fire(): void;
  /** Watcher: item is out of stock again — allow the next restock to fire. */
  rearm(): void;
}

class Gate implements RestockGate {
  private resolver: (() => void) | null = null;
  private latched = false;

  waitForRestock(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        this.resolver = null;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.resolver = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
  }

  fire(): void {
    if (this.latched) return;
    this.latched = true;
    const resolve = this.resolver;
    this.resolver = null;
    if (resolve) resolve();
  }

  rearm(): void {
    this.latched = false;
  }
}

export class RestockRegistry {
  private readonly gates = new Map<string, Gate>();

  register(productId: string): RestockGate {
    const gate = new Gate();
    this.gates.set(productId, gate);
    return gate;
  }

  get(productId: string): RestockGate | undefined {
    return this.gates.get(productId);
  }

  /** Returns false when the id is unknown (matching-failure telemetry). */
  fire(productId: string): boolean {
    const gate = this.gates.get(productId);
    if (!gate) return false;
    gate.fire();
    return true;
  }

  rearm(productId: string): void {
    this.gates.get(productId)?.rearm();
  }

  /** Shutdown: wake every idle buyer so its task can settle. */
  abortAll(): void {
    for (const gate of this.gates.values()) {
      gate.fire();
    }
  }
}
