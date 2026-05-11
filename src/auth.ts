import { BrowserContext, Page } from "playwright";
import * as fs from "fs";
import { Credentials } from "./types";

const LOGIN_URL = "https://www.lazada.sg/customer/account/login/";
const HOME_URL = "https://www.lazada.sg/";

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  // Lazada shows account icon or username when logged in; "Log In" link means logged out
  const logInLink = page.locator('a[href*="/customer/account/login"]');
  return !(await logInLink.isVisible({ timeout: 5000 }).catch(() => false));
}

export async function login(
  context: BrowserContext,
  page: Page,
  credentials: Credentials,
  sessionFile: string
): Promise<void> {
  if (await isLoggedIn(page)) {
    console.log("[auth] Already logged in.");
    return;
  }

  console.log("[auth] Navigating to login page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Lazada login page has a tab for email — click it to ensure we're on the right form
  const emailTab = page.locator('span:has-text("Log in with Email"), button:has-text("Log in with Email")');
  if (await emailTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await emailTab.click();
  }

  await page.locator('input[name="loginName"], input[type="email"]').fill(credentials.email);
  await page.locator('input[name="password"], input[type="password"]').fill(credentials.password);
  await page.locator('button[type="submit"]:has-text("Log In"), button[data-spm-click*="login"]').first().click();

  // Wait for navigation away from login page (or account element to appear)
  try {
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 15000 });
    console.log("[auth] Login succeeded.");
  } catch {
    // If still on login page, there may be a CAPTCHA or OTP — wait for user to resolve
    if (page.url().includes("/login")) {
      console.warn("[auth] Still on login page. Please resolve any CAPTCHA or OTP manually. Waiting up to 60s...");
      await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 60000 });
    }
  }

  await saveSession(context, sessionFile);
  console.log("[auth] Session saved.");
}

export async function loadSession(context: BrowserContext, sessionFile: string): Promise<boolean> {
  if (!fs.existsSync(sessionFile)) return false;
  try {
    const raw = fs.readFileSync(sessionFile, "utf-8");
    const state = JSON.parse(raw);
    await context.addCookies(state.cookies ?? []);
    console.log("[auth] Session loaded from disk.");
    return true;
  } catch {
    return false;
  }
}

export async function saveSession(context: BrowserContext, sessionFile: string): Promise<void> {
  const cookies = await context.cookies();
  fs.writeFileSync(sessionFile, JSON.stringify({ cookies }, null, 2));
}
