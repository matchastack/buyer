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
import { Item, StockCheckResult } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS } from "./selectors";
import { resolveSelector } from "./selectors";
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

  // Brief pause for dynamic JS content to settle
  await page.waitForTimeout(1_500);

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
  const status = await determineStatus(page, item.name, logger);

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
  debugSnapshots = false,
  debugDir?: string
): Promise<StockCheckResult> {
  logger.info(MODULE, "monitoring_started", {
    item: item.name,
    intervalMs,
    maxPrice: item.maxPrice,
  });

  // Resolve debug dir once — derived from the caller-supplied path or cwd
  const resolvedDebugDir = debugSnapshots
    ? (debugDir ?? path.join(process.cwd(), "data", "debug"))
    : undefined;

  while (!signal.aborted) {
    const result = await checkStock(page, item, rateLimiter, logger, resolvedDebugDir);

    if (result.status === "anti_bot") {
      logger.error(MODULE, "monitoring_halted_anti_bot", { item: item.name });
      return result; // caller inspects status and handles accordingly
    }

    if (result.status === "login_required") {
      logger.error(MODULE, "monitoring_halted_login_expired", { item: item.name });
      return result;
    }

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
  logger: Logger
): Promise<StockCheckResult["status"]> {
  // Out-of-stock markers take precedence
  const oos = await resolveSelector(page, SELECTORS.product.outOfStockIndicator, 2_000).catch(
    () => null
  );
  if (oos) {
    logger.debug(MODULE, "oos_indicator_found", { itemName, selector: oos.selector });
    return "out_of_stock";
  }

  // Buy Now is the strongest positive signal — only count it if it is enabled
  // (on out-of-stock pages Lazada often keeps the button visible but disabled)
  const buyNow = await resolveSelector(page, SELECTORS.product.buyNowButton, 2_000).catch(
    () => null
  );
  if (buyNow) {
    const enabled = await page.locator(buyNow.selector).first().isEnabled().catch(() => false);
    if (enabled) return "in_stock";
  }

  // Add to Cart is also a positive signal — same disabled guard
  const addToCart = await resolveSelector(page, SELECTORS.product.addToCartButton, 2_000).catch(
    () => null
  );
  if (addToCart) {
    const enabled = await page.locator(addToCart.selector).first().isEnabled().catch(() => false);
    if (enabled) return "in_stock";
  }

  return "unknown";
}

async function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms && !signal.aborted) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}
