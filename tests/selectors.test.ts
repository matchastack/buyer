import { vi, describe, it, expect } from "vitest";
import {
  resolveSelector,
  SelectorNotFoundError,
} from "../src/selectors";
import { SelectorSet } from "../src/types";

// ---------------------------------------------------------------------------
// Mock page factory
// ---------------------------------------------------------------------------

/**
 * Returns a minimal Page-like object. Only `locator` is needed; it returns
 * a locator with a `.first()` chain (matching how resolveSelector calls it)
 * and an `isVisible` that resolves to true iff the selector is in
 * `visibleSelectors`.
 */
function makeMockPage(visibleSelectors: string[]) {
  return {
    locator: (selector: string) => ({
      first: () => ({
        isVisible: (_opts?: { timeout?: number }) =>
          Promise.resolve(visibleSelectors.includes(selector)),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoCandidate: SelectorSet = {
  description: "Two-candidate optional selector",
  candidates: [".first-candidate", ".second-candidate"],
  required: false,
};

const threeCandidate: SelectorSet = {
  description: "Three-candidate optional selector",
  candidates: [".alpha", ".beta", ".gamma"],
  required: false,
};

const requiredSet: SelectorSet = {
  description: "Required selector that must be present",
  candidates: [".req-a", ".req-b"],
  required: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveSelector", () => {
  it("returns { selector, candidateIndex: 0 } when the first candidate is visible", async () => {
    const page = makeMockPage([".first-candidate"]);
    const result = await resolveSelector(page as any, twoCandidate, 100);
    expect(result).not.toBeNull();
    expect(result!.selector).toBe(".first-candidate");
    expect(result!.candidateIndex).toBe(0);
  });

  it("skips invisible candidates and returns the second candidate when first is not visible", async () => {
    const page = makeMockPage([".second-candidate"]);
    const result = await resolveSelector(page as any, twoCandidate, 100);
    expect(result).not.toBeNull();
    expect(result!.selector).toBe(".second-candidate");
    expect(result!.candidateIndex).toBe(1);
  });

  it("returns null for a non-required selector when no candidate is visible", async () => {
    const page = makeMockPage([]);
    const result = await resolveSelector(page as any, twoCandidate, 100);
    expect(result).toBeNull();
  });

  it("throws SelectorNotFoundError for a required selector when no candidate is visible", async () => {
    const page = makeMockPage([]);
    await expect(
      resolveSelector(page as any, requiredSet, 100)
    ).rejects.toThrow(SelectorNotFoundError);
  });

  it("SelectorNotFoundError message contains the description and candidates", async () => {
    const page = makeMockPage([]);
    try {
      await resolveSelector(page as any, requiredSet, 100);
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorNotFoundError);
      const error = err as SelectorNotFoundError;
      expect(error.message).toContain(requiredSet.description);
      expect(error.message).toContain(".req-a");
      expect(error.message).toContain(".req-b");
      expect(error.name).toBe("SelectorNotFoundError");
    }
  });

  it("resolves with candidateIndex matching whichever candidate matched (index 2)", async () => {
    const page = makeMockPage([".gamma"]);
    const result = await resolveSelector(page as any, threeCandidate, 100);
    expect(result).not.toBeNull();
    expect(result!.selector).toBe(".gamma");
    expect(result!.candidateIndex).toBe(2);
  });

  it("passes the timeoutMs option through to isVisible", async () => {
    const calls: number[] = [];
    const page = {
      locator: (_selector: string) => ({
        first: () => ({
          isVisible: (opts?: { timeout?: number }) => {
            calls.push(opts?.timeout ?? -1);
            return Promise.resolve(false);
          },
        }),
      }),
    };
    const set: SelectorSet = {
      description: "timeout check",
      candidates: [".only"],
      required: false,
    };
    await resolveSelector(page as any, set, 7777);
    expect(calls).toEqual([7777]);
  });

  it("continues to next candidate when isVisible throws (transient error)", async () => {
    let callCount = 0;
    const page = {
      locator: (_selector: string) => ({
        first: () => ({
          isVisible: (_opts?: { timeout?: number }) => {
            callCount++;
            if (callCount === 1) return Promise.reject(new Error("timeout"));
            return Promise.resolve(true);
          },
        }),
      }),
    };
    const set: SelectorSet = {
      description: "error recovery",
      candidates: [".throws", ".visible"],
      required: false,
    };
    const result = await resolveSelector(page as any, set, 100);
    expect(result).not.toBeNull();
    expect(result!.candidateIndex).toBe(1);
    expect(result!.selector).toBe(".visible");
  });
});
