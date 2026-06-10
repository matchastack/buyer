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
// Product-id extraction & restock transition (wishlist mode)
// ---------------------------------------------------------------------------

/**
 * Extracts the Lazada product id from a PDP or wishlist link. Handles both URL
 * shapes Lazada uses:
 *   - id at the end of the slug:   ".../foo-i12345678.html"         → "12345678"
 *   - id-first with a SKU suffix:  ".../i13696744288-s9988.html"    → "13696744288"
 * The id is always the digits after the `i` marker (preceded by `/` or `-`),
 * optionally followed by a `-s<sku>` segment, then `.html`. Returns null when no
 * id segment is present.
 */
export function extractProductId(url: string): string | null {
  const match = url.match(/[/-]i(\d+)(?:-s\d+)?\.html/i);
  return match ? match[1]! : null;
}

/**
 * Pure edge-trigger rule: did this item just become buyable?
 * True only on a transition into in_stock from any other (or unseen) state, so
 * a still-in-stock item is not re-fired on every wishlist poll.
 */
export function isRestockTransition(
  prev: StockStatus | undefined,
  next: StockStatus
): boolean {
  return next === "in_stock" && prev !== "in_stock";
}

// ---------------------------------------------------------------------------
// Wishlist stock parsing (from Lazada's server-embedded JSON)
// ---------------------------------------------------------------------------

export interface WishlistStockState {
  knownIds: Set<string>;       // every itemId present on the wishlist
  outOfStockIds: Set<string>;  // the subset Lazada flags out of stock
}

/**
 * Extracts the balanced JSON array that follows `"<key>":` in `text`, respecting
 * strings/escapes so brackets inside values (e.g. "[Limit 10 per person]") don't
 * confuse the scan. Returns the raw `[...]` substring, or null if not found.
 */
function extractJsonArray(text: string, key: string): string | null {
  const marker = `"${key}":`;
  const at = text.indexOf(marker);
  if (at < 0) return null;

  let i = at + marker.length;
  while (i < text.length && text[i] !== "[") i++;
  if (i >= text.length) return null;

  const begin = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(begin, i + 1);
    }
  }
  return null;
}

/** Collects every `"itemId":<digits>` inside an extracted array fragment. */
function itemIdsIn(arrayFragment: string | null): string[] {
  if (!arrayFragment) return [];
  return [...arrayFragment.matchAll(/"itemId":(\d+)/g)].map((m) => m[1]!);
}

/**
 * Parses the wishlist page HTML into a stock-state view using Lazada's embedded
 * JSON: `lightItemDetailDTO` lists every wishlist item, `outOfStock` lists the
 * out-of-stock subset. Robust to UI/CSS changes since it reads the same data the
 * page renders from. `knownIds` is empty when the JSON markers are absent (the
 * caller treats that as "no data this poll").
 */
export function parseWishlistStock(html: string): WishlistStockState {
  const allIds = itemIdsIn(extractJsonArray(html, "lightItemDetailDTO"));
  const oosIds = itemIdsIn(extractJsonArray(html, "outOfStock"));
  return {
    knownIds: new Set([...allIds, ...oosIds]),
    outOfStockIds: new Set(oosIds),
  };
}

/**
 * Classifies one item against a parsed wishlist state. Not present on the
 * wishlist ⇒ "unknown" (never fires a buy); present and flagged ⇒ "out_of_stock";
 * present and not flagged ⇒ "in_stock".
 */
export function classifyFromWishlistState(
  productId: string,
  state: WishlistStockState
): StockStatus {
  if (!state.knownIds.has(productId)) return "unknown";
  return state.outOfStockIds.has(productId) ? "out_of_stock" : "in_stock";
}

// ---------------------------------------------------------------------------
// Challenge-survival backoff
// ---------------------------------------------------------------------------

export interface ChallengeBackoffResult {
  giveUp: boolean;  // true ⇒ circuit breaker tripped, stop monitoring
  delayMs: number;  // how long to wait before the next check (0 when giving up)
  reason: string;
}

/**
 * Decides whether to keep monitoring after an anti-bot challenge and, if so,
 * how long to back off. `consecutiveChallenges` is 1-indexed: 1 = the first
 * challenge in the current streak (a successful check resets the streak).
 * Backoff grows exponentially from the first challenge and is capped.
 */
export function computeChallengeBackoff(
  consecutiveChallenges: number,
  baseDelayMs: number,
  maxDelayMs: number,
  maxConsecutive: number
): ChallengeBackoffResult {
  if (consecutiveChallenges >= maxConsecutive) {
    return {
      giveUp: true,
      delayMs: 0,
      reason: `Circuit breaker: ${consecutiveChallenges} consecutive challenge(s) reached limit of ${maxConsecutive}`,
    };
  }
  const delayMs = Math.min(baseDelayMs * Math.pow(2, consecutiveChallenges - 1), maxDelayMs);
  return {
    giveUp: false,
    delayMs,
    reason: `Challenge ${consecutiveChallenges}/${maxConsecutive} — backing off ${delayMs}ms then resuming`,
  };
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
    `  Unit Price    : ${summary.price !== null ? `S$${summary.price.toFixed(2)}` : "(price not detected — verify in browser)"}`,
    `  Quantity      : ${summary.quantity}`,
    `  Estimated Total: ${summary.estimatedTotal !== null ? `S$${summary.estimatedTotal.toFixed(2)}` : "(total not detected — verify in browser)"}`,
    `  Ship To       : ${summary.deliveryAddress}`,
    `  Payment       : ${summary.paymentMethod}`,
    divider,
    "  Type CONFIRM to place this order, or press Ctrl+C to abort.",
    divider,
    "",
  ];
  return lines.join("\n");
}
