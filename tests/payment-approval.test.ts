import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildTelegramMessage,
  callbackDataToOutcome,
  requestApproval,
  requestApprovalTelegram,
  ApprovalRejectedError,
} from "../src/payment-approval";
import { OrderSummary, Settings } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const summary: OrderSummary = {
  itemName: "Pikachu Plush",
  itemUrl: "https://www.lazada.sg/products/test-item.html",
  price: 39.9,
  quantity: 2,
  estimatedTotal: 79.8,
  deliveryAddress: "123 Orchard Road, Singapore 238858",
  paymentMethod: "PayNow",
};

const baseSettings: Settings = {
  checkIntervalMs: 15_000,
  minPageLoadDelayMs: 3_000,
  maxPageLoadDelayMs: 8_000,
  headless: true,
  maxRetries: 3,
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 30_000,
  paymentMethod: "paynow",
  sessionFile: "session.json",
  dryRun: false,
  logDir: "logs",
  approvalMethod: "stdin",
};

const creds = { botToken: "TEST-TOKEN", chatId: "12345" };

function fakeLogger(): {
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
} {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildTelegramMessage", () => {
  it("includes the item name in the message text", () => {
    const msg = buildTelegramMessage(summary);
    expect(msg.text).toContain("Pikachu Plush");
  });

  it("uses HTML parse mode", () => {
    expect(buildTelegramMessage(summary).parse_mode).toBe("HTML");
  });

  it("renders the order summary inside a <pre> block", () => {
    const msg = buildTelegramMessage(summary);
    expect(msg.text).toMatch(/<pre>[\s\S]*<\/pre>/);
  });

  it("provides exactly two inline-keyboard buttons in one row", () => {
    const rows = buildTelegramMessage(summary).reply_markup.inline_keyboard;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
  });

  it("uses approve/reject callback_data on the two buttons", () => {
    const row = buildTelegramMessage(summary).reply_markup.inline_keyboard[0]!;
    const callbacks = row.map((b) => b.callback_data).sort();
    expect(callbacks).toEqual(["approve", "reject"]);
  });

  it("escapes HTML special characters in the summary body", () => {
    const evil: OrderSummary = {
      ...summary,
      itemName: "<script>alert(1)</script>",
    };
    const text = buildTelegramMessage(evil).text;
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("callbackDataToOutcome", () => {
  it("maps 'approve' to approve", () => {
    expect(callbackDataToOutcome("approve")).toBe("approve");
  });
  it("maps 'reject' to reject", () => {
    expect(callbackDataToOutcome("reject")).toBe("reject");
  });
  it("maps unrecognized values to 'unknown'", () => {
    expect(callbackDataToOutcome("yes")).toBe("unknown");
    expect(callbackDataToOutcome(undefined)).toBe("unknown");
    expect(callbackDataToOutcome("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Telegram approval (mocked fetch)
// ---------------------------------------------------------------------------

type FetchArgs = Parameters<typeof fetch>;
type FetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

function mockFetch(
  responder: (url: string, init?: RequestInit) => unknown
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (...args: FetchArgs): Promise<FetchResponse> => {
    const url = typeof args[0] === "string" ? args[0] : String(args[0]);
    const body = responder(url, args[1]);
    return {
      ok: true,
      json: async () => body,
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("requestApprovalTelegram", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts sendMessage with the configured chat_id and inline keyboard", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/sendMessage")) {
        return { ok: true, result: { message_id: 1 } };
      }
      // First poll returns an approve callback so we exit fast.
      return {
        ok: true,
        result: [
          {
            update_id: 100,
            callback_query: {
              id: "cb-1",
              from: { id: 9 },
              message: { chat: { id: 12345 } },
              data: "approve",
            },
          },
        ],
      };
    });

    const { logger } = fakeLogger();
    await requestApprovalTelegram(summary, logger as never, creds);

    const sendCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/sendMessage")
    );
    expect(sendCall).toBeDefined();
    const body = JSON.parse(String((sendCall![1] as RequestInit).body));
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup.inline_keyboard[0]).toHaveLength(2);
  });

  it("resolves successfully and logs approval_granted on approve callback", async () => {
    mockFetch((url) => {
      if (url.includes("/sendMessage")) {
        return { ok: true, result: { message_id: 1 } };
      }
      return {
        ok: true,
        result: [
          {
            update_id: 200,
            callback_query: {
              id: "cb-1",
              from: { id: 9 },
              message: { chat: { id: 12345 } },
              data: "approve",
            },
          },
        ],
      };
    });

    const { logger } = fakeLogger();
    await expect(
      requestApprovalTelegram(summary, logger as never, creds)
    ).resolves.toBeUndefined();
    const granted = logger.info.mock.calls.find(
      (c) => c[1] === "approval_granted"
    );
    expect(granted).toBeDefined();
    expect(granted![2]).toMatchObject({ method: "telegram" });
  });

  it("throws ApprovalRejectedError on reject callback", async () => {
    mockFetch((url) => {
      if (url.includes("/sendMessage")) {
        return { ok: true, result: { message_id: 1 } };
      }
      return {
        ok: true,
        result: [
          {
            update_id: 300,
            callback_query: {
              id: "cb-1",
              from: { id: 9 },
              message: { chat: { id: 12345 } },
              data: "reject",
            },
          },
        ],
      };
    });

    const { logger } = fakeLogger();
    await expect(
      requestApprovalTelegram(summary, logger as never, creds)
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });

  it("ignores callbacks from a different chat_id", async () => {
    let pollCount = 0;
    mockFetch((url) => {
      if (url.includes("/sendMessage")) {
        return { ok: true, result: { message_id: 1 } };
      }
      pollCount++;
      if (pollCount === 1) {
        // Callback from an unrelated chat — must be ignored.
        return {
          ok: true,
          result: [
            {
              update_id: 400,
              callback_query: {
                id: "cb-other",
                from: { id: 1 },
                message: { chat: { id: 99999 } },
                data: "approve",
              },
            },
          ],
        };
      }
      // Then a real one from the configured chat.
      return {
        ok: true,
        result: [
          {
            update_id: 401,
            callback_query: {
              id: "cb-1",
              from: { id: 9 },
              message: { chat: { id: 12345 } },
              data: "approve",
            },
          },
        ],
      };
    });

    const { logger } = fakeLogger();
    await requestApprovalTelegram(summary, logger as never, creds);
    expect(pollCount).toBeGreaterThanOrEqual(2);
    const warns = logger.warn.mock.calls.map((c) => c[1]);
    expect(warns).toContain("telegram_unexpected_chat");
  });

  it("throws when sendMessage returns ok=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: false, description: "bot blocked by user" }),
      }))
    );

    const { logger } = fakeLogger();
    await expect(
      requestApprovalTelegram(summary, logger as never, creds)
    ).rejects.toThrow(/bot blocked by user/);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe("requestApproval dispatcher", () => {
  const ORIG_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
  const ORIG_CHAT = process.env["TELEGRAM_CHAT_ID"];

  beforeEach(() => {
    process.env["TELEGRAM_BOT_TOKEN"] = "TEST-TOKEN";
    process.env["TELEGRAM_CHAT_ID"] = "12345";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (ORIG_TOKEN !== undefined) process.env["TELEGRAM_BOT_TOKEN"] = ORIG_TOKEN;
    else delete process.env["TELEGRAM_BOT_TOKEN"];
    if (ORIG_CHAT !== undefined) process.env["TELEGRAM_CHAT_ID"] = ORIG_CHAT;
    else delete process.env["TELEGRAM_CHAT_ID"];
  });

  it("routes to the Telegram path when approvalMethod is 'telegram'", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/sendMessage")) {
        return { ok: true, result: { message_id: 1 } };
      }
      return {
        ok: true,
        result: [
          {
            update_id: 500,
            callback_query: {
              id: "cb-1",
              from: { id: 9 },
              message: { chat: { id: 12345 } },
              data: "approve",
            },
          },
        ],
      };
    });

    const settings: Settings = { ...baseSettings, approvalMethod: "telegram" };
    const { logger } = fakeLogger();
    await requestApproval(summary, logger as never, settings);

    expect(fetchMock).toHaveBeenCalled();
    const granted = logger.info.mock.calls.find(
      (c) => c[1] === "approval_granted"
    );
    expect(granted![2]).toMatchObject({ method: "telegram" });
  });

  it("throws if approvalMethod is 'telegram' but env vars are missing", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["TELEGRAM_CHAT_ID"];

    const settings: Settings = { ...baseSettings, approvalMethod: "telegram" };
    const { logger } = fakeLogger();
    await expect(
      requestApproval(summary, logger as never, settings)
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
