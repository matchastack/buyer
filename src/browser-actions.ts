/**
 * Low-level Playwright action wrappers.
 *
 * Each function:
 *  - Resolves a selector via the abstraction layer (never accepts raw CSS strings)
 *  - Logs every attempt at DEBUG level
 *  - Retries navigations with exponential backoff
 *  - Throws named errors on failure so callers can distinguish cause
 */

import { Page, Locator } from "playwright";
import { SelectorSet } from "./types";
import { Logger } from "./logger";
import { resolveSelector, SelectorNotFoundError } from "./selectors";

const MODULE = "browser-actions";

export { SelectorNotFoundError };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NavigationError extends Error {
  readonly cause: Error;

  constructor(url: string, cause: Error) {
    super(`Navigation to ${url} failed: ${cause.message}`);
    this.name = "NavigationError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function navigateTo(
  page: Page,
  url: string,
  logger: Logger,
  maxAttempts = 3
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.debug(MODULE, "navigate_attempt", { url, attempt, maxAttempts });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      logger.debug(MODULE, "navigate_ok", { url, attempt });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn(MODULE, "navigate_failed", { url, attempt, error: lastError.message });

      if (attempt < maxAttempts) {
        const backoffMs = 2_000 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }
    }
  }

  throw new NavigationError(url, lastError!);
}

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

export async function clickElement(
  page: Page,
  selectorSet: SelectorSet,
  logger: Logger,
  options?: { timeout?: number }
): Promise<void> {
  logger.debug(MODULE, "click_resolving", { description: selectorSet.description });

  const resolved = await resolveSelector(page, selectorSet, options?.timeout ?? 5_000);
  if (!resolved) {
    throw new SelectorNotFoundError(selectorSet.description, selectorSet.candidates);
  }

  const locator: Locator = page.locator(resolved.selector).first();
  logger.debug(MODULE, "click_attempt", {
    description: selectorSet.description,
    selector: resolved.selector,
  });

  await locator.click({ timeout: 10_000 });
  logger.debug(MODULE, "click_ok", { description: selectorSet.description });
}

// ---------------------------------------------------------------------------
// Fill input
// ---------------------------------------------------------------------------

export async function fillInput(
  page: Page,
  selectorSet: SelectorSet,
  value: string,
  logger: Logger,
  options?: { timeout?: number }
): Promise<void> {
  logger.debug(MODULE, "fill_resolving", { description: selectorSet.description });

  const resolved = await resolveSelector(page, selectorSet, options?.timeout ?? 5_000);
  if (!resolved) {
    throw new SelectorNotFoundError(selectorSet.description, selectorSet.candidates);
  }

  const locator: Locator = page.locator(resolved.selector).first();
  await locator.fill(value, { timeout: 10_000 });
  logger.debug(MODULE, "fill_ok", { description: selectorSet.description });
}

/**
 * Like fillInput, but types character-by-character with a randomized per-key
 * delay (and clears the field first) so a credential isn't filled in one
 * instantaneous DOM write. An instant sub-second login is itself a bot tell that
 * raises the odds of a post-login security challenge — this paces it like a
 * human. Still SelectorSet-only (never raw CSS); the value is never logged.
 */
export async function fillInputHumanlike(
  page: Page,
  selectorSet: SelectorSet,
  value: string,
  logger: Logger,
  options?: { timeout?: number; minDelayMs?: number; maxDelayMs?: number }
): Promise<void> {
  logger.debug(MODULE, "fill_humanlike_resolving", { description: selectorSet.description });

  const resolved = await resolveSelector(page, selectorSet, options?.timeout ?? 5_000);
  if (!resolved) {
    throw new SelectorNotFoundError(selectorSet.description, selectorSet.candidates);
  }

  const locator: Locator = page.locator(resolved.selector).first();
  await locator.click({ timeout: 10_000 });
  await locator.fill("", { timeout: 10_000 }); // clear any prefill before typing

  const minDelay = options?.minDelayMs ?? 60;
  const maxDelay = options?.maxDelayMs ?? 160;
  const delay = minDelay + Math.floor(Math.random() * Math.max(0, maxDelay - minDelay));
  await locator.pressSequentially(value, { delay, timeout: 15_000 });

  logger.debug(MODULE, "fill_humanlike_ok", { description: selectorSet.description });
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

export async function extractText(
  page: Page,
  selectorSet: SelectorSet,
  logger: Logger,
  options?: { timeout?: number }
): Promise<string | null> {
  const resolved = await resolveSelector(page, selectorSet, options?.timeout ?? 3_000);
  if (!resolved) {
    logger.debug(MODULE, "extract_text_not_found", { description: selectorSet.description });
    return null;
  }

  const locator = page.locator(resolved.selector).first();
  const text = await locator.textContent({ timeout: 5_000 }).catch(() => null);
  logger.debug(MODULE, "extract_text_ok", {
    description: selectorSet.description,
    textLength: text?.length ?? 0,
  });
  return text;
}

// ---------------------------------------------------------------------------
// Check visibility
// ---------------------------------------------------------------------------

export async function isVisible(
  page: Page,
  selectorSet: SelectorSet,
  logger: Logger,
  timeoutMs = 2_000
): Promise<boolean> {
  const resolved = await resolveSelector(page, selectorSet, timeoutMs);
  const visible = resolved !== null;
  logger.debug(MODULE, "visibility_check", {
    description: selectorSet.description,
    visible,
  });
  return visible;
}

// ---------------------------------------------------------------------------
// Wait for URL change
// ---------------------------------------------------------------------------

export async function waitForUrl(
  page: Page,
  predicate: (url: URL) => boolean,
  timeoutMs: number,
  logger: Logger
): Promise<void> {
  logger.debug(MODULE, "wait_for_url", { timeoutMs });
  await page.waitForURL(
    (url) => predicate(new URL(url.toString())),
    { timeout: timeoutMs }
  );
  logger.debug(MODULE, "wait_for_url_ok", { finalUrl: page.url() });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
