/**
 * Payment approval gate.
 *
 * Builds an order summary from checkout page data, displays it,
 * and waits for the user to type "CONFIRM" before allowing purchase.
 *
 * NEVER auto-submits. If the user does not respond within the timeout,
 * the purchase is aborted.
 */

import * as readline from "readline";
import { OrderSummary } from "./types";
import { Logger } from "./logger";
import { formatOrderSummary } from "./decision";

const MODULE = "payment-approval";
const CONFIRM_TIMEOUT_MS = 120_000; // 2 minutes
const REQUIRED_INPUT = "CONFIRM";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApprovalRejectedError extends Error {
  constructor(input: string) {
    super(
      `Purchase aborted — user typed "${input}" instead of "${REQUIRED_INPUT}".`
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
// Main gate
// ---------------------------------------------------------------------------

/**
 * Displays the order summary and blocks until the user types CONFIRM.
 * Throws ApprovalRejectedError or ApprovalTimeoutError on failure.
 * Never throws on success — caller may then proceed to place the order.
 */
export async function requestApproval(
  summary: OrderSummary,
  logger: Logger
): Promise<void> {
  process.stdout.write(formatOrderSummary(summary));

  logger.info(MODULE, "approval_requested", {
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
    item: summary.itemName,
    estimatedTotal: summary.estimatedTotal,
  });
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
