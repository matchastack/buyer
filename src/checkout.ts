/**
 * Checkout orchestrator.
 *
 * Flow per attempt:
 *   1. Navigate to product page → click Buy Now (no Add to Cart fallback)
 *   2. Wait for checkout page
 *   3. Select PayNow
 *   4. Click Place Order
 *   5. Wait for confirmation (Lazada sends a PayNow QR — user scans to complete payment)
 *
 * Anti-bot challenges halt checkout immediately.
 * Dry-run guard is the FIRST check — aborts before any page navigation.
 */

import { Page } from "playwright";
import { Item, Config, CheckoutResult, RetryProfile } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS, resolveSelector } from "./selectors";
import { detectChallenge, ChallengeDetectedError } from "./auth";
import { navigateTo, clickElement, isVisible, extractText, waitForUrl } from "./browser-actions";
import { PhaseTimer } from "./timing";

const MODULE = "checkout";
const LAZADA_DOMAIN = "www.lazada.sg";
const PAYMENT_METHOD = "paynow";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function checkout(
  page: Page,
  item: Item,
  config: Config,
  rateLimiter: RateLimiter,
  logger: Logger,
  alreadyOnProductPage = false,
  retry?: RetryProfile
): Promise<CheckoutResult> {
  // ── Dry-run guard — must be first ──────────────────────────────────────────
  if (config.settings.dryRun) {
    logger.info(MODULE, "dry_run_skip", { item: item.name });
    return { success: false, orderNumber: null, error: "dry-run mode" };
  }

  // Default to the per-item retry profile so existing callers are unchanged;
  // wishlist buyers pass a fast profile to keep retries inside the drop window.
  const profile: RetryProfile = retry ?? {
    maxRetries: config.settings.maxRetries,
    baseMs: config.settings.retryBackoffBaseMs,
    maxMs: config.settings.retryBackoffMaxMs,
  };

  logger.info(MODULE, "checkout_start", { item: item.name, fastPath: alreadyOnProductPage });

  for (let attempt = 1; attempt <= profile.maxRetries; attempt++) {
    // Only the very first attempt can act on the live in-stock page. Any retry
    // means the previous attempt navigated away, so it must reload (and pace).
    const skipInitialNav = alreadyOnProductPage && attempt === 1;
    const result = await attemptCheckout(page, item, config, rateLimiter, logger, attempt, skipInitialNav);

    if (result.success) return result;

    if (attempt < profile.maxRetries) {
      const backoffMs = Math.min(
        profile.baseMs * Math.pow(2, attempt - 1),
        profile.maxMs
      );
      logger.warn(MODULE, "retry_backoff", { item: item.name, attempt, backoffMs });
      await sleep(backoffMs);
    }
  }

  return {
    success: false,
    orderNumber: null,
    error: `Failed after ${profile.maxRetries} attempt(s)`,
  };
}

// ---------------------------------------------------------------------------
// Single checkout attempt
// ---------------------------------------------------------------------------

async function attemptCheckout(
  page: Page,
  item: Item,
  config: Config,
  rateLimiter: RateLimiter,
  logger: Logger,
  attempt: number,
  skipInitialNav: boolean
): Promise<CheckoutResult> {
  const timer = new PhaseTimer();
  try {
    // Fast path: the page is already on the in-stock product page (just seen by
    // the monitor). Skip the rate-limit wait and re-navigation — every second
    // here is a second the item can sell out. The QR/Place-Order flow still runs.
    if (skipInitialNav) {
      logger.info(MODULE, "fast_path_using_live_page", { item: item.name });
    } else {
      await rateLimiter.acquire(LAZADA_DOMAIN);
      await navigateTo(page, item.url, logger);
    }
    timer.mark("nav");

    const challenge = await detectChallenge(page, logger);
    if (challenge) throw new ChallengeDetectedError(challenge);

    if (item.quantity > 1) {
      await setQuantity(page, item.quantity, logger);
    }

    // Buy Now only — no Add to Cart fallback
    const buyNowVisible = await isVisible(page, SELECTORS.product.buyNowButton, logger, 3_000);
    timer.mark("locate_buy_now");
    if (!buyNowVisible) {
      logger.warn(MODULE, "buy_now_unavailable", { item: item.name, attempt });
      logger.info(MODULE, "checkout_timing", {
        item: item.name,
        attempt,
        success: false,
        ...timer.summary(),
      });
      return { success: false, orderNumber: null, error: "Buy Now button not found" };
    }

    await clickElement(page, SELECTORS.product.buyNowButton, logger);
    logger.info(MODULE, "clicked_buy_now", { item: item.name, attempt });

    await waitForUrl(
      page,
      (url) => url.pathname.includes("/checkout"),
      15_000,
      logger
    );
    timer.mark("buy_now_to_checkout");

    logger.info(MODULE, "on_checkout_page", { item: item.name });

    await selectPaymentMethod(page, logger);
    timer.mark("select_payment");

    // Place order — Lazada will display a PayNow QR for the user to scan
    await clickElement(page, SELECTORS.checkout.placeOrderButton, logger);
    logger.info(MODULE, "place_order_clicked", { item: item.name });

    const result = await waitForConfirmation(page, item.name, logger);
    timer.mark("place_order_to_confirm");
    logger.info(MODULE, "checkout_timing", {
      item: item.name,
      attempt,
      success: result.success,
      ...timer.summary(),
    });
    return result;
  } catch (err) {
    if (err instanceof ChallengeDetectedError) {
      logger.error(MODULE, "anti_bot_challenge_during_checkout", {
        item: item.name,
        attempt,
        type: err.challenge.type,
      });
      throw err; // Propagate — caller (index.ts) initiates shutdown
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(MODULE, "checkout_attempt_failed", { item: item.name, attempt, error: errMsg });
    return { success: false, orderNumber: null, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function setQuantity(page: Page, quantity: number, logger: Logger): Promise<void> {
  const resolved = await resolveSelector(page, SELECTORS.product.quantityInput, 3_000);
  if (!resolved) {
    logger.warn(MODULE, "quantity_input_not_found");
    return;
  }
  const locator = page.locator(resolved.selector).first();
  await locator.click({ clickCount: 3 });
  await locator.fill(String(quantity));
  logger.debug(MODULE, "quantity_set", { quantity });
}

async function selectPaymentMethod(page: Page, logger: Logger): Promise<void> {
  for (const candidate of SELECTORS.checkout.paymentMethodOption.candidates) {
    const options = page.locator(candidate);
    const count = await options.count().catch(() => 0);
    if (count === 0) continue;

    for (let i = 0; i < count; i++) {
      const option = options.nth(i);
      const text = ((await option.textContent().catch(() => "")) ?? "").toLowerCase();

      if (text.includes("paynow")) {
        await option.click().catch(() => {});
        logger.info(MODULE, "payment_method_selected", { paymentMethod: PAYMENT_METHOD });
        await page.waitForTimeout(1_000);
        return;
      }
    }
    break; // found elements with this candidate but no PayNow match
  }

  logger.warn(MODULE, "paynow_option_not_found");
}

async function waitForConfirmation(
  page: Page,
  itemName: string,
  logger: Logger
): Promise<CheckoutResult> {
  const resolved = await resolveSelector(page, SELECTORS.confirmation.successHeading, 20_000).catch(
    () => null
  );

  if (resolved !== null) {
    const orderNumberText = await extractText(page, SELECTORS.confirmation.orderNumber, logger);
    const orderNumber = orderNumberText?.trim().replace(/[^A-Za-z0-9-]/g, "") ?? null;

    logger.info(MODULE, "order_confirmed", { item: itemName, orderNumber });
    return { success: true, orderNumber, error: null };
  }

  if (page.url().includes("/checkout")) {
    const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
    if (
      bodyText.toLowerCase().includes("failed") ||
      bodyText.toLowerCase().includes("error") ||
      bodyText.toLowerCase().includes("declined")
    ) {
      const error = "Payment failed or was declined — check your PayNow setup.";
      logger.error(MODULE, "payment_failed", { item: itemName });
      return { success: false, orderNumber: null, error };
    }
  }

  const error = "Order confirmation not detected — verify order status on Lazada manually.";
  logger.error(MODULE, "confirmation_not_detected", { item: itemName, url: page.url() });
  return { success: false, orderNumber: null, error };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
