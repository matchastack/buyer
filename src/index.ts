import { chromium, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { Config, Item } from "./types";
import { login, loadSession, saveSession, isLoggedIn } from "./auth";
import { waitForStock } from "./monitor";
import { buyItem } from "./checkout";

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[main] config.json not found at ${CONFIG_PATH}`);
    console.error("[main] Copy config.example.json to config.json and fill in your details.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Config;
}

async function processItem(
  context: BrowserContext,
  item: Item,
  config: Config
): Promise<void> {
  const page: Page = await context.newPage();

  try {
    const signal = { stop: false };

    // Handle Ctrl+C gracefully
    const cleanup = () => {
      signal.stop = true;
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    // Wait until stock is available
    const result = await waitForStock(page, item, config.settings.checkIntervalMs, signal);

    if (result.status !== "available") {
      console.log(`[main] Stopped watching "${item.name}".`);
      return;
    }

    // Attempt purchase
    const success = await buyItem(page, item, config.settings);

    if (success) {
      console.log(`[main] Successfully purchased "${item.name}"!`);
      // Persist updated session (auth tokens may have refreshed)
      await saveSession(context, config.settings.sessionFile);
    } else {
      console.error(`[main] Failed to purchase "${item.name}" after ${config.settings.maxRetries} attempts.`);
    }
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.items || config.items.length === 0) {
    console.error("[main] No items specified in config.json.");
    process.exit(1);
  }

  console.log(`[main] Starting Pokemon Center buyer — monitoring ${config.items.length} item(s).`);

  const browser = await chromium.launch({
    headless: config.settings.headless ?? false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-SG",
    timezoneId: "Asia/Singapore",
  });

  // Load saved session (avoids re-login on every run)
  const sessionLoaded = await loadSession(context, config.settings.sessionFile);

  // Verify login status using a temporary page
  const authPage = await context.newPage();
  const loggedIn = sessionLoaded ? await isLoggedIn(authPage) : false;

  if (!loggedIn) {
    await login(context, authPage, config.credentials, config.settings.sessionFile);
  } else {
    console.log("[main] Session is valid — skipping login.");
  }

  await authPage.close();

  // Monitor all items concurrently (each gets its own page)
  try {
    await Promise.all(
      config.items.map((item) => processItem(context, item, config))
    );
  } finally {
    console.log("[main] All items processed. Closing browser.");
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
