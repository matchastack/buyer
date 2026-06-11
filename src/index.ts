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
import { chromium, BrowserContext } from "playwright";
import * as dotenv from "dotenv";
import { loadConfig, loadCredentials, loadTelegramCredentials, loadProxyCredentials } from "./config";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { loadSession, login, saveSession, isLoggedIn, ChallengeDetectedError } from "./auth";
import { waitForStock } from "./monitor";
import { shouldProceed, isAntiBot } from "./decision";
import { checkout } from "./checkout";
import { startHealthServer, RuntimeStatus, ItemStatus } from "./health";
import { Item, Config, StockCheckResult } from "./types";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CLI_DRY_RUN = args.includes("--dry-run");
const CLI_VERIFY_SELECTORS = args.includes("--verify-selectors");
const CLI_DEBUG_DOM = args.includes("--debug-dom");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves after `ms` milliseconds, or immediately if the signal is aborted. */
function startupDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

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
    const result: StockCheckResult = await waitForStock(
      page,
      item,
      config.settings.checkIntervalMs,
      rateLimiter,
      logger,
      signal,
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

    runtimeStatus.totalCheckoutAttempts++;
    const checkoutResult = await checkout(page, item, config, rateLimiter, logger);

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
    logger.info("verify", "checking_login_page_selectors");
    await page.goto("https://www.lazada.sg/customer/account/login/", {
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

  // Optional residential proxy. Returns null when unconfigured (run proxy-less);
  // throws if only partially set so we never silently leak the real IP.
  const proxyCreds = loadProxyCredentials(config.settings.proxy?.server);

  const browser = await chromium.launch({
    headless: config.settings.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  const context: BrowserContext = await browser.newContext({
    ...(proxyCreds
      ? {
          proxy: {
            server: proxyCreds.server,
            username: proxyCreds.username,
            password: proxyCreds.password,
            ...(config.settings.proxy?.bypass ? { bypass: config.settings.proxy.bypass } : {}),
          },
        }
      : {}),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
    // Client hints + Accept-Language aligned with the Windows/Chrome-124 UA above
    // (a mismatch between UA and client hints is itself a bot tell).
    extraHTTPHeaders: {
      "Accept-Language": "en-SG,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  if (proxyCreds) {
    logger.info("main", "proxy_enabled", { server: proxyCreds.server }); // creds never logged
  }

  // Harden residual automation tells beyond --disable-blink-features.
  // Runs in every page before site scripts.
  await context.addInitScript(() => {
    // Runs in the browser; reach browser-only globals via globalThis so this
    // type-checks under the Node tsconfig without pulling in the DOM lib.
    const g = globalThis as unknown as {
      navigator: Navigator;
      chrome?: unknown;
      WebGLRenderingContext?: { prototype: { getParameter: (p: number) => unknown } };
    };
    Object.defineProperty(g.navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(g.navigator, "languages", { get: () => ["en-SG", "en"] });
    Object.defineProperty(g.navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
    });
    g.chrome = { runtime: {} };
    const proto = g.WebGLRenderingContext?.prototype;
    if (proto) {
      const getParameter = proto.getParameter;
      proto.getParameter = function (parameter: number) {
        if (parameter === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
        return getParameter.call(this, parameter);
      };
    }
  });

  // Drop image/media/font requests to cut proxy bandwidth (the single biggest
  // cost lever) and speed each poll. Stylesheets/scripts are kept so layout-based
  // visibility/enabled checks in the monitor stay reliable. Skipped when capturing
  // DOM snapshots, which need images to be meaningful.
  if (config.settings.blockHeavyAssets && !CLI_DEBUG_DOM && !config.settings.debugSnapshots) {
    const BLOCKED_TYPES = new Set(["image", "media", "font"]);
    await context.route("**/*", (route) => {
      if (BLOCKED_TYPES.has(route.request().resourceType())) {
        void route.abort();
      } else {
        void route.continue();
      }
    });
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

  // ── Authentication ───────────────────────────────────────────────────────

  try {
    const authPage = await context.newPage();
    await loadSession(context, config.settings.sessionFile, logger);

    if (!(await isLoggedIn(authPage, logger))) {
      await login(context, authPage, logger, config.settings.sessionFile);
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
    items: config.items.map((i) => i.name),
    workerStartDelayMs: config.settings.workerStartDelayMs,
  });

  const workers = config.items.map((item, index) =>
    (async () => {
      const staggerMs = index * config.settings.workerStartDelayMs;
      if (staggerMs > 0) {
        logger.info("main", "worker_startup_stagger", { item: item.name, delayMs: staggerMs });
        await startupDelay(staggerMs, controller.signal);
      }
      await runItemWorker(
        item,
        config,
        context,
        rateLimiter,
        logger,
        controller.signal,
        itemStatuses[index]!,
        runtimeStatus,
        debugDir
      );
    })()
  );

  const results = await Promise.allSettled(workers);

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
