/**
 * Entry point.
 *
 * Lifecycle:
 *   1. Load and validate config + env-var credentials
 *   2. Launch browser, restore session, verify login
 *   3. Start one monitor+checkout worker per configured item
 *   4. Shut down gracefully on SIGINT/SIGTERM
 *
 * Promise.allSettled is used so a failure on one item does not abort others.
 */

import * as path from "path";
import { chromium, BrowserContext, Page } from "playwright";
import * as dotenv from "dotenv";
import { loadConfig, loadCredentials, loadTelegramCredentials } from "./config";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { loadSession, login, saveSession, isLoggedIn, runAuthDebug, ChallengeDetectedError } from "./auth";
import { waitForStock } from "./monitor";
import { watchWishlist } from "./wishlist-monitor";
import { RestockRegistry, RestockGate } from "./restock-signal";
import { shouldProceed, isAntiBot, extractProductId, parseWishlistStock, matchWishlistItem } from "./decision";
import { checkout } from "./checkout";
import { navigateTo } from "./browser-actions";
import { startHealthServer, RuntimeStatus, ItemStatus } from "./health";
import { applyStealth } from "./stealth";
import { Item, Config, StockCheckResult, ChallengeSurvivalOptions, RetryProfile } from "./types";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CLI_DRY_RUN = args.includes("--dry-run");
const CLI_VERIFY_SELECTORS = args.includes("--verify-selectors");
const CLI_LIST_WISHLIST = args.includes("--list-wishlist");
const CLI_DEBUG_DOM = args.includes("--debug-dom");
const CLI_AUTH_DEBUG = args.includes("--auth-debug");
const AUTH_DEBUG_PAUSE_MS = 2_000;

// ---------------------------------------------------------------------------
// Per-item worker
// ---------------------------------------------------------------------------

async function runItemWorker(
  item: Item,
  config: Config,
  context: BrowserContext,
  rateLimiter: RateLimiter,
  logger: Logger,
  signal: AbortSignal,
  itemStatus: ItemStatus,
  runtimeStatus: RuntimeStatus,
  debugDir?: string
): Promise<void> {
  const page = await context.newPage();

  try {
    // Monitor until in-stock
    const survival: ChallengeSurvivalOptions = {
      surviveChallenges: config.settings.surviveChallenges,
      challengeBackoffBaseMs: config.settings.challengeBackoffBaseMs,
      challengeBackoffMaxMs: config.settings.challengeBackoffMaxMs,
      maxConsecutiveChallenges: config.settings.maxConsecutiveChallenges,
    };

    const result: StockCheckResult = await waitForStock(
      page,
      item,
      config.settings.checkIntervalMs,
      rateLimiter,
      logger,
      signal,
      survival,
      config.settings.pollSettleMs,
      config.settings.debugSnapshots,
      debugDir
    );

    // Update item health metrics after each stock check
    itemStatus.lastChecked = result.timestamp;
    itemStatus.lastStatus = result.status;
    itemStatus.checkCount++;
    if (result.status === "anti_bot") {
      itemStatus.antiBotCount++;
      runtimeStatus.totalChallengesDetected++;
    }

    if (signal.aborted) {
      logger.info("worker", "aborted_before_decision", { item: item.name });
      return;
    }

    // Decision gate
    const decision = shouldProceed(result, item, config.settings.dryRun);

    if (!decision.proceed) {
      logger.warn("worker", "purchase_skipped", { item: item.name, reason: decision.reason });

      if (isAntiBot(result.status)) {
        logger.error("worker", "anti_bot_detected_worker_halt", { item: item.name });
        throw new Error(`Anti-bot challenge on "${item.name}" — halting worker`);
      }

      if (result.status === "login_required") {
        logger.error("worker", "worker_halted_login_expired", { item: item.name });
        throw new Error(`Session expired for "${item.name}" — halting worker. Re-authenticate and restart.`);
      }
      return;
    }

    // Checkout
    logger.info("worker", "starting_checkout", { item: item.name, price: result.price });

    // The monitor leaves `page` on the in-stock product page, so the checkout
    // can buy from it directly when fastCheckout is enabled — no reload, no wait.
    // Clock starts now: in-stock is already detected (waitForStock returned it).
    const instockAt = Date.now();
    runtimeStatus.totalCheckoutAttempts++;
    const checkoutResult = await checkout(
      page,
      item,
      config,
      rateLimiter,
      logger,
      config.settings.fastCheckout
    );

    logger.info("worker", "instock_to_confirm", {
      item: item.name,
      success: checkoutResult.success,
      durationMs: Date.now() - instockAt,
      orderNumber: checkoutResult.orderNumber,
    });

    if (checkoutResult.success) {
      runtimeStatus.totalPurchases++;
      logger.info("worker", "purchase_complete", {
        item: item.name,
        orderNumber: checkoutResult.orderNumber,
      });
    } else {
      logger.warn("worker", "purchase_incomplete", {
        item: item.name,
        error: checkoutResult.error,
      });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-item buyer (wishlist mode)
// ---------------------------------------------------------------------------

/**
 * Idles on its RestockGate until the wishlist watcher signals this item is back
 * in stock, then reloads its (warm) product page and runs checkout with a fast
 * retry profile so transient out-of-stock (traffic) is retried within the drop
 * window. Loops back to wait for the next restock after a failed attempt.
 */
async function runBuyerWorker(
  item: Item,
  productId: string,
  page: Page,
  config: Config,
  rateLimiter: RateLimiter,
  logger: Logger,
  gate: RestockGate,
  signal: AbortSignal,
  itemStatus: ItemStatus,
  runtimeStatus: RuntimeStatus,
  activeBuys: { count: number }
): Promise<void> {
  const fastRetry: RetryProfile = {
    maxRetries: config.settings.buyMaxRetries,
    baseMs: config.settings.buyRetryBaseMs,
    maxMs: config.settings.buyRetryMaxMs,
  };

  while (!signal.aborted) {
    await gate.waitForRestock(signal);
    if (signal.aborted) return;

    // Clock starts at the restock signal — this is the in-stock detection moment.
    const instockAt = Date.now();
    logger.info("buyer", "restock_signal_received", { item: item.name, productId });
    itemStatus.lastChecked = new Date().toISOString();
    runtimeStatus.totalCheckoutAttempts++;

    // While any buy is in flight the watcher pauses its wishlist polling —
    // the buy itself is the session's peak request rate, and stacking the
    // 1-2s wishlist reloads on top is what primes anti-bot punishment.
    activeBuys.count++;
    try {
      // Warm reload: a page held open for hours won't auto-enable Buy Now, but
      // the reload skips the rate limiter and reuses the warm session. The first
      // checkout attempt then acts on this just-loaded page (alreadyOnProductPage).
      await navigateTo(page, item.url, logger);
      const reloadMs = Date.now() - instockAt;

      const checkoutResult = await checkout(page, item, config, rateLimiter, logger, true, fastRetry);

      logger.info("buyer", "instock_to_confirm", {
        item: item.name,
        productId,
        success: checkoutResult.success,
        durationMs: Date.now() - instockAt,
        reloadMs,
        orderNumber: checkoutResult.orderNumber,
      });

      if (checkoutResult.success) {
        runtimeStatus.totalPurchases++;
        logger.info("buyer", "purchase_complete", {
          item: item.name,
          orderNumber: checkoutResult.orderNumber,
        });
        return;
      }

      // Likely a genuine sellout this drop — idle until the next restock.
      logger.warn("buyer", "purchase_incomplete", { item: item.name, error: checkoutResult.error });
    } catch (err) {
      if (err instanceof ChallengeDetectedError) {
        logger.error("buyer", "anti_bot_during_buy", { item: item.name });
        throw err; // fail-closed on the buy path
      }
      logger.error("buyer", "buy_error", { item: item.name, error: (err as Error).message });
    } finally {
      activeBuys.count--;
    }
  }
}

// ---------------------------------------------------------------------------
// Selector verification mode
// ---------------------------------------------------------------------------

async function verifySelectors(
  context: BrowserContext,
  config: Config,
  logger: Logger
): Promise<void> {
  const { verifySelectorPage, SELECTORS } = await import("./selectors");
  const page = await context.newPage();

  try {
    logger.info("verify", "checking_login_page_selectors", { url: config.settings.loginUrl });
    await page.goto(config.settings.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const loginResults = await verifySelectorPage(page, SELECTORS.login as never);
    logger.info("verify", "login_selector_results", { results: loginResults });

    const firstItem = config.items[0];
    if (firstItem) {
      logger.info("verify", "checking_product_page_selectors", { url: firstItem.url });
      await page.goto(firstItem.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(2_000);
      const productResults = await verifySelectorPage(page, SELECTORS.product as never);
      logger.info("verify", "product_selector_results", { results: productResults });
    }

    // Wishlist mode reads embedded JSON, not DOM selectors — verify the payload
    // parses and that each configured item is matchable by title or product id.
    logger.info("verify", "checking_wishlist_payload", { url: config.settings.wishlistUrl });
    await page.goto(config.settings.wishlistUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const html = (await page.content().catch(() => "")) ?? "";
    const state = parseWishlistStock(html);
    const trackedMatches = config.items.map((it) => {
      const match = matchWishlistItem(it, state);
      return {
        name: it.name,
        configUrlId: extractProductId(it.url),
        onWishlist: match !== null,
        matchedBy: match?.matchedBy ?? null,
        wishlistItemId: match?.itemId ?? null,
        status: match?.status ?? "not_found",
      };
    });
    logger.info("verify", "wishlist_payload_results", {
      wishlistItemCount: state.knownIds.size,
      outOfStockCount: state.outOfStockIds.size,
      trackedMatches,
    });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Wishlist listing mode
// ---------------------------------------------------------------------------

/**
 * Read-only diagnostic (`npm run list-wishlist`): prints every item Lazada
 * reports on the account wishlist (itemId, title, stock) plus the match result
 * for each configured item — so a failed match can be fixed by copying the
 * exact title/id into config.json.
 */
async function listWishlist(
  context: BrowserContext,
  config: Config,
  logger: Logger
): Promise<void> {
  const page = await context.newPage();
  try {
    logger.info("wishlist-list", "loading_wishlist", { url: config.settings.wishlistUrl });
    await page.goto(config.settings.wishlistUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const html = (await page.content().catch(() => "")) ?? "";
    const state = parseWishlistStock(html);

    if (state.items.length === 0) {
      logger.warn("wishlist-list", "no_wishlist_data", {
        url: page.url(),
        hint: "Empty wishlist, session expired (page redirected?), or Lazada changed the embedded payload shape.",
      });
      return;
    }

    logger.info("wishlist-list", "wishlist_items_found", { count: state.items.length });
    for (const w of state.items) {
      logger.info("wishlist-list", "wishlist_item", {
        itemId: w.itemId,
        title: w.title || "(no title in payload)",
        stock: w.outOfStock ? "OUT_OF_STOCK" : "in_stock",
      });
    }

    for (const it of config.items) {
      const match = matchWishlistItem(it, state);
      const entry = {
        name: it.name,
        configUrlId: extractProductId(it.url),
        matchedBy: match?.matchedBy ?? null,
        wishlistItemId: match?.itemId ?? null,
        status: match?.status ?? "not_found",
      };
      if (match) {
        logger.info("wishlist-list", "config_item_matched", entry);
      } else {
        logger.warn("wishlist-list", "config_item_not_matched", {
          ...entry,
          hint: "Set the item's config name to one of the wishlist titles above (or use the canonical PDP URL whose id matches a wishlist itemId).",
        });
      }
    }
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── Config & credentials ─────────────────────────────────────────────────

  // Load .env if present (dotenv skips vars already set in environment)
  dotenv.config();

  const config = loadConfig();

  // Override dryRun from CLI flag
  if (CLI_DRY_RUN) {
    config.settings.dryRun = true;
  }
  // Override debugSnapshots from CLI flag
  if (CLI_DEBUG_DOM) {
    config.settings.debugSnapshots = true;
  }
  // Auth-debug must be observable — force a visible browser.
  if (CLI_AUTH_DEBUG) {
    config.settings.headless = false;
  }

  const logger = new Logger(config.settings.logDir);

  logger.info("main", "startup", {
    itemCount: config.items.length,
    dryRun: config.settings.dryRun,
    headless: config.settings.headless,
    checkIntervalMs: config.settings.checkIntervalMs,
    debugSnapshots: config.settings.debugSnapshots,
  });

  if (config.settings.dryRun) {
    logger.warn("main", "dry_run_active", {
      message: 'DRY RUN mode: items will be monitored but NO purchases will be made. Set "dryRun": false in config.json to enable purchases.',
    });
  }

  // Validate credentials exist before launching browser
  loadCredentials(); // throws if LAZADA_EMAIL or LAZADA_PASSWORD is absent
  if (config.settings.approvalMethod === "telegram") {
    loadTelegramCredentials(); // fail fast if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing
    logger.info("main", "telegram_approval_enabled");
  }

  // ── Browser setup ────────────────────────────────────────────────────────

  const browser = await chromium.launch({
    headless: config.settings.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
  });

  // Mask automation fingerprints before any page loads (avoidance, not bypass).
  if (config.settings.stealth) {
    await applyStealth(context, logger);
  }

  const controller = new AbortController();

  const shutdown = async (reason: string): Promise<void> => {
    logger.info("main", "shutdown_initiated", { reason });
    controller.abort();
    await saveSession(context, config.settings.sessionFile, logger).catch(() => {});
    await browser.close().catch(() => {});
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // ── Auth debug mode ──────────────────────────────────────────────────────
  // Observable, headed login: clears cookies, steps through fill email → fill
  // password → submit → homepage, snapshotting each step to data/debug/auth/.

  if (CLI_AUTH_DEBUG) {
    const snapshotDir = path.join(config.settings.dataDir, "debug", "auth");
    logger.info("main", "auth_debug_mode", { snapshotDir, pauseMs: AUTH_DEBUG_PAUSE_MS });
    const authPage = await context.newPage();
    try {
      const loggedIn = await runAuthDebug(
        context,
        authPage,
        logger,
        config.settings.sessionFile,
        config.settings.loginUrl,
        snapshotDir,
        AUTH_DEBUG_PAUSE_MS
      );
      logger.info("main", "auth_debug_result", { loggedIn });
      await shutdown("auth_debug_complete");
      process.exit(loggedIn ? 0 : 1);
    } catch (err) {
      logger.error("main", "auth_debug_failed", { error: (err as Error).message });
      await shutdown("auth_debug_failed");
      process.exit(1);
    }
  }

  // ── Authentication ───────────────────────────────────────────────────────

  try {
    const authPage = await context.newPage();
    await loadSession(context, config.settings.sessionFile, logger);

    if (!(await isLoggedIn(authPage, logger))) {
      await login(context, authPage, logger, config.settings.sessionFile, config.settings.loginUrl);
    } else {
      logger.info("main", "session_valid_skipping_login");
    }

    await authPage.close();
  } catch (err) {
    if (err instanceof ChallengeDetectedError) {
      logger.error("main", "login_blocked_by_challenge", { error: err.message });
      await shutdown("challenge_during_login");
      process.exit(1);
    }
    throw err;
  }

  // ── Selector verification mode ───────────────────────────────────────────

  if (CLI_VERIFY_SELECTORS) {
    logger.info("main", "running_selector_verification");
    await verifySelectors(context, config, logger);
    await shutdown("selector_verification_complete");
    process.exit(0);
  }

  // ── Wishlist listing mode ────────────────────────────────────────────────

  if (CLI_LIST_WISHLIST) {
    logger.info("main", "running_wishlist_listing");
    await listWishlist(context, config, logger);
    await shutdown("wishlist_listing_complete");
    process.exit(0);
  }

  // ── Rate limiter ─────────────────────────────────────────────────────────

  const rateLimiter = new RateLimiter({
    minIntervalMs: config.settings.minPageLoadDelayMs,
    maxJitterMs: config.settings.maxPageLoadDelayMs - config.settings.minPageLoadDelayMs,
  });

  // ── Runtime status (for health endpoint) ─────────────────────────────────

  const itemStatuses: ItemStatus[] = config.items.map((item) => ({
    name: item.name,
    lastChecked: null,
    lastStatus: null,
    checkCount: 0,
    antiBotCount: 0,
  }));

  const runtimeStatus: RuntimeStatus = {
    startedAt: new Date().toISOString(),
    dryRun: config.settings.dryRun,
    items: itemStatuses,
    totalChallengesDetected: 0,
    totalCheckoutAttempts: 0,
    totalPurchases: 0,
  };

  if (config.settings.healthPort > 0) {
    startHealthServer(config.settings.healthPort, () => runtimeStatus);
    logger.info("main", "health_server_started", { port: config.settings.healthPort });
  }

  // ── Item workers ─────────────────────────────────────────────────────────

  const debugDir = config.settings.debugSnapshots
    ? path.join(config.settings.dataDir, "debug")
    : undefined;

  if (debugDir) {
    logger.info("main", "debug_snapshots_enabled", { debugDir });
  }

  logger.info("main", "workers_starting", {
    mode: config.settings.monitorMode,
    items: config.items.map((i) => i.name),
  });

  let results: PromiseSettledResult<void>[];

  if (config.settings.monitorMode === "wishlist") {
    // One watcher polls the wishlist and fans out restock signals to N buyers,
    // each idling on a pre-opened warm product page.
    const survival: ChallengeSurvivalOptions = {
      surviveChallenges: config.settings.surviveChallenges,
      challengeBackoffBaseMs: config.settings.challengeBackoffBaseMs,
      challengeBackoffMaxMs: config.settings.challengeBackoffMaxMs,
      maxConsecutiveChallenges: config.settings.maxConsecutiveChallenges,
    };

    const registry = new RestockRegistry();
    // Shared buy-in-flight counter: buyers increment around a buy, the watcher
    // skips wishlist polls while it is non-zero (lower anti-bot footprint at
    // the most sensitive moment). Fired gates stay latched, so nothing is lost.
    const activeBuys = { count: 0 };
    // Non-null: loadConfig guarantees every URL yields an id in wishlist mode.
    const productIds = config.items.map((it) => extractProductId(it.url)!);
    const gates = productIds.map((id) => registry.register(id));
    const buyerPages = await Promise.all(config.items.map(() => context.newPage()));
    const watcherPage = await context.newPage();

    const watcher = watchWishlist(
      watcherPage,
      config.items,
      registry,
      config.settings.wishlistUrl,
      config.settings.wishlistPollIntervalMs,
      rateLimiter,
      logger,
      controller.signal,
      survival,
      (c) => {
        const idx = productIds.indexOf(c.productId);
        if (idx >= 0) {
          const s = itemStatuses[idx]!;
          s.lastChecked = new Date().toISOString();
          s.lastStatus = c.status;
          s.checkCount++;
        }
      },
      debugDir,
      () => activeBuys.count > 0
    ).finally(() => {
      // Watcher death (login_required / circuit breaker) blinds all buyers, so
      // halt the run: abort wakes idle buyers, which then exit.
      controller.abort();
      registry.abortAll();
    });

    const buyers = config.items.map((item, i) =>
      runBuyerWorker(
        item,
        productIds[i]!,
        buyerPages[i]!,
        config,
        rateLimiter,
        logger,
        gates[i]!,
        controller.signal,
        itemStatuses[i]!,
        runtimeStatus,
        activeBuys
      )
    );

    results = await Promise.allSettled([watcher, ...buyers]);
  } else {
    const workers = config.items.map((item, index) =>
      runItemWorker(
        item,
        config,
        context,
        rateLimiter,
        logger,
        controller.signal,
        itemStatuses[index]!,
        runtimeStatus,
        debugDir
      )
    );

    results = await Promise.allSettled(workers);
  }

  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    for (const f of failed) {
      logger.error("main", "worker_failed", { error: (f.reason as Error)?.message ?? String(f.reason) });
    }
  }

  logger.info("main", "all_workers_done", {
    total: results.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: failed.length,
  });

  await shutdown("all_workers_done");
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`[FATAL] ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
