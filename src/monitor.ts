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

  // Adaptive settle: proceed as soon as the price anchor renders (or any
  // product anchor), capped at settleMs. This replaces a blind fixed wait so a
  // fast-rendering page is evaluated in a few hundred ms instead of always
  // burning the full settle — the difference that lets the poll cadence sit
  // under the ~3s restock window.
  await waitForProductReady(page, settleMs);

  const pageTitle = await page.title().catch(() => null);

  // Challenge detection takes priority over everything else
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

  const price = await extractPrice(page, item.name, logger);
  const status = await determineStatus(page, item.name, logger, price);

  logger.info(MODULE, "stock_check", {
    item: item.name,
    status,
    price,
  });

  return { ...base, status, price, pageTitle };
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
 * Waits until the product page has rendered enough to evaluate, bounded by
 * `settleMs`. Returns as soon as the price anchor becomes visible; falls
 * through (no throw) on timeout so `determineStatus` still runs on whatever
 * did render. `settleMs <= 0` skips waiting entirely (fastest, riskiest).
 */
async function waitForProductReady(page: Page, settleMs: number): Promise<void> {
  if (settleMs <= 0) return;
  // price candidates are plain CSS — safe to union into one locator.
  const anchor = SELECTORS.product.price.candidates.join(", ");
  await page
    .locator(anchor)
    .first()
    .waitFor({ state: "visible", timeout: settleMs })
    .catch(() => {
      /* not rendered within settleMs — proceed and let determineStatus decide */
    });
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

async function determineStatus(
  page: Page,
  itemName: string,
  logger: Logger,
  price: number | null
): Promise<StockCheckResult["status"]> {
  // Explicit OOS markers take highest precedence
  const oos = await resolveSelector(page, SELECTORS.product.outOfStockIndicator, 2_000).catch(
    () => null
  );
  if (oos) {
    logger.debug(MODULE, "oos_indicator_found", { itemName, selector: oos.selector });
    return "out_of_stock";
  }

  // Enabled buy button = in stock
  const buyNow = await resolveSelector(page, SELECTORS.product.buyNowButton, 2_000).catch(
    () => null
  );
  if (buyNow) {
    const enabled = await page.locator(buyNow.selector).first().isEnabled().catch(() => false);
    if (enabled) return "in_stock";
  }

  const addToCart = await resolveSelector(page, SELECTORS.product.addToCartButton, 2_000).catch(
    () => null
  );
  if (addToCart) {
    const enabled = await page.locator(addToCart.selector).first().isEnabled().catch(() => false);
    if (enabled) return "in_stock";
  }

  // Price present means the product page loaded correctly — no buy path means out of stock.
  // Return "unknown" only when the page state is genuinely indeterminate (navigation error,
  // challenge page, or completely unexpected DOM where even the price is absent).
  if (price !== null) {
    logger.debug(MODULE, "oos_inferred_no_buy_button", { itemName });
    return "out_of_stock";
  }

  return "unknown";
}

export async function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms && !signal.aborted) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}
