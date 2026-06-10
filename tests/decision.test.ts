import { describe, it, expect } from "vitest";
import {
  isPriceAcceptable,
  shouldProceed,
  computeBackoff,
  computeChallengeBackoff,
  extractProductId,
  isRestockTransition,
  parseWishlistStock,
  classifyFromWishlistState,
  isAntiBot,
  formatOrderSummary,
} from "../src/decision";
import { StockCheckResult, Item, OrderSummary } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseItem: Item = {
  url: "https://www.lazada.sg/products/test-item.html",
  name: "Pikachu Plush",
  maxPrice: 50,
  quantity: 1,
};

const availableResult: StockCheckResult = {
  status: "in_stock",
  price: 39.9,
  itemName: "Pikachu Plush",
  pageTitle: "Pikachu Plush | Lazada",
  url: baseItem.url,
  timestamp: "2024-05-01T10:00:00.000Z",
};

const orderSummary: OrderSummary = {
  itemName: "Pikachu Plush",
  itemUrl: "https://www.lazada.sg/products/test-item.html",
  price: 39.9,
  quantity: 2,
  estimatedTotal: 79.8,
  deliveryAddress: "123 Orchard Road, Singapore 238858",
  paymentMethod: "PayNow",
};

// ---------------------------------------------------------------------------
// isPriceAcceptable
// ---------------------------------------------------------------------------

describe("isPriceAcceptable", () => {
  it("returns true when price is below maxPrice", () => {
    expect(isPriceAcceptable(39.9, 50)).toBe(true);
  });

  it("returns true when price equals maxPrice exactly", () => {
    expect(isPriceAcceptable(50, 50)).toBe(true);
  });

  it("returns false when price exceeds maxPrice", () => {
    expect(isPriceAcceptable(50.01, 50)).toBe(false);
  });

  it("returns true when price is null (unknown — allow human to confirm)", () => {
    expect(isPriceAcceptable(null, 50)).toBe(true);
  });

  it("returns false for significantly over-priced item", () => {
    expect(isPriceAcceptable(200, 50)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldProceed
// ---------------------------------------------------------------------------

describe("shouldProceed", () => {
  it("returns proceed=true for available item within price in live mode", () => {
    const decision = shouldProceed(availableResult, baseItem, false);
    expect(decision.proceed).toBe(true);
  });

  it("returns proceed=false in dry-run mode even if item is available", () => {
    const decision = shouldProceed(availableResult, baseItem, true);
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/dry-run/i);
  });

  it("returns proceed=false when status is out_of_stock", () => {
    const result: StockCheckResult = { ...availableResult, status: "out_of_stock" };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(false);
  });

  it("returns proceed=false when status is unknown", () => {
    const result: StockCheckResult = { ...availableResult, status: "unknown" };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(false);
  });

  it("returns proceed=false and mentions anti-bot when status is anti_bot", () => {
    const result: StockCheckResult = { ...availableResult, status: "anti_bot" };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/anti.bot/i);
  });

  it("returns proceed=false when status is login_required", () => {
    const result: StockCheckResult = { ...availableResult, status: "login_required" };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/login/i);
  });

  it("returns proceed=false when price exceeds maxPrice", () => {
    const result: StockCheckResult = { ...availableResult, price: 99 };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/exceed/i);
  });

  it("returns proceed=true when price is null (unknown price — allow confirmation)", () => {
    const result: StockCheckResult = { ...availableResult, price: null };
    const decision = shouldProceed(result, baseItem, false);
    expect(decision.proceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeBackoff
// ---------------------------------------------------------------------------

describe("computeBackoff", () => {
  it("returns shouldRetry=true with base delay on attempt 0", () => {
    const result = computeBackoff(0, 2_000, 30_000, 3);
    expect(result.shouldRetry).toBe(true);
    expect(result.delayMs).toBe(2_000); // 2000 * 2^0 = 2000
  });

  it("doubles the delay on attempt 1", () => {
    const result = computeBackoff(1, 2_000, 30_000, 3);
    expect(result.delayMs).toBe(4_000); // 2000 * 2^1 = 4000
  });

  it("caps delay at maxDelayMs when backoff would exceed it", () => {
    const result = computeBackoff(10, 2_000, 30_000, 20);
    expect(result.delayMs).toBe(30_000);
  });

  it("returns shouldRetry=false when attempt reaches maxAttempts", () => {
    const result = computeBackoff(3, 2_000, 30_000, 3);
    expect(result.shouldRetry).toBe(false);
  });

  it("includes a reason string", () => {
    const result = computeBackoff(1, 2_000, 30_000, 3);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeChallengeBackoff
// ---------------------------------------------------------------------------

describe("computeChallengeBackoff", () => {
  it("backs off (no give-up) on the first challenge with the base delay", () => {
    const result = computeChallengeBackoff(1, 30_000, 300_000, 6);
    expect(result.giveUp).toBe(false);
    expect(result.delayMs).toBe(30_000); // 30000 * 2^0
  });

  it("grows the backoff exponentially with each consecutive challenge", () => {
    expect(computeChallengeBackoff(2, 30_000, 300_000, 6).delayMs).toBe(60_000); // 2^1
    expect(computeChallengeBackoff(3, 30_000, 300_000, 6).delayMs).toBe(120_000); // 2^2
  });

  it("caps the backoff at maxDelayMs", () => {
    const result = computeChallengeBackoff(5, 30_000, 300_000, 10);
    expect(result.delayMs).toBe(300_000); // 30000 * 2^4 = 480000 → capped
  });

  it("trips the circuit breaker once the limit is reached", () => {
    const result = computeChallengeBackoff(6, 30_000, 300_000, 6);
    expect(result.giveUp).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it("keeps surviving while below the limit", () => {
    expect(computeChallengeBackoff(5, 30_000, 300_000, 6).giveUp).toBe(false);
  });

  it("includes a reason string", () => {
    const result = computeChallengeBackoff(1, 30_000, 300_000, 6);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extractProductId
// ---------------------------------------------------------------------------

describe("extractProductId", () => {
  it("extracts the id from a standard PDP url", () => {
    expect(extractProductId("https://www.lazada.sg/products/foo-i12345678.html")).toBe("12345678");
  });

  it("ignores query strings and fragments", () => {
    expect(
      extractProductId("https://www.lazada.sg/products/foo-i987.html?spm=a2o42.x&from=wishlist")
    ).toBe("987");
  });

  it("is case-insensitive on the -i marker", () => {
    expect(extractProductId("https://www.lazada.sg/products/foo-I555.html")).toBe("555");
  });

  it("extracts the id from the id-first + SKU url shape", () => {
    expect(extractProductId("https://www.lazada.sg/products/i13696744288-s124594658123.html")).toBe(
      "13696744288"
    );
  });

  it("handles the id-first shape with a trailing query string", () => {
    expect(extractProductId("https://www.lazada.sg/products/i13696744288-s124594658123.html?")).toBe(
      "13696744288"
    );
  });

  it("returns null when there is no id segment", () => {
    expect(extractProductId("https://www.lazada.sg/shop/pokemon")).toBeNull();
    expect(extractProductId("https://www.lazada.sg/products/foo.html")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRestockTransition
// ---------------------------------------------------------------------------

describe("isRestockTransition", () => {
  it("fires on out_of_stock → in_stock", () => {
    expect(isRestockTransition("out_of_stock", "in_stock")).toBe(true);
  });

  it("fires on first-ever in_stock (prev undefined)", () => {
    expect(isRestockTransition(undefined, "in_stock")).toBe(true);
  });

  it("does not fire when already in_stock", () => {
    expect(isRestockTransition("in_stock", "in_stock")).toBe(false);
  });

  it("does not fire on non-in_stock next states", () => {
    expect(isRestockTransition("in_stock", "out_of_stock")).toBe(false);
    expect(isRestockTransition("out_of_stock", "unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWishlistStock / classifyFromWishlistState
// ---------------------------------------------------------------------------

describe("parseWishlistStock", () => {
  // Mirrors Lazada's embedded shape: lightItemDetailDTO = all items,
  // outOfStock = the OOS subset. Title contains brackets to exercise the
  // string-aware array scanner ("[Limit 10 per person]").
  const html = `
    <script>window.data={"lightItemDetailDTO":[
      {"itemId":13638671361,"itemTitle":"Deck Case 9426143","skuList":[{"skuId":1}]},
      {"itemId":13718919969,"itemTitle":"Chaos Rising [Limit 10 per person]","skuList":[{"skuId":2}]}
    ],"outOfStock":[
      {"itemId":13718919969,"itemTitle":"Chaos Rising [Limit 10 per person]"}
    ]}</script>`;

  it("collects every item id into knownIds", () => {
    const state = parseWishlistStock(html);
    expect(state.knownIds.has("13638671361")).toBe(true);
    expect(state.knownIds.has("13718919969")).toBe(true);
    expect(state.knownIds.size).toBe(2);
  });

  it("collects only the out-of-stock subset into outOfStockIds", () => {
    const state = parseWishlistStock(html);
    expect(state.outOfStockIds.has("13718919969")).toBe(true);
    expect(state.outOfStockIds.has("13638671361")).toBe(false);
  });

  it("is not confused by brackets inside string values", () => {
    // If the scanner ignored strings it would stop at the "[" in the title and
    // miss the second item.
    expect(parseWishlistStock(html).knownIds.size).toBe(2);
  });

  it("returns empty sets when the payload markers are absent", () => {
    const state = parseWishlistStock("<html><body>nothing here</body></html>");
    expect(state.knownIds.size).toBe(0);
    expect(state.outOfStockIds.size).toBe(0);
  });

  it("classifies items against the parsed state", () => {
    const state = parseWishlistStock(html);
    expect(classifyFromWishlistState("13638671361", state)).toBe("in_stock");
    expect(classifyFromWishlistState("13718919969", state)).toBe("out_of_stock");
    expect(classifyFromWishlistState("99999999999", state)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// isAntiBot
// ---------------------------------------------------------------------------

describe("isAntiBot", () => {
  it("returns true for anti_bot status", () => {
    expect(isAntiBot("anti_bot")).toBe(true);
  });

  it("returns false for all other statuses", () => {
    const nonBotStatuses = ["in_stock", "out_of_stock", "unknown", "login_required"] as const;
    for (const status of nonBotStatuses) {
      expect(isAntiBot(status)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// formatOrderSummary
// ---------------------------------------------------------------------------

describe("formatOrderSummary", () => {
  it("includes the item name", () => {
    const output = formatOrderSummary(orderSummary);
    expect(output).toContain(orderSummary.itemName);
  });

  it("includes the estimated total", () => {
    const output = formatOrderSummary(orderSummary);
    expect(output).toContain("79.80");
  });

  it("includes the delivery address", () => {
    const output = formatOrderSummary(orderSummary);
    expect(output).toContain(orderSummary.deliveryAddress);
  });

  it("includes CONFIRM instruction", () => {
    const output = formatOrderSummary(orderSummary);
    expect(output.toUpperCase()).toContain("CONFIRM");
  });

  it("returns a multi-line string", () => {
    const output = formatOrderSummary(orderSummary);
    expect(output.split("\n").length).toBeGreaterThan(5);
  });

  it("shows fallback text when price is null", () => {
    const output = formatOrderSummary({ ...orderSummary, price: null });
    expect(output).toContain("price not detected");
    const priceLine = output.split("\n").find((l) => l.includes("Unit Price"));
    expect(priceLine).not.toContain("S$");
  });

  it("shows fallback text when estimatedTotal is null", () => {
    const output = formatOrderSummary({ ...orderSummary, estimatedTotal: null });
    expect(output).toContain("total not detected");
  });

  it("formats price with two decimal places when present", () => {
    const output = formatOrderSummary({ ...orderSummary, price: 39.9 });
    expect(output).toContain("S$39.90");
  });

  it("formats estimatedTotal with two decimal places when present", () => {
    const output = formatOrderSummary({ ...orderSummary, estimatedTotal: 79.8 });
    expect(output).toContain("S$79.80");
  });
});
