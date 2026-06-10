/**
 * Authentication module.
 *
 * - Credentials are loaded from env vars only (via config.ts::loadCredentials).
 * - Session cookies persisted to disk with mode 0o600.
 * - Detects anti-bot challenges and halts instead of waiting/retrying.
 * - Never bypasses CAPTCHA, MFA, or rate limits.
 */

import { BrowserContext, Page } from "playwright";
import * as fs from "fs";
import { Logger } from "./logger";
import { loadCredentials } from "./config";
import { SELECTORS } from "./selectors";
import { resolveSelector } from "./selectors";
import { fillInput, clickElement, waitForUrl } from "./browser-actions";
import { captureNamedSnapshot } from "./diagnostics";

const MODULE = "auth";
const LOGIN_URL = "https://www.lazada.sg/customer/account/login/";
const HOME_URL = "https://www.lazada.sg/";

// ---------------------------------------------------------------------------
// Challenge detection
// ---------------------------------------------------------------------------

export interface Challenge {
  type: "captcha" | "slider" | "mfa" | "unknown";
  url: string;
  detectedAt: string;
}

export class ChallengeDetectedError extends Error {
  readonly challenge: Challenge;

  constructor(challenge: Challenge) {
    super(
      `Anti-bot challenge detected (${challenge.type}) at ${challenge.url}. ` +
      "The script cannot proceed automatically. " +
      "Please resolve it manually or clear your session and try again."
    );
    this.name = "ChallengeDetectedError";
    this.challenge = challenge;
  }
}

export async function detectChallenge(
  page: Page,
  logger: Logger
): Promise<Challenge | null> {
  const url = page.url();

  // URL-based detection (Lazada/Alibaba bot-challenge pages use known paths)
  if (
    url.includes("/baxia/") ||
    url.includes("/block") ||
    url.includes("/robot") ||
    url.includes("captcha") ||
    url.includes("/cdn-cgi/challenge-platform/") ||
    url.includes("/awswaf/") ||
    url.includes("/sec/")
  ) {
    const challenge: Challenge = { type: "captcha", url, detectedAt: new Date().toISOString() };
    logger.warn(MODULE, "challenge_detected_url", { url, type: challenge.type });
    return challenge;
  }

  // DOM-based detection
  const captchaFound = await resolveSelector(page, SELECTORS.antiBot.captchaFrame, 1_500)
    .then((r) => r !== null)
    .catch(() => false);

  if (captchaFound) {
    const challenge: Challenge = { type: "captcha", url, detectedAt: new Date().toISOString() };
    logger.warn(MODULE, "challenge_detected_dom", { url });
    return challenge;
  }

  const rateLimitFound = await resolveSelector(page, SELECTORS.antiBot.rateLimitMessage, 1_000)
    .then((r) => r !== null)
    .catch(() => false);

  if (rateLimitFound) {
    const challenge: Challenge = { type: "unknown", url, detectedAt: new Date().toISOString() };
    logger.warn(MODULE, "rate_limit_page_detected", { url });
    return challenge;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Login state check
// ---------------------------------------------------------------------------

export async function isLoggedIn(page: Page, logger: Logger): Promise<boolean> {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });

  const challenge = await detectChallenge(page, logger);
  if (challenge) throw new ChallengeDetectedError(challenge);

  // Give the header (account menu / login link) a moment to render — the nav is
  // JS-rendered and the visibility checks below are instantaneous.
  await page
    .locator(
      [
        ...SELECTORS.login.loggedInIndicator.candidates,
        ...SELECTORS.login.loginLink.candidates,
      ].join(", ")
    )
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {
      /* neither rendered — fall through to the ambiguous case below */
    });

  // Positive signal: an account/avatar affordance means we ARE logged in.
  const loggedInMarker = await resolveSelector(page, SELECTORS.login.loggedInIndicator, 2_000)
    .then((r) => r !== null)
    .catch(() => false);

  // Negative signal: a login link/button means we are NOT.
  const loginMarker = await resolveSelector(page, SELECTORS.login.loginLink, 2_000)
    .then((r) => r !== null)
    .catch(() => false);

  let loggedIn: boolean;
  if (loginMarker) {
    // A visible login affordance is the most reliable "logged out" signal.
    loggedIn = false;
  } else if (loggedInMarker) {
    loggedIn = true;
  } else {
    // Neither matched. Fail toward logged-out so we attempt a fresh login rather
    // than proceeding on a possibly-dead session — the old false-positive bug,
    // where a stale login-link selector silently reported "logged in".
    logger.warn(MODULE, "login_state_ambiguous_assuming_logged_out", { url: page.url() });
    loggedIn = false;
  }

  logger.info(MODULE, "login_state_check", { loggedIn, loggedInMarker, loginMarker });
  return loggedIn;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * When provided, every login step is logged, snapshotted to `snapshotDir`, and
 * paused for `pauseMs` so the flow can be observed in a headed browser.
 */
export interface AuthDebugOptions {
  snapshotDir: string;
  pauseMs: number;
}

/** Logs a named login step and, in debug mode, snapshots the page + pauses. */
async function authStep(
  page: Page,
  step: string,
  logger: Logger,
  debug?: AuthDebugOptions
): Promise<void> {
  logger.info(MODULE, "auth_step", { step });
  if (!debug) return;
  await captureNamedSnapshot(page, step, debug.snapshotDir, logger);
  if (debug.pauseMs > 0) await page.waitForTimeout(debug.pauseMs);
}

export async function login(
  context: BrowserContext,
  page: Page,
  logger: Logger,
  sessionFile: string,
  debug?: AuthDebugOptions
): Promise<void> {
  if (await isLoggedIn(page, logger)) {
    logger.info(MODULE, "already_logged_in");
    return;
  }

  const credentials = loadCredentials();

  logger.info(MODULE, "login_start");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });

  const challenge = await detectChallenge(page, logger);
  if (challenge) throw new ChallengeDetectedError(challenge);

  await authStep(page, "01-login-page", logger, debug);

  // Switch to email login tab if present (Lazada defaults to phone login)
  const emailTab = await resolveSelector(page, SELECTORS.login.emailLoginTab, 3_000);
  if (emailTab) {
    await page.locator(emailTab.selector).first().click();
    await page.waitForTimeout(500);
    await authStep(page, "02-email-tab-selected", logger, debug);
  }

  await fillInput(page, SELECTORS.login.emailInput, credentials.email, logger);
  logger.info(MODULE, "email_filled"); // value never logged
  await authStep(page, "03-email-filled", logger, debug);

  await fillInput(page, SELECTORS.login.passwordInput, credentials.password, logger);
  logger.info(MODULE, "password_filled"); // value never logged
  await authStep(page, "04-password-filled", logger, debug);

  // Overwrite credential references immediately
  (credentials as { email: string; password: string }).password = "";

  await clickElement(page, SELECTORS.login.submitButton, logger);

  logger.info(MODULE, "login_submitted");
  await authStep(page, "05-after-submit", logger, debug);

  // Wait for navigation away from the login page
  try {
    await waitForUrl(
      page,
      (url) => !url.pathname.includes("/login"),
      20_000,
      logger
    );
  } catch {
    // Check for post-submit challenge (e.g. SMS OTP)
    const postChallenge = await detectChallenge(page, logger);
    if (postChallenge) throw new ChallengeDetectedError(postChallenge);

    if (page.url().includes("/login")) {
      await authStep(page, "06-login-stuck", logger, debug);
      throw new Error(
        "Login did not complete — still on login page. " +
        "Check your credentials or look for an OTP prompt in the browser."
      );
    }
  }

  logger.info(MODULE, "login_success");
  await authStep(page, "06-post-login", logger, debug);
  await saveSession(context, sessionFile, logger);
}

/**
 * Observable login flow for debugging authentication. Clears cookies to force a
 * full logged-out login, runs `login` with per-step snapshots + pauses, then
 * confirms the logged-in homepage renders. Intended for headed use via
 * `--auth-debug`. Never logs credential values.
 */
export async function runAuthDebug(
  context: BrowserContext,
  page: Page,
  logger: Logger,
  sessionFile: string,
  snapshotDir: string,
  pauseMs: number
): Promise<boolean> {
  logger.info(MODULE, "auth_debug_start", { snapshotDir, pauseMs });

  // Force a clean logged-out state so the whole login is observable.
  await context.clearCookies();
  logger.info(MODULE, "auth_debug_cookies_cleared");

  await login(context, page, logger, sessionFile, { snapshotDir, pauseMs });

  // Confirm the homepage now renders in a logged-in state.
  const loggedIn = await isLoggedIn(page, logger);
  await captureNamedSnapshot(page, "07-homepage-rendered", snapshotDir, logger);
  logger.info(MODULE, "auth_debug_complete", { loggedIn });
  return loggedIn;
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export async function loadSession(
  context: BrowserContext,
  sessionFile: string,
  logger: Logger
): Promise<boolean> {
  if (!fs.existsSync(sessionFile)) {
    logger.debug(MODULE, "session_file_not_found", { sessionFile });
    return false;
  }

  try {
    const raw = fs.readFileSync(sessionFile, "utf-8");
    const parsed = JSON.parse(raw) as { cookies?: unknown[] };

    if (!Array.isArray(parsed.cookies)) {
      logger.warn(MODULE, "session_file_invalid", { sessionFile });
      return false;
    }

    await context.addCookies(parsed.cookies as Parameters<typeof context.addCookies>[0]);
    logger.info(MODULE, "session_loaded", { sessionFile, cookieCount: parsed.cookies.length });
    return true;
  } catch (err) {
    logger.warn(MODULE, "session_load_failed", { sessionFile, error: (err as Error).message });
    return false;
  }
}

export async function saveSession(
  context: BrowserContext,
  sessionFile: string,
  logger: Logger
): Promise<void> {
  try {
    const cookies = await context.cookies();
    const data = JSON.stringify({ cookies }, null, 2);
    fs.writeFileSync(sessionFile, data, { encoding: "utf-8", mode: 0o600 });
    logger.info(MODULE, "session_saved", { sessionFile, cookieCount: cookies.length });
  } catch (err) {
    logger.error(MODULE, "session_save_failed", { sessionFile, error: (err as Error).message });
  }
}
