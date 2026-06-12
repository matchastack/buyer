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
import { isChallengeUrl } from "./decision";
import { SELECTORS } from "./selectors";
import { resolveSelector } from "./selectors";
import { fillInputHumanlike, clickElement, waitForUrl } from "./browser-actions";
import { captureNamedSnapshot } from "./diagnostics";

const MODULE = "auth";
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

  // URL-based detection (Lazada/Alibaba bot-challenge pages use known paths —
  // pattern list lives in decision.isChallengeUrl so it is unit-testable)
  if (isChallengeUrl(url)) {
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
    // Neither matched — genuinely ambiguous. Before concluding logged-out (which
    // forces a fresh login, the exact event that risks an MF01 challenge), give
    // the header one more chance: a transient slow render or proxy hiccup
    // shouldn't cost a re-login. This is strictly additive — it still requires a
    // POSITIVE loggedIn marker to return true, so it can't resurrect the old
    // false-positive where absence of a login link was read as "logged in".
    const retry = await recheckLoginMarkers(page, logger);
    if (retry === "logged_in") {
      loggedIn = true;
    } else if (retry === "logged_out") {
      loggedIn = false;
    } else {
      // Still ambiguous after the retry. Fail toward logged-out so we attempt a
      // fresh login rather than proceeding on a possibly-dead session.
      logger.warn(MODULE, "login_state_ambiguous_assuming_logged_out", { url: page.url() });
      loggedIn = false;
    }
  }

  logger.info(MODULE, "login_state_check", { loggedIn, loggedInMarker, loginMarker });
  return loggedIn;
}

/**
 * One extra pass at the header markers after a short settle, used only when the
 * first check was ambiguous (neither marker visible). Returns "logged_in" only on
 * a positive account marker, "logged_out" on a positive login link, or
 * "ambiguous" if still neither — never infers state from absence.
 */
async function recheckLoginMarkers(
  page: Page,
  logger: Logger
): Promise<"logged_in" | "logged_out" | "ambiguous"> {
  await page.waitForTimeout(1_000);
  await page
    .locator(
      [
        ...SELECTORS.login.loggedInIndicator.candidates,
        ...SELECTORS.login.loginLink.candidates,
      ].join(", ")
    )
    .first()
    .waitFor({ state: "visible", timeout: 4_000 })
    .catch(() => {});

  const loggedInMarker = await resolveSelector(page, SELECTORS.login.loggedInIndicator, 2_000)
    .then((r) => r !== null)
    .catch(() => false);
  const loginMarker = await resolveSelector(page, SELECTORS.login.loginLink, 2_000)
    .then((r) => r !== null)
    .catch(() => false);

  logger.info(MODULE, "login_state_recheck", { loggedInMarker, loginMarker });
  if (loginMarker) return "logged_out";
  if (loggedInMarker) return "logged_in";
  return "ambiguous";
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

/** Randomized pause (ms) to make the login cadence look human. Non-crypto jitter. */
async function humanPause(page: Page, minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs));
  await page.waitForTimeout(ms);
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
  loginUrl: string,
  debug?: AuthDebugOptions
): Promise<void> {
  if (await isLoggedIn(page, logger)) {
    logger.info(MODULE, "already_logged_in");
    return;
  }

  const credentials = loadCredentials();

  logger.info(MODULE, "login_start", { loginUrl });
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

  const challenge = await detectChallenge(page, logger);
  if (challenge) throw new ChallengeDetectedError(challenge);

  await authStep(page, "01-login-page", logger, debug);

  // Switch to email login tab if present (Lazada defaults to phone login)
  const emailTab = await resolveSelector(page, SELECTORS.login.emailLoginTab, 3_000);
  if (emailTab) {
    await page.locator(emailTab.selector).first().click();
    await humanPause(page, 400, 900);
    await authStep(page, "02-email-tab-selected", logger, debug);
  }

  // Human-like pacing: type the credentials key-by-key with randomized pauses
  // between fields. A login submitted in well under a second is itself a bot tell
  // that raises the post-login security-challenge (MF01) odds.
  await fillInputHumanlike(page, SELECTORS.login.emailInput, credentials.email, logger);
  logger.info(MODULE, "email_filled"); // value never logged
  await authStep(page, "03-email-filled", logger, debug);
  await humanPause(page, 300, 800);

  await fillInputHumanlike(page, SELECTORS.login.passwordInput, credentials.password, logger);
  logger.info(MODULE, "password_filled"); // value never logged
  await authStep(page, "04-password-filled", logger, debug);

  // Overwrite credential references immediately
  (credentials as { email: string; password: string }).password = "";

  // Settle before submit, as a human would after typing a password.
  await humanPause(page, 600, 1_200);
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
  loginUrl: string,
  snapshotDir: string,
  pauseMs: number
): Promise<boolean> {
  logger.info(MODULE, "auth_debug_start", { loginUrl, snapshotDir, pauseMs });

  // Force a logged-out state so the whole login is observable. This clears the
  // cookie-based session (enough to log out); the persistent profile's
  // device-trust localStorage is intentionally kept, so the observed login is a
  // normal verified-device login rather than a brand-new-device one.
  await context.clearCookies();
  logger.info(MODULE, "auth_debug_cookies_cleared");

  await login(context, page, logger, sessionFile, loginUrl, { snapshotDir, pauseMs });

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
