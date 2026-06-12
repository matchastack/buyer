/**
 * Stock monitor.
 *
 * Polls a product page on a configured interval.
 * Applies rate limiting before every page load.
 * Returns typed StockCheckResult — never throws on page errors,
 * instead returns status "unknown" so the caller can decide to retry.
 * Halts (returns "anti_bot") if a bot challenge is detected.
 */

import * as path from "path";
import { Page } from "playwright";
import { Item, StockCheckResult, ChallengeSurvivalOptions } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS } from "./selectors";
import { resolveSelector } from "./selectors";
import { computeChallengeBackoff } from "./decision";
import { detectChallenge } from "./auth";
import { navigateTo } from "./browser-actions";
import { captureDomSnapshot, describeProductSelectors } from "./diagnostics";

const MODULE = "monitor";
const LAZADA_DOMAIN = "www.lazada.sg";

// ---------------------------------------------------------------------------
// Single stock check
// ---------------------------------------------------------------------------

export async function checkStock(
  page: Page,
  item: Item,
  rateLimiter: RateLimiter,
  logger: Logger,
  settleMs: number,
  debugDir?: string
): Promise<StockCheckResult> {
  const timestamp = new Date().toISOString();
  const base: Omit<StockCheckResult, "status" | "price" | "pageTitle"> = {
    itemName: item.name,
    url: item.url,
    timestamp,
  };

  // Enforce rate limit before every page load
  await rateLimiter.acquire(LAZADA_DOMAIN);

  try {
    await navigateTo(page, item.url, logger);
  } catch (err) {
    logger.warn(MODULE, "navigation_failed", {
      item: item.name,
      error: (err as Error).message,
    });
    return { ...base, status: "unknown", price: null, pageTitle: null };
  }

  // Speed-first detection: the ONLY thing that decides a buy is an enabled Buy
  // Now button. Wait for it (bounded by settleMs) and fire the instant it is
  // clickable — skip price, exact OOS reason, and even the challenge check on
  // the hot path. Those are deliberately ignored here because checkout's
  // fail-closed PayNow guardrail is the real safety net, and every extra read
  // before the click risks losing the sub-2s restock window. The wait also
  // returns early on a definitive out-of-stock marker, so an OOS poll doesn't
  // burn the full settle.
  const signal = await waitForBuySignal(page, settleMs);

  if (signal === "in_stock") {
    logger.info(MODULE, "stock_check", { item: item.name, status: "in_stock", price: null });
    return { ...base, status: "in_stock", price: null, pageTitle: null };
  }

  // Not buyable this pass. Off the hot path now, classify *why* so survival
  // backoff (anti-bot) and worker halt (login) still work.
  const pageTitle = await page.title().catch(() => null);

  const challenge = await detectChallenge(page, logger);
  if (challenge) {
    logger.error(MODULE, "anti_bot_halting", {
      item: item.name,
      challengeType: challenge.type,
      url: challenge.url,
    });
    return { ...base, status: "anti_bot", price: null, pageTitle };
  }

  // Check for login-required state (e.g. session expired mid-run)
  if (page.url().includes("/login")) {
    logger.warn(MODULE, "login_required", { item: item.name });
    return { ...base, status: "login_required", price: null, pageTitle };
  }

  // Diagnostics — only when debug mode is active
  if (debugDir) {
    await captureDomSnapshot(page, item, debugDir, logger);
    await describeProductSelectors(page, logger);
  }

  // Best-effort price read for the audit log only — it does NOT affect status.
  const price = await extractPrice(page, item.name, logger);
  logger.info(MODULE, "stock_check", { item: item.name, status: "out_of_stock", price });
  return { ...base, status: "out_of_stock", price, pageTitle };
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

export async function waitForStock(
  page: Page,
  item: Item,
  intervalMs: number,
  rateLimiter: RateLimiter,
  logger: Logger,
  signal: AbortSignal,
  survival: ChallengeSurvivalOptions,
  settleMs: number,
  debugSnapshots = false,
  debugDir?: string
): Promise<StockCheckResult> {
  logger.info(MODULE, "monitoring_started", {
    item: item.name,
    intervalMs,
    settleMs,
    maxPrice: item.maxPrice,
    surviveChallenges: survival.surviveChallenges,
  });

  // Resolve debug dir once — derived from the caller-supplied path or cwd
  const resolvedDebugDir = debugSnapshots
    ? (debugDir ?? path.join(process.cwd(), "data", "debug"))
    : undefined;

  // Tracks the current run of back-to-back challenges; reset by any good check.
  let consecutiveChallenges = 0;

  while (!signal.aborted) {
    const result = await checkStock(page, item, rateLimiter, logger, settleMs, resolvedDebugDir);

    if (result.status === "anti_bot") {
      // Fail-closed (legacy) behaviour: hand control back to the caller.
      if (!survival.surviveChallenges) {
        logger.error(MODULE, "monitoring_halted_anti_bot", { item: item.name });
        return result;
      }

      // Survival mode: back off and resume so a single challenge does not end
      // the 2-hour watch. A circuit breaker stops an endless hammering loop.
      consecutiveChallenges++;
      const backoff = computeChallengeBackoff(
        consecutiveChallenges,
        survival.challengeBackoffBaseMs,
        survival.challengeBackoffMaxMs,
        survival.maxConsecutiveChallenges
      );

      if (backoff.giveUp) {
        logger.error(MODULE, "monitoring_halted_anti_bot_circuit_breaker", {
          item: item.name,
          consecutiveChallenges,
          reason: backoff.reason,
        });
        return result;
      }

      logger.warn(MODULE, "anti_bot_backoff_resume", {
        item: item.name,
        consecutiveChallenges,
        backoffMs: backoff.delayMs,
      });
      await interruptibleSleep(backoff.delayMs, signal);
      continue;
    }

    if (result.status === "login_required") {
      logger.error(MODULE, "monitoring_halted_login_expired", { item: item.name });
      return result;
    }

    // A clean check ends any challenge streak.
    consecutiveChallenges = 0;

    if (result.status === "in_stock") {
      logger.info(MODULE, "item_available", { item: item.name, price: result.price });
      return result;
    }

    logger.debug(MODULE, "not_available_sleeping", {
      item: item.name,
      status: result.status,
      nextCheckMs: intervalMs,
    });

    // Interruptible sleep: check signal every 500ms
    await interruptibleSleep(intervalMs, signal);
  }

  logger.info(MODULE, "monitoring_aborted", { item: item.name });
  return {
    status: "unknown",
    price: null,
    itemName: item.name,
    pageTitle: null,
    url: item.url,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * One instant classification pass over the buy controls:
 *   - an enabled Buy Now button → "in_stock"
 *   - an explicit out-of-stock marker (incl. a disabled Buy Now) → "out_of_stock"
 *   - neither resolved yet (page may still be hydrating) → null
 * Pure read, no waiting — `waitForBuySignal` re-runs it until one side resolves.
 */
async function classifyBuySignal(
  page: Page
): Promise<"in_stock" | "out_of_stock" | null> {
  const buyNow = await resolveSelector(page, SELECTORS.product.buyNowButton).catch(() => null);
  if (buyNow) {
    const enabled = await page.locator(buyNow.selector).first().isEnabled().catch(() => false);
    if (enabled) return "in_stock";
  }

  const oos = await resolveSelector(page, SELECTORS.product.outOfStockIndicator).catch(() => null);
  if (oos) return "out_of_stock";

  return null;
}

/**
 * Waits for a buy decision, bounded by `settleMs`. Returns the instant an
 * enabled Buy Now button appears ("in_stock") or a definitive out-of-stock
 * marker appears ("out_of_stock"), so neither a fast restock nor a clear OOS
 * page pays the full settle. If neither resolves before the deadline (slow
 * hydration, blank, or challenge page), returns "out_of_stock" — the caller
 * then runs challenge/login detection to reclassify. `settleMs <= 0` does a
 * single instant pass.
 */
async function waitForBuySignal(
  page: Page,
  settleMs: number
): Promise<"in_stock" | "out_of_stock"> {
  const deadline = Date.now() + Math.max(0, settleMs);

  for (;;) {
    const signal = await classifyBuySignal(page);
    if (signal) return signal;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return "out_of_stock";
    await new Promise((r) => setTimeout(r, Math.min(150, remaining)));
  }
}

async function extractPrice(
  page: Page,
  itemName: string,
  logger: Logger
): Promise<number | null> {
  const resolved = await resolveSelector(page, SELECTORS.product.price, 3_000).catch(
    () => null
  );
  if (!resolved) return null;

  const text = await page
    .locator(resolved.selector)
    .first()
    .textContent()
    .catch(() => null);

  if (!text) return null;

  // Match numeric price like "39.90", "1,299.00"
  const match = text.match(/[\d,]+\.?\d*/);
  if (!match) return null;

  const price = parseFloat(match[0].replace(",", ""));
  logger.debug(MODULE, "price_extracted", { itemName, rawText: text.trim(), price });
  return isNaN(price) ? null : price;
}

export async function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms && !signal.aborted) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}
