/**
 * Config loader and validator.
 *
 * Credentials are NEVER stored in config.json.
 * Set LAZADA_EMAIL and LAZADA_PASSWORD as environment variables
 * (or in a .env file that is git-ignored).
 */

import * as fs from "fs";
import * as path from "path";
import { Config, Item, ProxySettings, Settings } from "./types";

// ---------------------------------------------------------------------------
// Credential access (env-vars only)
// ---------------------------------------------------------------------------

export interface Credentials {
  email: string;
  password: string;
}

export interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

export function loadCredentials(): Credentials {
  const email = process.env["LAZADA_EMAIL"]?.trim();
  const password = process.env["LAZADA_PASSWORD"]?.trim();

  const missing: string[] = [];
  if (!email) missing.push("LAZADA_EMAIL");
  if (!password) missing.push("LAZADA_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}.\n` +
      "Copy .env.example to .env and fill in your credentials."
    );
  }

  return { email: email!, password: password! };
}

export interface ProxyCredentials {
  server: string;   // host:port — non-secret, may come from config or env
  username: string; // secret — env only
  password: string; // secret — env only
}

/**
 * Resolves proxy settings from env vars (and an optional config-supplied server).
 *
 * Proxy is entirely OPTIONAL:
 *   - If none of server/username/password are set, returns null (run proxy-less).
 *   - If ANY are set, ALL three are required (fail fast — a half-configured
 *     proxy silently leaking your real IP is worse than no proxy).
 *
 * Username/password are env-only (PROXY_USERNAME / PROXY_PASSWORD), never in
 * config.json — same invariant as the Lazada credentials. The server (host:port)
 * is non-secret: it may come from settings.proxy.server or PROXY_SERVER.
 */
export function loadProxyCredentials(serverFromConfig?: string): ProxyCredentials | null {
  const server = serverFromConfig?.trim() || process.env["PROXY_SERVER"]?.trim();
  const username = process.env["PROXY_USERNAME"]?.trim();
  const password = process.env["PROXY_PASSWORD"]?.trim();

  if (!server && !username && !password) {
    return null; // proxy disabled
  }

  const missing: string[] = [];
  if (!server) missing.push("PROXY_SERVER (or settings.proxy.server)");
  if (!username) missing.push("PROXY_USERNAME");
  if (!password) missing.push("PROXY_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Proxy is partially configured — missing: ${missing.join(", ")}.\n` +
      "Set all three (PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD in .env), " +
      "or none to run without a proxy."
    );
  }

  return { server: server!, username: username!, password: password! };
}

export function loadTelegramCredentials(): TelegramCredentials {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const chatId = process.env["TELEGRAM_CHAT_ID"]?.trim();

  const missing: string[] = [];
  if (!botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHAT_ID");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) for Telegram approval: ${missing.join(", ")}.\n` +
      'Either set them in .env, or set "approvalMethod": "stdin" in config.json.'
    );
  }

  return { botToken: botToken!, chatId: chatId! };
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = "data";

const DEFAULTS: Settings = {
  checkIntervalMs: 15_000,
  minPageLoadDelayMs: 3_000,
  maxPageLoadDelayMs: 8_000,
  headless: false,
  maxRetries: 3,
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 30_000,
  paymentMethod: "paynow",
  dataDir: DEFAULT_DATA_DIR,
  sessionFile: path.join(DEFAULT_DATA_DIR, "session.json"),
  dryRun: true,       // Safe default — must explicitly set false to enable purchases
  logDir: path.join(DEFAULT_DATA_DIR, "logs"),
  approvalMethod: "stdin", // Safe default — terminal-based approval
  healthPort: 0,      // 0 = disabled; set to a port between 1024–65535 to enable
  debugSnapshots: false, // Enable with --debug-dom CLI flag or set true in config
  workerStartDelayMs: 0,  // 0 = no stagger; set to e.g. 5000 to stagger worker startup
  blockHeavyAssets: true, // Abort image/media/font requests to cut proxy bandwidth + speed polls
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Config validation failed: ${message}`);
    this.name = "ConfigValidationError";
  }
}

function validateItem(item: unknown, index: number): Item {
  if (typeof item !== "object" || item === null) {
    throw new ConfigValidationError(`items[${index}] must be an object`);
  }

  const obj = item as Record<string, unknown>;

  if (typeof obj["url"] !== "string" || !obj["url"].startsWith("https://")) {
    throw new ConfigValidationError(
      `items[${index}].url must be a string starting with https://`
    );
  }
  if (typeof obj["name"] !== "string" || obj["name"].trim() === "") {
    throw new ConfigValidationError(`items[${index}].name must be a non-empty string`);
  }
  if (typeof obj["maxPrice"] !== "number" || obj["maxPrice"] <= 0) {
    throw new ConfigValidationError(`items[${index}].maxPrice must be a positive number`);
  }
  const quantity = typeof obj["quantity"] === "number" ? obj["quantity"] : 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new ConfigValidationError(`items[${index}].quantity must be an integer between 1 and 10`);
  }

  const ALLOWED_ITEM_KEYS = new Set(["url", "name", "maxPrice", "quantity"]);
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ITEM_KEYS.has(key)) {
      throw new ConfigValidationError(`items[${index}] has unknown key "${key}"`);
    }
  }

  return {
    url: obj["url"] as string,
    name: obj["name"] as string,
    maxPrice: obj["maxPrice"] as number,
    quantity,
  };
}

function validateProxy(raw: unknown): ProxySettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigValidationError("settings.proxy must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // Credentials are env-only — reject them here, same as the top-level invariant.
  if ("username" in obj || "password" in obj || "user" in obj || "pass" in obj) {
    throw new ConfigValidationError(
      "Proxy credentials must not be stored in config.json. " +
      "Use the PROXY_USERNAME and PROXY_PASSWORD environment variables."
    );
  }

  const ALLOWED_PROXY_KEYS = new Set(["server", "bypass"]);
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_PROXY_KEYS.has(key)) {
      throw new ConfigValidationError(`settings.proxy has unknown key "${key}"`);
    }
  }

  if (typeof obj["server"] !== "string" || obj["server"].trim() === "") {
    throw new ConfigValidationError(
      'settings.proxy.server must be a non-empty "host:port" string'
    );
  }
  if (obj["bypass"] !== undefined && typeof obj["bypass"] !== "string") {
    throw new ConfigValidationError("settings.proxy.bypass must be a string when present");
  }

  return {
    server: (obj["server"] as string).trim(),
    ...(obj["bypass"] !== undefined ? { bypass: obj["bypass"] as string } : {}),
  };
}

function validateSettings(raw: Record<string, unknown>): Settings {
  // proxy is an optional, nested key — allowed alongside the flat DEFAULTS keys.
  const ALLOWED_SETTING_KEYS = new Set([...Object.keys(DEFAULTS), "proxy"]);

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new ConfigValidationError(`settings has unknown key "${key}"`);
    }
  }

  // Derive sessionFile and logDir from dataDir unless explicitly overridden
  const dataDir = typeof raw["dataDir"] === "string" ? raw["dataDir"] : DEFAULT_DATA_DIR;
  const merged: Settings = {
    ...DEFAULTS,
    sessionFile: path.join(dataDir, "session.json"),
    logDir: path.join(dataDir, "logs"),
    ...raw,
  } as Settings;

  if (merged.checkIntervalMs < 5_000) {
    throw new ConfigValidationError("settings.checkIntervalMs must be >= 5000ms to avoid rate-limiting");
  }
  if (merged.minPageLoadDelayMs < 1_000) {
    throw new ConfigValidationError("settings.minPageLoadDelayMs must be >= 1000ms");
  }
  if (merged.maxPageLoadDelayMs < merged.minPageLoadDelayMs) {
    throw new ConfigValidationError(
      "settings.maxPageLoadDelayMs must be >= minPageLoadDelayMs"
    );
  }
  if (merged.maxRetries < 1 || merged.maxRetries > 10) {
    throw new ConfigValidationError("settings.maxRetries must be between 1 and 10");
  }
  if (typeof merged.dryRun !== "boolean") {
    throw new ConfigValidationError("settings.dryRun must be a boolean");
  }
  if (merged.approvalMethod !== "stdin" && merged.approvalMethod !== "telegram") {
    throw new ConfigValidationError(
      'settings.approvalMethod must be "stdin" or "telegram"'
    );
  }
  if (
    !Number.isInteger(merged.healthPort) ||
    (merged.healthPort !== 0 && (merged.healthPort < 1024 || merged.healthPort > 65535))
  ) {
    throw new ConfigValidationError(
      "settings.healthPort must be 0 (disabled) or an integer between 1024 and 65535"
    );
  }
  if (typeof merged.debugSnapshots !== "boolean") {
    throw new ConfigValidationError("settings.debugSnapshots must be a boolean");
  }
  if (typeof merged.blockHeavyAssets !== "boolean") {
    throw new ConfigValidationError("settings.blockHeavyAssets must be a boolean");
  }
  const proxy = validateProxy(raw["proxy"]);
  if (proxy) merged.proxy = proxy;
  else delete merged.proxy;
  if (
    typeof merged.workerStartDelayMs !== "number" ||
    !Number.isFinite(merged.workerStartDelayMs) ||
    merged.workerStartDelayMs < 0
  ) {
    throw new ConfigValidationError("settings.workerStartDelayMs must be a non-negative number");
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export function loadConfig(configPath?: string): Config {
  const resolvedPath = configPath ?? path.join(process.cwd(), "config.json");

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found at ${resolvedPath}.\n` +
      "Copy config.example.json to config.json and edit it."
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  } catch (err) {
    throw new ConfigValidationError(`Could not parse JSON: ${(err as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new ConfigValidationError("Config root must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  // Reject top-level credential keys left in config.json
  if ("credentials" in obj || "email" in obj || "password" in obj) {
    throw new ConfigValidationError(
      "Credentials must not be stored in config.json. " +
      "Use the LAZADA_EMAIL and LAZADA_PASSWORD environment variables."
    );
  }

  const ALLOWED_TOP_KEYS = new Set(["items", "settings"]);
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new ConfigValidationError(`Unknown top-level key "${key}"`);
    }
  }

  if (!Array.isArray(obj["items"]) || obj["items"].length === 0) {
    throw new ConfigValidationError("items must be a non-empty array");
  }

  const items: Item[] = (obj["items"] as unknown[]).map((item, i) =>
    validateItem(item, i)
  );

  const settings = validateSettings(
    typeof obj["settings"] === "object" && obj["settings"] !== null
      ? (obj["settings"] as Record<string, unknown>)
      : {}
  );

  return { items, settings };
}
