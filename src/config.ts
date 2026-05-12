/**
 * Config loader and validator.
 *
 * Credentials are NEVER stored in config.json.
 * Set LAZADA_EMAIL and LAZADA_PASSWORD as environment variables
 * (or in a .env file that is git-ignored).
 */

import * as fs from "fs";
import * as path from "path";
import { Config, Item, Settings } from "./types";

// ---------------------------------------------------------------------------
// Credential access (env-vars only)
// ---------------------------------------------------------------------------

export interface Credentials {
  email: string;
  password: string;
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

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Settings = {
  checkIntervalMs: 15_000,
  minPageLoadDelayMs: 3_000,
  maxPageLoadDelayMs: 8_000,
  headless: false,
  maxRetries: 3,
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 30_000,
  paymentMethod: "credit_card",
  sessionFile: "session.json",
  dryRun: true,       // Safe default — must explicitly set false to enable purchases
  logDir: "logs",
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

function validateSettings(raw: Record<string, unknown>): Settings {
  const ALLOWED_SETTING_KEYS = new Set(Object.keys(DEFAULTS));

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      throw new ConfigValidationError(`settings has unknown key "${key}"`);
    }
  }

  const merged: Settings = { ...DEFAULTS, ...raw } as Settings;

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
