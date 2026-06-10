import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AuditEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Setup: mock fs so we never touch the real filesystem
// ---------------------------------------------------------------------------

// We spy at the module level — vi.spyOn before importing Logger so that the
// module picks up the mocked methods at construction time.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),       // pretend logDir already exists
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

// Import Logger AFTER the mock is in place
import { Logger } from "../src/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Grab the last line written by appendFileSync and parse it as JSON. */
function lastEntry(): AuditEntry {
  const mock = vi.mocked(fs.appendFileSync);
  const calls = mock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1];
  const line = lastCall[1] as string;
  return JSON.parse(line.trimEnd());
}

/** Grab all written lines as parsed AuditEntry objects. */
function allEntries(): AuditEntry[] {
  const mock = vi.mocked(fs.appendFileSync);
  return mock.mock.calls.map((c) => JSON.parse((c[1] as string).trimEnd()));
}

const TEST_LOG_DIR = "/tmp/test-logs";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Logger", () => {
  let logger: Logger;

  beforeEach(() => {
    vi.mocked(fs.appendFileSync).mockClear();
    logger = new Logger(TEST_LOG_DIR, "info");
  });

  afterEach(() => {
    vi.mocked(fs.appendFileSync).mockClear();
  });

  // ---- info() ---------------------------------------------------------------

  describe("info()", () => {
    it("writes a valid JSON line with correct level, module, action, timestamp, data", () => {
      logger.info("monitor", "stock_check", { url: "https://example.com" });

      const entry = lastEntry();
      expect(entry.level).toBe("info");
      expect(entry.module).toBe("monitor");
      expect(entry.action).toBe("stock_check");
      expect(entry.data).toEqual({ url: "https://example.com" });
      // timestamp is an ISO-8601 string
      expect(typeof entry.timestamp).toBe("string");
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it("writes empty data object when no data is passed", () => {
      logger.info("auth", "session_loaded");
      const entry = lastEntry();
      expect(entry.data).toEqual({});
    });
  });

  // ---- warn() ---------------------------------------------------------------

  describe("warn()", () => {
    it("writes level: \"warn\"", () => {
      logger.warn("checkout", "retry", { attempt: 1 });
      const entry = lastEntry();
      expect(entry.level).toBe("warn");
      expect(entry.module).toBe("checkout");
      expect(entry.action).toBe("retry");
    });
  });

  // ---- error() --------------------------------------------------------------

  describe("error()", () => {
    it("writes level: \"error\"", () => {
      logger.error("auth", "login_failed", { reason: "bad password" });
      const entry = lastEntry();
      expect(entry.level).toBe("error");
    });

    it("goes to stderr (not stdout) for error level", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        logger.error("auth", "login_failed");
        expect(stderrSpy).toHaveBeenCalled();
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });

    it("non-error levels go to stdout", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        logger.info("monitor", "tick");
        expect(stdoutSpy).toHaveBeenCalled();
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });
  });

  // ---- debug() / minLevel filtering ----------------------------------------

  describe("debug() filtering by minLevel", () => {
    it("suppresses debug() when minLevel is \"info\" (default)", () => {
      const infoLogger = new Logger(TEST_LOG_DIR, "info");
      vi.mocked(fs.appendFileSync).mockClear();

      infoLogger.debug("index", "startup");
      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
    });

    it("debug() appears when minLevel is \"debug\"", () => {
      const debugLogger = new Logger(TEST_LOG_DIR, "debug");
      vi.mocked(fs.appendFileSync).mockClear();

      debugLogger.debug("index", "startup", { pid: 42 });
      const entry = lastEntry();
      expect(entry.level).toBe("debug");
      expect(entry.action).toBe("startup");
    });

    it("suppresses debug when minLevel is \"warn\"", () => {
      const warnLogger = new Logger(TEST_LOG_DIR, "warn");
      vi.mocked(fs.appendFileSync).mockClear();

      warnLogger.debug("m", "a");
      warnLogger.info("m", "a");
      expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();

      warnLogger.warn("m", "a");
      expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Log file path uses today's date in YYYY-MM-DD format ----------------

  describe("log file path", () => {
    it("log file path uses today's date in YYYY-MM-DD format", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-09T12:34:56.000Z"));

      try {
        vi.mocked(fs.appendFileSync).mockClear();
        const timedLogger = new Logger(TEST_LOG_DIR, "info");
        timedLogger.info("test", "date_check");

        const mock = vi.mocked(fs.appendFileSync);
        expect(mock).toHaveBeenCalled();
        const filePath = mock.mock.calls[0][0] as string;
        expect(filePath).toContain("audit-2026-06-09.log");
        expect(path.dirname(filePath)).toBe(TEST_LOG_DIR);
      } finally {
        vi.useRealTimers();
      }
    });

    it("appends a newline after the JSON so each entry is on its own line", () => {
      logger.info("test", "newline_check");
      const mock = vi.mocked(fs.appendFileSync);
      const raw = mock.mock.calls[mock.mock.calls.length - 1][1] as string;
      expect(raw.endsWith("\n")).toBe(true);
      // The part before the newline should parse cleanly
      expect(() => JSON.parse(raw.trimEnd())).not.toThrow();
    });
  });

  // ---- log() direct call ----------------------------------------------------

  describe("log() base method", () => {
    it("accepts all four log levels", () => {
      const levels = ["debug", "info", "warn", "error"] as const;
      const debugLogger = new Logger(TEST_LOG_DIR, "debug");
      vi.mocked(fs.appendFileSync).mockClear();

      // Suppress stdout/stderr noise during this test
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        for (const lvl of levels) {
          debugLogger.log(lvl, "mod", "act");
        }
        const entries = allEntries();
        expect(entries.map((e) => e.level)).toEqual(levels);
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });
});
