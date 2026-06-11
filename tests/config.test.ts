import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We test the exported functions directly — import after env manipulation
let loadConfig: typeof import("../src/config").loadConfig;
let loadCredentials: typeof import("../src/config").loadCredentials;

async function freshImport() {
  vi.resetModules();
  const mod = await import("../src/config");
  loadConfig = mod.loadConfig;
  loadCredentials = mod.loadCredentials;
}

describe("loadCredentials", () => {
  const ORIG_EMAIL = process.env["LAZADA_EMAIL"];
  const ORIG_PASS = process.env["LAZADA_PASSWORD"];

  beforeEach(async () => {
    delete process.env["LAZADA_EMAIL"];
    delete process.env["LAZADA_PASSWORD"];
    await freshImport();
  });

  afterEach(() => {
    if (ORIG_EMAIL !== undefined) process.env["LAZADA_EMAIL"] = ORIG_EMAIL;
    else delete process.env["LAZADA_EMAIL"];
    if (ORIG_PASS !== undefined) process.env["LAZADA_PASSWORD"] = ORIG_PASS;
    else delete process.env["LAZADA_PASSWORD"];
  });

  it("throws when LAZADA_EMAIL is missing", () => {
    process.env["LAZADA_PASSWORD"] = "secret";
    expect(() => loadCredentials()).toThrow(/LAZADA_EMAIL/);
  });

  it("throws when LAZADA_PASSWORD is missing", () => {
    process.env["LAZADA_EMAIL"] = "user@example.com";
    expect(() => loadCredentials()).toThrow(/LAZADA_PASSWORD/);
  });

  it("throws when both env vars are missing", () => {
    expect(() => loadCredentials()).toThrow(/LAZADA_EMAIL/);
  });

  it("throws when LAZADA_EMAIL is an empty string", () => {
    process.env["LAZADA_EMAIL"] = "   ";
    process.env["LAZADA_PASSWORD"] = "secret";
    expect(() => loadCredentials()).toThrow(/LAZADA_EMAIL/);
  });

  it("throws when LAZADA_PASSWORD is an empty string", () => {
    process.env["LAZADA_EMAIL"] = "user@example.com";
    process.env["LAZADA_PASSWORD"] = "";
    expect(() => loadCredentials()).toThrow(/LAZADA_PASSWORD/);
  });

  it("returns credentials when both env vars are set", () => {
    process.env["LAZADA_EMAIL"] = "user@example.com";
    process.env["LAZADA_PASSWORD"] = "secret";
    const creds = loadCredentials();
    expect(creds.email).toBe("user@example.com");
    expect(creds.password).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  items: [
    {
      url: "https://www.lazada.sg/products/pikachu-i12345.html",
      name: "Pikachu Plush",
      maxPrice: 49.9,
      quantity: 1,
    },
  ],
  settings: {
    dryRun: true,
    checkIntervalMs: 10_000,
  },
};

function writeTmpConfig(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-test-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("loadConfig", () => {
  beforeEach(async () => {
    await freshImport();
  });

  it("parses a valid config and returns typed object", () => {
    const file = writeTmpConfig(VALID_CONFIG);
    const config = loadConfig(file);
    expect(config.items).toHaveLength(1);
    expect(config.items[0]!.name).toBe("Pikachu Plush");
    expect(config.settings.dryRun).toBe(true);
  });

  it("defaults dryRun to true when not specified", () => {
    const noRun = { ...VALID_CONFIG, settings: {} };
    const file = writeTmpConfig(noRun);
    const config = loadConfig(file);
    expect(config.settings.dryRun).toBe(true);
  });

  it("defaults paymentMethod to paynow when not specified", () => {
    const file = writeTmpConfig({ ...VALID_CONFIG, settings: {} });
    const config = loadConfig(file);
    expect(config.settings.paymentMethod).toBe("paynow");
  });

  it("throws when items array is empty", () => {
    const file = writeTmpConfig({ ...VALID_CONFIG, items: [] });
    expect(() => loadConfig(file)).toThrow(/items/i);
  });

  it("throws when items is missing", () => {
    const file = writeTmpConfig({ settings: {} });
    expect(() => loadConfig(file)).toThrow(/items/i);
  });

  it("throws on an unknown top-level key", () => {
    const file = writeTmpConfig({ ...VALID_CONFIG, credentials: { email: "x" } });
    expect(() => loadConfig(file)).toThrow(/credentials/i);
  });

  it("throws when an item URL is not https://", () => {
    const bad = {
      ...VALID_CONFIG,
      items: [{ ...VALID_CONFIG.items[0], url: "http://www.lazada.sg/products/x.html" }],
    };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/url/i);
  });

  it("throws when maxPrice is zero", () => {
    const bad = {
      ...VALID_CONFIG,
      items: [{ ...VALID_CONFIG.items[0], maxPrice: 0 }],
    };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/maxPrice/i);
  });

  it("throws when quantity exceeds 10", () => {
    const bad = {
      ...VALID_CONFIG,
      items: [{ ...VALID_CONFIG.items[0], quantity: 11 }],
    };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/quantity/i);
  });

  it("throws when checkIntervalMs is below 1000", () => {
    const bad = { ...VALID_CONFIG, settings: { checkIntervalMs: 500, dryRun: true } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/checkIntervalMs/i);
  });

  it("accepts an aggressive checkIntervalMs at the 1000ms floor", () => {
    const cfg = { ...VALID_CONFIG, settings: { checkIntervalMs: 1_000, dryRun: true } };
    const file = writeTmpConfig(cfg);
    expect(loadConfig(file).settings.checkIntervalMs).toBe(1_000);
  });

  it("defaults pollSettleMs when not specified", () => {
    const file = writeTmpConfig(VALID_CONFIG);
    expect(loadConfig(file).settings.pollSettleMs).toBeGreaterThan(0);
  });

  it("accepts pollSettleMs = 0 (skip settle entirely)", () => {
    const cfg = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, pollSettleMs: 0 } };
    const file = writeTmpConfig(cfg);
    expect(loadConfig(file).settings.pollSettleMs).toBe(0);
  });

  it("throws when pollSettleMs is negative", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, pollSettleMs: -1 } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/pollSettleMs/i);
  });

  it("throws when minPageLoadDelayMs is below 250", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, minPageLoadDelayMs: 100 } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/minPageLoadDelayMs/i);
  });

  it("defaults monitorMode to per-item", () => {
    const file = writeTmpConfig(VALID_CONFIG);
    expect(loadConfig(file).settings.monitorMode).toBe("per-item");
  });

  it("throws on an invalid monitorMode", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, monitorMode: "both" } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/monitorMode/i);
  });

  it("throws when wishlistUrl is not https", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, wishlistUrl: "http://x" } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/wishlistUrl/i);
  });

  it("defaults loginUrl to the member.lazada.sg login page", () => {
    const file = writeTmpConfig(VALID_CONFIG);
    expect(loadConfig(file).settings.loginUrl).toBe("https://member.lazada.sg/user/login");
  });

  it("throws when loginUrl is not https", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, loginUrl: "ftp://x" } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/loginUrl/i);
  });

  it("throws when buyRetryMaxMs is below buyRetryBaseMs", () => {
    const bad = {
      ...VALID_CONFIG,
      settings: { ...VALID_CONFIG.settings, buyRetryBaseMs: 1000, buyRetryMaxMs: 500 },
    };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/buyRetryMaxMs/i);
  });

  it("accepts wishlist mode when every item URL has a product id", () => {
    const cfg = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, monitorMode: "wishlist" } };
    const file = writeTmpConfig(cfg);
    expect(loadConfig(file).settings.monitorMode).toBe("wishlist");
  });

  it("throws in wishlist mode when an item URL has no extractable product id", () => {
    const bad = {
      items: [{ url: "https://www.lazada.sg/shop/pokemon-store", name: "No Id", maxPrice: 10, quantity: 1 }],
      settings: { dryRun: true, monitorMode: "wishlist" },
    };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/product id/i);
  });

  it("throws for unknown settings key", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, unknownKey: true } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/unknownKey/i);
  });

  it("throws when config file does not exist", () => {
    expect(() => loadConfig("/nonexistent/path/config.json")).toThrow(/not found/i);
  });

  it("defaults healthPort to 0 when not specified", () => {
    const file = writeTmpConfig(VALID_CONFIG);
    const config = loadConfig(file);
    expect(config.settings.healthPort).toBe(0);
  });

  it("accepts healthPort = 0 (disabled)", () => {
    const cfg = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, healthPort: 0 } };
    const file = writeTmpConfig(cfg);
    const config = loadConfig(file);
    expect(config.settings.healthPort).toBe(0);
  });

  it("accepts a valid healthPort in the 1024–65535 range", () => {
    const cfg = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, healthPort: 8080 } };
    const file = writeTmpConfig(cfg);
    const config = loadConfig(file);
    expect(config.settings.healthPort).toBe(8080);
  });

  it("throws when healthPort is below 1024", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, healthPort: 80 } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/healthPort/i);
  });

  it("throws when healthPort exceeds 65535", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, healthPort: 70000 } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/healthPort/i);
  });

  it("throws when healthPort is a non-integer number", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, healthPort: 8080.5 } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/healthPort/i);
  });
});
