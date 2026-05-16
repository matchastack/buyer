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

import { chromium, BrowserContext } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { loadConfig, loadCredentials, loadTelegramCredentials } from "./config";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { loadSession, login, saveSession, isLoggedIn, ChallengeDetectedError } from "./auth";
import { waitForStock } from "./monitor";
import { shouldProceed, isAntiBot, computeBackoff, formatOrderSummary } from "./decision";
import { checkout } from "./checkout";
import { Item, Config, StockCheckResult } from "./types";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const CLI_DRY_RUN = args.includes("--dry-run");
const CLI_VERIFY_SELECTORS = args.includes("--verify-selectors");

// ---------------------------------------------------------------------------
// Per-item worker
// ---------------------------------------------------------------------------

async function runItemWorker(
  item: Item,
  config: Config,
  context: BrowserContext,
  rateLimiter: RateLimiter,
  logger: Logger,
  signal: AbortSignal
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
      signal
    );

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
      return;
    }

    // Checkout
    logger.info("worker", "starting_checkout", { item: item.name, price: result.price });

    const checkoutResult = await checkout(page, item, config, rateLimiter, logger);

    if (checkoutResult.success) {
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

  // Load .env if present (before config validation so env vars are available)
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }

  const config = loadConfig();

  // Override dryRun from CLI flag
  if (CLI_DRY_RUN) {
    config.settings.dryRun = true;
  }

  const logger = new Logger(config.settings.logDir);

  logger.info("main", "startup", {
    itemCount: config.items.length,
    dryRun: config.settings.dryRun,
    headless: config.settings.headless,
    checkIntervalMs: config.settings.checkIntervalMs,
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

  // ── Item workers ─────────────────────────────────────────────────────────

  logger.info("main", "workers_starting", { items: config.items.map((i) => i.name) });

  const workers = config.items.map((item) =>
    runItemWorker(item, config, context, rateLimiter, logger, controller.signal)
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
