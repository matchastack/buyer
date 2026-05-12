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
    url.includes("captcha")
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

  // If the login link is visible, we are NOT logged in
  const loginLinkVisible = await resolveSelector(
    page,
    {
      description: "Login link in site header (visible = logged OUT)",
      candidates: ['a[href*="/customer/account/login"]', 'a:has-text("Log In")'],
      required: false,
    },
    3_000
  ).then((r) => r !== null);

  const loggedIn = !loginLinkVisible;
  logger.info(MODULE, "login_state_check", { loggedIn });
  return loggedIn;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(
  context: BrowserContext,
  page: Page,
  logger: Logger,
  sessionFile: string
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

  // Switch to email login tab if present (Lazada defaults to phone login)
  const emailTab = await resolveSelector(page, SELECTORS.login.emailLoginTab, 3_000);
  if (emailTab) {
    await page.locator(emailTab.selector).first().click();
    await page.waitForTimeout(500);
  }

  await fillInput(page, SELECTORS.login.emailInput, credentials.email, logger);
  await fillInput(page, SELECTORS.login.passwordInput, credentials.password, logger);

  // Overwrite credential references immediately
  (credentials as { email: string; password: string }).password = "";

  await clickElement(page, SELECTORS.login.submitButton, logger);

  logger.info(MODULE, "login_submitted");

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
      throw new Error(
        "Login did not complete — still on login page. " +
        "Check your credentials or look for an OTP prompt in the browser."
      );
    }
  }

  logger.info(MODULE, "login_success");
  await saveSession(context, sessionFile, logger);
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
