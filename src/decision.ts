/**
 * Decision engine — pure functions only.
 *
 * No I/O, no Playwright, no fs, no console.
 * All functions are deterministic given their inputs.
 * This makes them trivially unit-testable.
 */

import { StockCheckResult, Item, OrderSummary, StockStatus } from "./types";

// ---------------------------------------------------------------------------
// Price logic
// ---------------------------------------------------------------------------

export function isPriceAcceptable(
  price: number | null,
  maxPrice: number
): boolean {
  // A null price means we couldn't read it — allow the flow to continue
  // so a human can confirm at the approval gate rather than silently skip.
  if (price === null) return true;
  return price <= maxPrice;
}

// ---------------------------------------------------------------------------
// Proceed / skip logic
// ---------------------------------------------------------------------------

export type ProceedDecision =
  | { proceed: true }
  | { proceed: false; reason: string };

export function shouldProceed(
  result: StockCheckResult,
  item: Item,
  dryRun: boolean
): ProceedDecision {
  if (result.status === "anti_bot") {
    return { proceed: false, reason: "Anti-bot challenge detected — halting" };
  }
  if (result.status === "login_required") {
    return { proceed: false, reason: "Session expired — re-login required" };
  }
  if (result.status !== "in_stock") {
    return { proceed: false, reason: `Item not available (status: ${result.status})` };
  }
  if (!isPriceAcceptable(result.price, item.maxPrice)) {
    return {
      proceed: false,
      reason: `Price $${result.price} exceeds max $${item.maxPrice}`,
    };
  }
  if (dryRun) {
    return { proceed: false, reason: "Dry-run mode — purchase skipped" };
  }
  return { proceed: true };
}

// ---------------------------------------------------------------------------
// Retry / backoff
// ---------------------------------------------------------------------------

export interface BackoffResult {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
}

export function computeBackoff(
  attempt: number,           // 0-indexed: 0 = first retry
  baseDelayMs: number,
  maxDelayMs: number,
  maxAttempts: number
): BackoffResult {
  if (attempt >= maxAttempts) {
    return { shouldRetry: false, delayMs: 0, reason: `Max attempts (${maxAttempts}) reached` };
  }
  const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  return {
    shouldRetry: true,
    delayMs,
    reason: `Retry ${attempt + 1}/${maxAttempts} after ${delayMs}ms`,
  };
}

// ---------------------------------------------------------------------------
// Anti-bot detection helper
// ---------------------------------------------------------------------------

export function isAntiBot(status: StockStatus): boolean {
  return status === "anti_bot";
}

// ---------------------------------------------------------------------------
// Order summary formatter (for terminal display)
// ---------------------------------------------------------------------------

export function formatOrderSummary(summary: OrderSummary): string {
  const divider = "─".repeat(50);
  const lines = [
    "",
    divider,
    "  ORDER SUMMARY — REVIEW BEFORE CONFIRMING",
    divider,
    `  Item          : ${summary.itemName}`,
    `  URL           : ${summary.itemUrl}`,
    `  Unit Price    : S$${summary.price.toFixed(2)}`,
    `  Quantity      : ${summary.quantity}`,
    `  Estimated Total: S$${summary.estimatedTotal.toFixed(2)}`,
    `  Ship To       : ${summary.deliveryAddress}`,
    `  Payment       : ${summary.paymentMethod}`,
    divider,
    "  Type CONFIRM to place this order, or press Ctrl+C to abort.",
    divider,
    "",
  ];
  return lines.join("\n");
}
