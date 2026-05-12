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

  it("throws when checkIntervalMs is below 5000", () => {
    const bad = { ...VALID_CONFIG, settings: { checkIntervalMs: 1_000, dryRun: true } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/checkIntervalMs/i);
  });

  it("throws for unknown settings key", () => {
    const bad = { ...VALID_CONFIG, settings: { ...VALID_CONFIG.settings, unknownKey: true } };
    const file = writeTmpConfig(bad);
    expect(() => loadConfig(file)).toThrow(/unknownKey/i);
  });

  it("throws when config file does not exist", () => {
    expect(() => loadConfig("/nonexistent/path/config.json")).toThrow(/not found/i);
  });
});
