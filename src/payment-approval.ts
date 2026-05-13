/**
 * Payment approval gate.
 *
 * Builds an order summary from checkout page data, displays it,
 * and waits for the user to approve (typing CONFIRM in terminal, or
 * tapping a button in Telegram) before allowing purchase.
 *
 * NEVER auto-submits. If the user does not respond within the timeout,
 * the purchase is aborted.
 */

import * as readline from "readline";
import { OrderSummary, Settings } from "./types";
import { Logger } from "./logger";
import { formatOrderSummary } from "./decision";
import { loadTelegramCredentials, TelegramCredentials } from "./config";

const MODULE = "payment-approval";
const CONFIRM_TIMEOUT_MS = 120_000; // 2 minutes
const REQUIRED_INPUT = "CONFIRM";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApprovalRejectedError extends Error {
  constructor(input: string) {
    super(
      `Purchase aborted — user rejected approval (input: "${input}").`
    );
    this.name = "ApprovalRejectedError";
  }
}

export class ApprovalTimeoutError extends Error {
  constructor() {
    super(
      `Purchase aborted — no response within ${CONFIRM_TIMEOUT_MS / 1000} seconds.`
    );
    this.name = "ApprovalTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Displays the order summary and blocks until the user approves.
 * Routes to the configured approval method (stdin or Telegram).
 * Throws ApprovalRejectedError or ApprovalTimeoutError on failure.
 * Never throws on success — caller may then proceed to place the order.
 */
export async function requestApproval(
  summary: OrderSummary,
  logger: Logger,
  settings: Settings
): Promise<void> {
  if (settings.approvalMethod === "telegram") {
    return requestApprovalTelegram(summary, logger, loadTelegramCredentials());
  }
  return requestApprovalStdin(summary, logger);
}

// ---------------------------------------------------------------------------
// stdin path (original behavior)
// ---------------------------------------------------------------------------

export async function requestApprovalStdin(
  summary: OrderSummary,
  logger: Logger
): Promise<void> {
  process.stdout.write(formatOrderSummary(summary));

  logger.info(MODULE, "approval_requested", {
    method: "stdin",
    item: summary.itemName,
    estimatedTotal: summary.estimatedTotal,
    paymentMethod: summary.paymentMethod,
  });

  const input = await readLineWithTimeout(
    `> Type ${REQUIRED_INPUT} to confirm purchase: `,
    CONFIRM_TIMEOUT_MS
  );

  if (input === null) {
    logger.warn(MODULE, "approval_timeout", { item: summary.itemName });
    throw new ApprovalTimeoutError();
  }

  if (input.trim().toUpperCase() !== REQUIRED_INPUT) {
    logger.warn(MODULE, "approval_rejected", {
      item: summary.itemName,
      typedInput: input.trim(),
    });
    throw new ApprovalRejectedError(input.trim());
  }

  logger.info(MODULE, "approval_granted", {
    method: "stdin",
    item: summary.itemName,
    estimatedTotal: summary.estimatedTotal,
  });
}

// ---------------------------------------------------------------------------
// Telegram path (mobile-friendly approval)
// ---------------------------------------------------------------------------

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_LONG_POLL_TIMEOUT_S = 25;
const APPROVE_CALLBACK = "approve";
const REJECT_CALLBACK = "reject";

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { chat: { id: number } };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

export function buildTelegramMessage(summary: OrderSummary): {
  text: string;
  parse_mode: "HTML";
  reply_markup: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
} {
  const text =
    "<b>Order awaiting approval</b>\n" +
    "<pre>" +
    escapeHtml(formatOrderSummary(summary).trim()) +
    "</pre>";

  return {
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: APPROVE_CALLBACK },
          { text: "Reject", callback_data: REJECT_CALLBACK },
        ],
      ],
    },
  };
}

export function callbackDataToOutcome(
  data: string | undefined
): "approve" | "reject" | "unknown" {
  if (data === APPROVE_CALLBACK) return "approve";
  if (data === REJECT_CALLBACK) return "reject";
  return "unknown";
}

export async function requestApprovalTelegram(
  summary: OrderSummary,
  logger: Logger,
  creds: TelegramCredentials
): Promise<void> {
  process.stdout.write(formatOrderSummary(summary));

  logger.info(MODULE, "approval_requested", {
    method: "telegram",
    item: summary.itemName,
    estimatedTotal: summary.estimatedTotal,
    paymentMethod: summary.paymentMethod,
  });

  const payload = buildTelegramMessage(summary);
  const sendUrl = `${TELEGRAM_API}/bot${creds.botToken}/sendMessage`;

  const sendRes = await fetch(sendUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: creds.chatId, ...payload }),
  });
  const sendBody = (await sendRes.json()) as TelegramSendMessageResponse;
  if (!sendBody.ok) {
    throw new Error(
      `Telegram sendMessage failed: ${sendBody.description ?? "unknown error"}`
    );
  }

  // Poll for the user's tap.
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let offset = 0;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const pollTimeoutS = Math.max(
      1,
      Math.min(TELEGRAM_LONG_POLL_TIMEOUT_S, Math.floor(remainingMs / 1000))
    );

    const getUrl =
      `${TELEGRAM_API}/bot${creds.botToken}/getUpdates` +
      `?timeout=${pollTimeoutS}` +
      `&offset=${offset}` +
      `&allowed_updates=${encodeURIComponent('["callback_query"]')}`;

    const pollRes = await fetch(getUrl);
    const pollBody = (await pollRes.json()) as TelegramGetUpdatesResponse;
    if (!pollBody.ok) {
      throw new Error(
        `Telegram getUpdates failed: ${pollBody.description ?? "unknown error"}`
      );
    }

    for (const update of pollBody.result ?? []) {
      offset = update.update_id + 1;
      const cb = update.callback_query;
      if (!cb) continue;

      const fromChat = cb.message?.chat.id;
      if (fromChat !== undefined && String(fromChat) !== creds.chatId) {
        logger.warn(MODULE, "telegram_unexpected_chat", {
          item: summary.itemName,
          chatId: fromChat,
        });
        continue;
      }

      await answerCallback(creds.botToken, cb.id).catch(() => {});

      const outcome = callbackDataToOutcome(cb.data);
      if (outcome === "approve") {
        logger.info(MODULE, "approval_granted", {
          method: "telegram",
          item: summary.itemName,
          estimatedTotal: summary.estimatedTotal,
        });
        return;
      }
      if (outcome === "reject") {
        logger.warn(MODULE, "approval_rejected", {
          item: summary.itemName,
          typedInput: REJECT_CALLBACK,
        });
        throw new ApprovalRejectedError(REJECT_CALLBACK);
      }
      // Unknown callback data — keep waiting.
    }
  }

  logger.warn(MODULE, "approval_timeout", { item: summary.itemName });
  throw new ApprovalTimeoutError();
}

async function answerCallback(botToken: string, callbackId: string): Promise<void> {
  await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId }),
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Readline helper with timeout
// ---------------------------------------------------------------------------

/**
 * Prompts the user and resolves with their input string.
 * Resolves with null if the timeout expires.
 */
export function readLineWithTimeout(
  prompt: string,
  timeoutMs: number
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(null);
      }
    }, timeoutMs);

    rl.question(prompt, (answer) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      }
    });

    // Handle Ctrl+C within the readline prompt
    rl.on("SIGINT", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(null); // treat as timeout/rejection — caller handles abort
      }
    });
  });
}
