import { describe, it, expect } from "vitest";
import {
  isPriceAcceptable,
  shouldProceed,
  computeBackoff,
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
