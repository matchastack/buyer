/**
 * Checkout orchestrator.
 *
 * Composes browser-actions, selectors, payment-approval, and decision
 * to execute a single checkout attempt.
 *
 * Safety guarantees:
 *  - Dry-run guard is the FIRST check — aborts before any page navigation.
 *  - OrderSummary is built from live page data, not config values.
 *  - User must type "CONFIRM" before Place Order is clicked.
 *  - Anti-bot challenges halt checkout immediately.
 */

import { Page } from "playwright";
import { Item, Config, OrderSummary, CheckoutResult } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS } from "./selectors";
import { resolveSelector } from "./selectors";
import { detectChallenge, ChallengeDetectedError } from "./auth";
import { navigateTo, clickElement, isVisible, extractText, waitForUrl } from "./browser-actions";
import { requestApproval, ApprovalRejectedError, ApprovalTimeoutError } from "./payment-approval";

const MODULE = "checkout";
const LAZADA_DOMAIN = "www.lazada.sg";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function checkout(
  page: Page,
  item: Item,
  config: Config,
  rateLimiter: RateLimiter,
  logger: Logger
): Promise<CheckoutResult> {
  // ── Dry-run guard — must be first ──────────────────────────────────────────
  if (config.settings.dryRun) {
    logger.info(MODULE, "dry_run_skip", { item: item.name });
    return { success: false, orderNumber: null, error: "dry-run mode" };
  }

  logger.info(MODULE, "checkout_start", { item: item.name });

  for (let attempt = 1; attempt <= config.settings.maxRetries; attempt++) {
    const result = await attemptCheckout(page, item, config, rateLimiter, logger, attempt);

    if (result.success || result.error === "approval_rejected" || result.error === "approval_timeout") {
      return result; // Don't retry if user explicitly rejected or timed out
    }

    if (attempt < config.settings.maxRetries) {
      const backoffMs = Math.min(
        config.settings.retryBackoffBaseMs * Math.pow(2, attempt - 1),
        config.settings.retryBackoffMaxMs
      );
      logger.warn(MODULE, "retry_backoff", { item: item.name, attempt, backoffMs });
      await sleep(backoffMs);
    }
  }

  return {
    success: false,
    orderNumber: null,
    error: `Failed after ${config.settings.maxRetries} attempt(s)`,
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
  attempt: number
): Promise<CheckoutResult> {
  try {
    await rateLimiter.acquire(LAZADA_DOMAIN);
    await navigateTo(page, item.url, logger);

    const challenge = await detectChallenge(page, logger);
    if (challenge) throw new ChallengeDetectedError(challenge);

    // Set quantity if > 1
    if (item.quantity > 1) {
      await setQuantity(page, item.quantity, logger);
    }

    // Prefer "Buy Now" (skips cart, faster checkout)
    const buyNowVisible = await isVisible(page, SELECTORS.product.buyNowButton, logger, 3_000);

    if (buyNowVisible) {
      await clickElement(page, SELECTORS.product.buyNowButton, logger);
      logger.info(MODULE, "clicked_buy_now", { item: item.name, attempt });
    } else {
      await clickElement(page, SELECTORS.product.addToCartButton, logger);
      logger.info(MODULE, "clicked_add_to_cart", { item: item.name, attempt });
      await navigateFromCartToCheckout(page, rateLimiter, logger);
    }

    // Wait for checkout page URL
    await waitForUrl(
      page,
      (url) => url.pathname.includes("/checkout") || url.pathname.includes("/cart"),
      15_000,
      logger
    );

    if (page.url().includes("/cart")) {
      await navigateFromCartToCheckout(page, rateLimiter, logger);
    }

    logger.info(MODULE, "on_checkout_page", { item: item.name });

    // Select payment method
    await selectPaymentMethod(page, config.settings.paymentMethod, logger);

    // Build OrderSummary from live page data
    const summary = await buildOrderSummary(page, item, logger);

    // ── User confirmation gate ─────────────────────────────────────────────
    await requestApproval(summary, logger, config.settings);
    // ── Only executes if user approves (CONFIRM via stdin, or Approve via Telegram) ─

    await clickElement(page, SELECTORS.checkout.placeOrderButton, logger);
    logger.info(MODULE, "place_order_clicked", { item: item.name });

    return await waitForConfirmation(page, item.name, logger);
  } catch (err) {
    if (err instanceof ApprovalRejectedError) {
      logger.warn(MODULE, "purchase_rejected_by_user", { item: item.name });
      return { success: false, orderNumber: null, error: "approval_rejected" };
    }
    if (err instanceof ApprovalTimeoutError) {
      logger.warn(MODULE, "purchase_timed_out_awaiting_approval", { item: item.name });
      return { success: false, orderNumber: null, error: "approval_timeout" };
    }
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

async function navigateFromCartToCheckout(
  page: Page,
  rateLimiter: RateLimiter,
  logger: Logger
): Promise<void> {
  await rateLimiter.acquire(LAZADA_DOMAIN);
  await clickElement(page, SELECTORS.cart.proceedToCheckout, logger);
  await page.waitForTimeout(2_000);
}

async function selectPaymentMethod(
  page: Page,
  paymentMethod: string,
  logger: Logger
): Promise<void> {
  const method = paymentMethod.toLowerCase();
  const options = page.locator(
    SELECTORS.checkout.paymentMethodOption.candidates.join(", ")
  );

  const count = await options.count().catch(() => 0);
  if (count === 0) {
    logger.warn(MODULE, "no_payment_options_found", { paymentMethod });
    return;
  }

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = ((await option.textContent().catch(() => "")) ?? "").toLowerCase();

    const matches =
      (method === "credit_card" && (text.includes("credit") || text.includes("debit") || text.includes("card"))) ||
      (method === "cod" && (text.includes("cash on delivery") || text.includes("cod"))) ||
      (method === "paynow" && text.includes("paynow")) ||
      (method !== "credit_card" && method !== "cod" && method !== "paynow" && text.includes(method));

    if (matches) {
      await option.click().catch(() => {});
      logger.info(MODULE, "payment_method_selected", { paymentMethod, matchedText: text.trim() });
      await page.waitForTimeout(1_000);
      return;
    }
  }

  logger.warn(MODULE, "payment_method_not_matched", { paymentMethod, optionsFound: count });
}

async function buildOrderSummary(
  page: Page,
  item: Item,
  logger: Logger
): Promise<OrderSummary> {
  const priceText = await extractText(page, SELECTORS.checkout.orderTotal, logger);
  const addressText = await extractText(page, SELECTORS.checkout.deliveryAddress, logger);
  const paymentLabel = await extractText(page, SELECTORS.checkout.selectedPaymentLabel, logger);

  const priceMatch = priceText?.match(/[\d,]+\.?\d*/);
  const price: number | null = priceMatch ? parseFloat(priceMatch[0].replace(",", "")) : null;

  const summary: OrderSummary = {
    itemName: item.name,
    itemUrl: item.url,
    price,
    quantity: item.quantity,
    estimatedTotal: price !== null ? parseFloat((price * item.quantity).toFixed(2)) : null,
    deliveryAddress: addressText?.trim() ?? "(address not detected — verify in browser)",
    paymentMethod: paymentLabel?.trim() ?? "(payment method not detected — verify in browser)",
  };

  logger.info(MODULE, "order_summary_built", {
    item: item.name,
    price: summary.price,
    estimatedTotal: summary.estimatedTotal,
  });

  return summary;
}

async function waitForConfirmation(
  page: Page,
  itemName: string,
  logger: Logger
): Promise<CheckoutResult> {
  try {
    await page.waitForSelector(
      SELECTORS.confirmation.successHeading.candidates.join(", "),
      { timeout: 20_000 }
    );

    const orderNumberText = await extractText(page, SELECTORS.confirmation.orderNumber, logger);
    const orderNumber = orderNumberText?.trim().replace(/[^A-Za-z0-9-]/g, "") ?? null;

    logger.info(MODULE, "order_confirmed", { item: itemName, orderNumber });
    return { success: true, orderNumber, error: null };
  } catch {
    // Check if we're still on checkout (may be 3DS or additional step)
    if (page.url().includes("/checkout")) {
      const bodyText = (await page.locator("body").textContent().catch(() => "")) ?? "";
      if (
        bodyText.toLowerCase().includes("failed") ||
        bodyText.toLowerCase().includes("error") ||
        bodyText.toLowerCase().includes("declined")
      ) {
        const error = "Payment failed or was declined — check your payment method.";
        logger.error(MODULE, "payment_failed", { item: itemName });
        return { success: false, orderNumber: null, error };
      }
    }

    const error = "Order confirmation not detected — verify order status on Lazada manually.";
    logger.error(MODULE, "confirmation_not_detected", { item: itemName, url: page.url() });
    return { success: false, orderNumber: null, error };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
