/**
 * Checkout orchestrator.
 *
 * Flow per attempt:
 *   1. Navigate to product page → click Buy Now (no Add to Cart fallback)
 *   2. Wait for the checkout page's Place Order CTA (element gate — no URL
 *      assumption; Lazada SG checkout is a separate HOST, not a /checkout path)
 *   3. Confirm PayNow is the selected method — fail-closed: if unconfirmable,
 *      abort WITHOUT placing the order (guardrail against a saved card charge)
 *   4. Click Place Order Now
 *   5. Wait for the outcome: classic order-success page OR the PayNow QR /
 *      cashier page (the scan-to-pay handoff — counts as success; user pays)
 *
 * Anti-bot challenges halt checkout immediately.
 * Dry-run guard is the FIRST check — aborts before any page navigation.
 */

import * as path from "path";
import { Page } from "playwright";
import { Item, Config, CheckoutResult, RetryProfile } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS, resolveSelector, waitForSelectorSet, SelectorNotFoundError } from "./selectors";
import { detectChallenge, ChallengeDetectedError } from "./auth";
import { navigateTo, clickElement, extractText } from "./browser-actions";
import { captureNamedSnapshot, describeProductSelectors } from "./diagnostics";
import { PhaseTimer } from "./timing";

const MODULE = "checkout";
const LAZADA_DOMAIN = "www.lazada.sg";
const PAYMENT_METHOD = "paynow";

// Lazada pages are client-rendered: navigateTo returns at domcontentloaded but
// the buy box / checkout CTAs hydrate hundreds of ms later. These are the
// bounded waits for each stage (waitForSelectorSet returns the moment the
// element appears, so a fast render costs a single pass). Callers that arrive
// on a commit-time page (the wishlist buyer's overlapped reload) pass a longer
// buyNowWaitMs so the wait absorbs document parse + hydration too.
const BUY_NOW_WAIT_MS = 3_000;
// Absorbs the Buy Now → checkout navigation too: arrival on the checkout page
// is detected by the Place Order CTA appearing, NOT by URL (Lazada SG checkout
// lives on the checkout.lazada.sg HOST with pathname "/", and its load event
// may never fire — a path-based waitForURL gate timed out on a live run).
const CHECKOUT_READY_WAIT_MS = 15_000;
const PAYMENT_OPTIONS_WAIT_MS = 8_000;
const CONFIRMATION_WAIT_MS = 20_000;

// Poll cadence for the bounded readiness/confirmation loops (was an inline
// 250ms). Faster polling returns the instant an element appears; the cost is
// pure CPU — every pass is a client-side DOM/URL read, never a Lazada request —
// so a tight cadence trims latency without adding any anti-bot footprint.
const CHECKOUT_POLL_MS = 75;
// detectChallenge is also a client-side DOM+URL check; decouple it from the
// 75ms selector poll so it still fires at most ~once per this interval rather
// than ~13×/s. A punish/captcha redirect is the slow, seconds-long kind, so
// ~300ms cadence catches it comfortably.
const CHALLENGE_CHECK_MS = 300;
// Explicit fast poll for the Buy Now wait (was the waitForSelectorSet default 150).
const BUY_NOW_POLL_MS = 50;

// Fail-closed guardrail (dev phase): the checkout page offers a saved card next
// to PayNow, so Place Order is NEVER clicked unless PayNow is positively
// confirmed as the selected method. This sentinel marks that abort; the retry
// loop treats it as non-retryable (re-running cannot fix a selector mismatch
// and would stack abandoned checkouts).
const PAYNOW_NOT_CONFIRMED_ERROR =
  "PayNow could not be confirmed as the selected payment method — order NOT placed";

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
  retry?: RetryProfile,
  buyNowWaitMs = BUY_NOW_WAIT_MS
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
    const result = await attemptCheckout(
      page,
      item,
      config,
      rateLimiter,
      logger,
      attempt,
      skipInitialNav,
      buyNowWaitMs
    );

    if (result.success) return result;

    // Fail-closed: PayNow unconfirmed is non-retryable (its own forensic
    // snapshot was already captured in ensurePayNowSelected's failure path).
    if (result.error === PAYNOW_NOT_CONFIRMED_ERROR) return result;

    if (attempt < profile.maxRetries) {
      const backoffMs = Math.min(
        profile.baseMs * Math.pow(2, attempt - 1),
        profile.maxMs
      );
      logger.warn(MODULE, "retry_backoff", { item: item.name, attempt, backoffMs });
      await sleep(backoffMs);
    }
  }

  // Terminal failure: capture the page exactly as the last attempt saw it
  // (screenshot + HTML + per-selector match report). This is the only moment
  // the evidence exists, so it is always on — not gated by debugSnapshots.
  const failureDir = path.join(config.settings.dataDir, "debug");
  logger.warn(MODULE, "capturing_failure_snapshot", { item: item.name, dir: failureDir });
  await captureNamedSnapshot(page, `checkout-failed-${item.name}`, failureDir, logger);
  await describeProductSelectors(page, logger);

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
  skipInitialNav: boolean,
  buyNowWaitMs: number
): Promise<CheckoutResult> {
  const timer = new PhaseTimer();
  const debugDir = path.join(config.settings.dataDir, "debug");
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

    // Buy Now only — no Add to Cart fallback. The buy box hydrates after
    // domcontentloaded, so this WAITS (bounded) for a candidate to appear
    // instead of sampling the instant page state. On the fast path the monitor
    // confirmed an enabled Buy Now on this exact page milliseconds ago, so one
    // instant pass usually suffices — fall back to the bounded wait only if the
    // DOM shifted under us. Retries always take the bounded wait: their page
    // just reloaded and is still hydrating.
    const buyNow =
      (skipInitialNav
        ? await resolveSelector(page, SELECTORS.product.buyNowButton).catch(() => null)
        : null) ??
      (await waitForSelectorSet(
        page,
        SELECTORS.product.buyNowButton,
        buyNowWaitMs,
        BUY_NOW_POLL_MS
      ));
    timer.mark("locate_buy_now");
    if (!buyNow) {
      logger.warn(MODULE, "buy_now_unavailable", { item: item.name, attempt, url: page.url() });
      logger.info(MODULE, "checkout_timing", {
        item: item.name,
        attempt,
        success: false,
        ...timer.summary(),
      });
      return { success: false, orderNumber: null, error: "Buy Now button not found" };
    }

    // Quantity after the buy box is up — the input hydrates with it.
    if (item.quantity > 1) {
      await setQuantity(page, item.quantity, logger);
    }

    await clickElement(page, SELECTORS.product.buyNowButton, logger);
    logger.info(MODULE, "clicked_buy_now", { item: item.name, attempt });

    // Element gate: we are "on the checkout page" when the Place Order CTA is
    // visible. No URL assumption — see CHECKOUT_READY_WAIT_MS note. This single
    // overlapped loop also selects/confirms PayNow WHILE the page hydrates, so
    // the payment work hides inside the (irreducible) Buy Now → checkout
    // transition instead of running after it. Challenge-aware: an anti-bot
    // punish redirect here throws immediately instead of burning the full wait
    // (the live x5sec punish hit exactly this window).
    const marks = { ctaSeenAt: null as number | null, payNowConfirmedAt: null as number | null };
    const outcome = await waitForCheckoutReadyAndPayNow(page, logger, marks);

    // Preserve the two phases even though the work overlapped: buy_now_to_checkout
    // = until the Place Order CTA was first seen; select_payment = the residual
    // PayNow time beyond that (≈0 when payment finished inside the hydration
    // window, non-zero only when payment was the bottleneck). Clamp so the delta
    // is never negative when PayNow confirms before the CTA is seen.
    const ctaSeenAt = marks.ctaSeenAt ?? Date.now();
    const payConfirmedAt = Math.max(marks.payNowConfirmedAt ?? ctaSeenAt, ctaSeenAt);
    timer.markAt("buy_now_to_checkout", ctaSeenAt);
    timer.markAt("select_payment", payConfirmedAt);

    logger.info(MODULE, "on_checkout_page", { item: item.name, url: page.url() });

    if (outcome.kind === "paynow-unconfirmed") {
      logger.error(MODULE, "paynow_not_confirmed", {
        item: item.name,
        attempt,
        url: page.url(),
      });
      await captureNamedSnapshot(page, `paynow-not-confirmed-${item.name}`, debugDir, logger);
      return { success: false, orderNumber: null, error: PAYNOW_NOT_CONFIRMED_ERROR };
    }

    // Place order — Lazada will display a PayNow QR for the user to scan
    const urlAtPlaceOrder = page.url();
    await clickElement(page, SELECTORS.checkout.placeOrderButton, logger);
    logger.info(MODULE, "place_order_clicked", { item: item.name });

    const result = await waitForConfirmation(page, item.name, logger, urlAtPlaceOrder, debugDir);
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
        url: err.challenge.url,
      });
      await captureNamedSnapshot(page, `checkout-challenge-${item.name}`, debugDir, logger);
      throw err; // Propagate — caller (index.ts) initiates shutdown
    }

    // Always-on per-attempt snapshot: the terminal snapshot only preserves the
    // LAST attempt's page, but the first attempt is usually the informative one.
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(MODULE, "checkout_attempt_failed", {
      item: item.name,
      attempt,
      url: page.url(),
      error: errMsg,
    });
    await captureNamedSnapshot(page, `checkout-failed-${item.name}-attempt${attempt}`, debugDir, logger);
    return { success: false, orderNumber: null, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function setQuantity(page: Page, quantity: number, logger: Logger): Promise<void> {
  // The quantity input hydrates with (or just after) the buy box, so this must
  // WAIT bounded, not sample the instant state — an instant resolveSelector here
  // silently skipped the input on a live run and bought quantity 1.
  const resolved = await waitForSelectorSet(page, SELECTORS.product.quantityInput, 2_000).catch(
    () => null
  );
  if (!resolved) {
    logger.warn(MODULE, "quantity_input_not_found", {
      requestedQuantity: quantity,
      consequence: "proceeding with quantity 1",
    });
    return;
  }
  const locator = page.locator(resolved.selector).first();
  await locator.click({ clickCount: 3 });
  await locator.fill(String(quantity));
  logger.debug(MODULE, "quantity_set", { quantity });
}

type CheckoutReadyOutcome =
  | { kind: "ready" } //               Place Order CTA visible AND PayNow confirmed
  | { kind: "paynow-unconfirmed" }; // CTA up but PayNow not confirmable in time

/**
 * Runs detectChallenge at most once per CHALLENGE_CHECK_MS wall-clock, no matter
 * how fast the caller polls — so dropping the selector poll to 75ms doesn't
 * multiply the (client-side, but still CPU) challenge checks. `lastAt` is the
 * timestamp of the previous actual check (0 = never → checks on the first pass).
 * Throws ChallengeDetectedError on detection, exactly like the inline checks it
 * replaces; returns the timestamp to thread into the next call.
 */
async function throttledChallengeCheck(
  page: Page,
  logger: Logger,
  lastAt: number
): Promise<number> {
  const now = Date.now();
  if (now - lastAt < CHALLENGE_CHECK_MS) return lastAt;
  const challenge = await detectChallenge(page, logger);
  if (challenge) throw new ChallengeDetectedError(challenge);
  return now;
}

/**
 * Overlapped checkout-ready + PayNow-select loop. Replaces the former sequential
 * waitForCheckoutReady → ensurePayNowSelected: it drives PayNow selection WHILE
 * the checkout page's Place Order CTA hydrates, so the payment work hides inside
 * the (irreducible) Buy Now → checkout transition instead of running after it.
 *
 * Two independent deadlines coexist:
 *   - CHECKOUT_READY_WAIT_MS for the Place Order CTA. If it never appears, throws
 *     SelectorNotFoundError — identical to the old waitForCheckoutReady timeout,
 *     so the retry loop (transient OOS) and logs are unchanged.
 *   - PAYMENT_OPTIONS_WAIT_MS for a positive PayNow confirmation, measured from
 *     when the CTA is first seen (matching the old behaviour, where PayNow's clock
 *     only started after the checkout page was up). On timeout returns
 *     { kind: "paynow-unconfirmed" } and the caller ABORTS without placing the
 *     order (fail-closed guardrail).
 *
 * Success ({ kind: "ready" }) requires BOTH the CTA visible AND isPayNowConfirmed
 * true — the only return that lets the caller click Place Order, so the guardrail
 * cannot be bypassed. Each pass also runs the (throttled) challenge check so an
 * anti-bot punish/captcha redirect throws ChallengeDetectedError immediately
 * instead of masquerading as a selector timeout.
 *
 * `marks` is mutated in place with the absolute timestamps of the two milestones
 * so the caller can still report buy_now_to_checkout and select_payment as
 * distinct (now overlapping) phases.
 */
async function waitForCheckoutReadyAndPayNow(
  page: Page,
  logger: Logger,
  marks: { ctaSeenAt: number | null; payNowConfirmedAt: number | null }
): Promise<CheckoutReadyOutcome> {
  const ctaSet = SELECTORS.checkout.placeOrderButton;
  const startAt = Date.now();
  const ctaDeadline = startAt + CHECKOUT_READY_WAIT_MS;

  let payNowConfirmed = false;
  let ctaVisible = false;
  let clicked = false;
  let lastClickAt = 0;
  let lastChallengeCheckAt = 0;

  for (;;) {
    const now = Date.now();

    // (a) Payment — only until positively confirmed. The live page pre-selects
    // the saved CARD, not PayNow, so the click below is the expected path and the
    // indicator check is the proof it landed.
    if (!payNowConfirmed) {
      if (await isPayNowConfirmed(page)) {
        payNowConfirmed = true;
        marks.payNowConfirmedAt = Date.now();
        logger.info(MODULE, "payment_method_selected", { paymentMethod: PAYMENT_METHOD, clicked });
      } else if (now - lastClickAt >= 500) {
        // Options render progressively, so re-scan until confirmed — but throttle
        // the clicks: the card needs a re-render beat to flip to selected. A
        // re-click on the already-selected radio row is idempotent, so 500ms
        // (was 1s) trims the residual select_payment latency safely.
        candidateScan: for (const candidate of SELECTORS.checkout.paymentMethodOption.candidates) {
          const options = page.locator(candidate);
          const count = await options.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const option = options.nth(i);
            const text = ((await option.textContent().catch(() => "")) ?? "").toLowerCase();
            if (text.includes(PAYMENT_METHOD)) {
              await option.click().catch(() => {});
              lastClickAt = Date.now();
              clicked = true;
              logger.debug(MODULE, "paynow_row_clicked", { candidate });
              break candidateScan; // re-check the indicator before clicking again
            }
          }
        }
      }
    }

    // (b) Checkout-page readiness — Place Order CTA visible yet?
    if (!ctaVisible) {
      const resolved = await resolveSelector(page, ctaSet).catch(() => null);
      if (resolved) {
        ctaVisible = true;
        marks.ctaSeenAt = Date.now();
      }
    }

    // Dual exit: succeed only when BOTH hold — never returns "ready" (the only
    // outcome that lets Place Order be clicked) without a positive PayNow confirm.
    if (ctaVisible && payNowConfirmed) return { kind: "ready" };

    // PayNow deadline — gated on the CTA being up so PayNow still gets a full
    // PAYMENT_OPTIONS_WAIT_MS measured from "checkout page is up", as it did when
    // it ran strictly after the CTA wait.
    if (
      !payNowConfirmed &&
      ctaVisible &&
      Date.now() - (marks.ctaSeenAt ?? startAt) >= PAYMENT_OPTIONS_WAIT_MS
    ) {
      logger.warn(MODULE, "paynow_confirm_timeout", { sinceMs: Date.now() - startAt });
      return { kind: "paynow-unconfirmed" };
    }

    // CTA deadline — never showed up → same SelectorNotFoundError the old
    // waitForCheckoutReady threw (retryable; transient-OOS retries still fire).
    if (!ctaVisible && Date.now() >= ctaDeadline) {
      throw new SelectorNotFoundError(ctaSet.description, ctaSet.candidates);
    }

    lastChallengeCheckAt = await throttledChallengeCheck(page, logger, lastChallengeCheckAt);

    await page.waitForTimeout(CHECKOUT_POLL_MS);
  }
}

/**
 * Reads the currently selected payment method via the indicator selector set
 * and returns true iff its text names PayNow. Multiple indicator strategies
 * (selected/active/checked classes, aria, :checked radios) so one DOM shape
 * change doesn't blind the check.
 */
async function isPayNowConfirmed(page: Page): Promise<boolean> {
  for (const candidate of SELECTORS.checkout.paymentSelectedIndicator.candidates) {
    const matches = page.locator(candidate);
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = matches.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = ((await el.textContent().catch(() => "")) ?? "").toLowerCase();
      if (text.includes(PAYMENT_METHOD)) return true;
    }
  }
  return false;
}

/**
 * Polls (bounded) for the outcome of Place Order. Two success shapes:
 *  - classic "Thank you" order page (successHeading) — extract the order number;
 *  - the PayNow QR / cashier page (paymentPending markers, or a navigation to a
 *    cashier/pay URL) — this is the scan-to-pay handoff and counts as success
 *    with no order number. The checkout job is complete at this point; the QR
 *    stays on screen for the user.
 * Either way an always-on snapshot is saved as the audit/QR record.
 */
async function waitForConfirmation(
  page: Page,
  itemName: string,
  logger: Logger,
  urlAtPlaceOrder: string,
  debugDir: string
): Promise<CheckoutResult> {
  const deadline = Date.now() + CONFIRMATION_WAIT_MS;
  let lastChallengeCheckAt = 0;

  do {
    const heading = await resolveSelector(page, SELECTORS.confirmation.successHeading).catch(
      () => null
    );
    if (heading) {
      const orderNumberText = await extractText(page, SELECTORS.confirmation.orderNumber, logger);
      const orderNumber = orderNumberText?.trim().replace(/[^A-Za-z0-9-]/g, "") ?? null;

      logger.info(MODULE, "order_confirmed", { item: itemName, orderNumber });
      // Fire-and-forget the audit snapshot so success returns the instant it's
      // detected — the screenshot+HTML write no longer inflates the measured
      // place_order_to_confirm or the real time-to-QR. The caller drains
      // pendingSnapshot before any page.close() so the capture isn't truncated.
      const pendingSnapshot = captureNamedSnapshot(
        page,
        `order-confirmed-${itemName}`,
        debugDir,
        logger
      ).catch(() => {});
      return { success: true, orderNumber, error: null, pendingSnapshot };
    }

    const qr = await resolveSelector(page, SELECTORS.confirmation.paymentPending).catch(
      () => null
    );
    const url = page.url();
    const movedToCashier = url !== urlAtPlaceOrder && /cashier|pay/i.test(url);
    if (qr || movedToCashier) {
      logger.info(MODULE, "paynow_qr_displayed", {
        item: itemName,
        url,
        marker: qr?.selector ?? "url",
      });
      const pendingSnapshot = captureNamedSnapshot(
        page,
        `order-confirmed-${itemName}`,
        debugDir,
        logger
      ).catch(() => {});
      return { success: true, orderNumber: null, error: null, pendingSnapshot };
    }

    // A punish/captcha redirect can equally follow Place Order — surface it
    // immediately instead of timing out into a misleading "not detected".
    lastChallengeCheckAt = await throttledChallengeCheck(page, logger, lastChallengeCheckAt);

    await page.waitForTimeout(CHECKOUT_POLL_MS);
  } while (Date.now() < deadline);

  // Deadline reached with neither success shape — scan once for an explicit
  // failure banner (only now: words like "error" are too generic to gate the
  // poll loop on while the QR may still be loading).
  if (page.url() === urlAtPlaceOrder) {
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
