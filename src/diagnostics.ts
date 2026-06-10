/**
 * DOM-capture diagnostics for debugging stock detection.
 *
 * Enabled with --debug-dom CLI flag or "debugSnapshots": true in config.
 * Writes full-page screenshots and HTML to <dataDir>/debug/ so selector
 * issues can be diagnosed from the real Lazada page structure.
 */

import * as fs from "fs";
import * as path from "path";
import { Page } from "playwright";
import { Item } from "./types";
import { Logger } from "./logger";
import { SELECTORS } from "./selectors";

const MODULE = "diagnostics";

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
}

/**
 * Saves a full-page screenshot (.png) and full HTML (.html) to debugDir.
 * Errors are swallowed — diagnostics must never crash the main process.
 */
export async function captureDomSnapshot(
  page: Page,
  item: Item,
  debugDir: string,
  logger: Logger
): Promise<void> {
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(debugDir, `${sanitizeName(item.name)}-${ts}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(`${base}.html`, html, "utf-8");

    logger.info(MODULE, "dom_snapshot_saved", { item: item.name, base });
  } catch (err) {
    logger.warn(MODULE, "dom_snapshot_failed", {
      item: item.name,
      error: (err as Error).message,
    });
  }
}

/**
 * For every selector set in SELECTORS.product, finds the first matching
 * candidate (if any) and logs how many elements it matches plus the first
 * element's text, visibility, and enabled state.
 *
 * The matchCount is the most important field: 1 = likely the real element;
 * >1 = the selector is hitting multiple places (e.g. recommendation carousels).
 */
export async function describeProductSelectors(
  page: Page,
  logger: Logger
): Promise<void> {
  const report: Record<string, unknown> = {};

  for (const [key, selectorSet] of Object.entries(SELECTORS.product)) {
    let winner: string | null = null;
    let matchCount = 0;
    let firstText: string | null = null;
    let firstVisible: boolean | null = null;
    let firstEnabled: boolean | null = null;

    for (const candidate of selectorSet.candidates) {
      try {
        const locator = page.locator(candidate);
        const count = await locator.count();
        if (count > 0) {
          const first = locator.first();
          winner = candidate;
          matchCount = count;
          firstText = await first.textContent({ timeout: 2_000 }).catch(() => null);
          firstVisible = await first.isVisible({ timeout: 2_000 }).catch(() => null);
          firstEnabled = await first.isEnabled({ timeout: 2_000 }).catch(() => null);
          break;
        }
      } catch {
        // ignore — try next candidate
      }
    }

    report[key] = { winner, matchCount, firstText: firstText?.trim().slice(0, 80), firstVisible, firstEnabled };
  }

  logger.info(MODULE, "product_selector_report", report);
}
