/**
 * Wishlist watcher.
 *
 * A single page polls the account wishlist and classifies every tracked item
 * (in_stock / out_of_stock / unknown) by inspecting its card. On an
 * out_of_stock → in_stock transition it fires that item's RestockGate, waking
 * the corresponding buyer. One watcher fans out to N buyers — far fewer requests
 * than one PDP poll per item, which is the main anti-bot win.
 *
 * Mirrors monitor.ts: never throws on transient page errors, survives anti-bot
 * challenges by backing off and resuming (bounded by a circuit breaker), and
 * halts loudly on login_required (the watcher is a single point of failure for
 * all buyers, so a session expiry must surface, not be swallowed).
 *
 * All per-card matching goes through resolveSelectorWithin — no inline locators
 * in classification logic (CLAUDE.md selector invariant).
 */

import { Page, Locator } from "playwright";
import { Item, StockStatus, ChallengeSurvivalOptions } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { SELECTORS, resolveSelectorWithin } from "./selectors";
import { detectChallenge } from "./auth";
import { navigateTo } from "./browser-actions";
import { computeChallengeBackoff, extractProductId, isRestockTransition } from "./decision";
import { interruptibleSleep } from "./monitor";
import { captureDomSnapshot } from "./diagnostics";
import { RestockRegistry } from "./restock-signal";

const MODULE = "wishlist";
const LAZADA_DOMAIN = "www.lazada.sg";
const MATCH_MISS_WARN_THRESHOLD = 5;

export interface WishlistClassification {
  productId: string;
  status: StockStatus; // in_stock | out_of_stock | unknown
  matchedCard: boolean; // false ⇒ item not found on the wishlist this poll
}

type WishlistResult =
  | { kind: "ok"; classifications: WishlistClassification[] }
  | { kind: "anti_bot" }
  | { kind: "login_required" }
  | { kind: "error" };

// ---------------------------------------------------------------------------
// Single wishlist poll
// ---------------------------------------------------------------------------

export async function checkWishlist(
  page: Page,
  trackedIds: string[],
  wishlistUrl: string,
  rateLimiter: RateLimiter,
  logger: Logger,
  settleMs: number,
  debugDir?: string
): Promise<WishlistResult> {
  await rateLimiter.acquire(LAZADA_DOMAIN);

  try {
    await navigateTo(page, wishlistUrl, logger);
  } catch (err) {
    logger.warn(MODULE, "navigation_failed", { error: (err as Error).message });
    return { kind: "error" };
  }

  await waitForWishlistReady(page, settleMs);

  const challenge = await detectChallenge(page, logger);
  if (challenge) {
    logger.warn(MODULE, "anti_bot_detected", { type: challenge.type, url: challenge.url });
    return { kind: "anti_bot" };
  }

  if (page.url().includes("/login")) {
    logger.error(MODULE, "login_required", { url: page.url() });
    return { kind: "login_required" };
  }

  if (debugDir) {
    await captureDomSnapshot(
      page,
      { name: "wishlist", url: wishlistUrl, maxPrice: 0, quantity: 1 } as Item,
      debugDir,
      logger
    );
  }

  const classifications = await classifyCards(page, trackedIds, logger);
  return { kind: "ok", classifications };
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------

export async function watchWishlist(
  page: Page,
  items: Item[],
  registry: RestockRegistry,
  wishlistUrl: string,
  intervalMs: number,
  rateLimiter: RateLimiter,
  logger: Logger,
  signal: AbortSignal,
  survival: ChallengeSurvivalOptions,
  settleMs: number,
  onClassified: (c: WishlistClassification) => void,
  debugDir?: string
): Promise<void> {
  const trackedIds = items
    .map((it) => extractProductId(it.url))
    .filter((id): id is string => id !== null);

  logger.info(MODULE, "watch_started", {
    wishlistUrl,
    intervalMs,
    trackedIds,
    surviveChallenges: survival.surviveChallenges,
  });

  const lastStatus = new Map<string, StockStatus>();
  const missStreak = new Map<string, number>();
  let consecutiveChallenges = 0;

  while (!signal.aborted) {
    const result = await checkWishlist(page, trackedIds, wishlistUrl, rateLimiter, logger, settleMs, debugDir);

    if (result.kind === "anti_bot") {
      if (!survival.surviveChallenges) {
        logger.error(MODULE, "watch_halted_anti_bot");
        return;
      }
      consecutiveChallenges++;
      const backoff = computeChallengeBackoff(
        consecutiveChallenges,
        survival.challengeBackoffBaseMs,
        survival.challengeBackoffMaxMs,
        survival.maxConsecutiveChallenges
      );
      if (backoff.giveUp) {
        logger.error(MODULE, "watch_halted_anti_bot_circuit_breaker", {
          consecutiveChallenges,
          reason: backoff.reason,
        });
        return;
      }
      logger.warn(MODULE, "anti_bot_backoff_resume", { consecutiveChallenges, backoffMs: backoff.delayMs });
      await interruptibleSleep(backoff.delayMs, signal);
      continue;
    }

    if (result.kind === "login_required") {
      // Single point of failure — surface loudly so the run halts for re-auth.
      logger.error(MODULE, "watch_halted_login_expired");
      return;
    }

    consecutiveChallenges = 0;

    if (result.kind === "error") {
      await interruptibleSleep(intervalMs, signal);
      continue;
    }

    for (const c of result.classifications) {
      onClassified(c);

      if (!c.matchedCard) {
        const streak = (missStreak.get(c.productId) ?? 0) + 1;
        missStreak.set(c.productId, streak);
        if (streak === MATCH_MISS_WARN_THRESHOLD) {
          logger.warn(MODULE, "item_not_found_on_wishlist", {
            productId: c.productId,
            consecutiveMisses: streak,
            hint: "Is the item still on the wishlist? Does its URL id match a card link?",
          });
        }
        continue;
      }
      missStreak.set(c.productId, 0);

      const prev = lastStatus.get(c.productId);
      if (isRestockTransition(prev, c.status)) {
        const known = registry.fire(c.productId);
        logger.info(MODULE, "restock_detected", { productId: c.productId, firedBuyer: known });
      }
      if (c.status === "out_of_stock") {
        registry.rearm(c.productId);
      }
      // Only remember definite states so a transient "unknown" can't mask a transition.
      if (c.status === "in_stock" || c.status === "out_of_stock") {
        lastStatus.set(c.productId, c.status);
      }
    }

    await interruptibleSleep(intervalMs, signal);
  }

  logger.info(MODULE, "watch_aborted");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Adaptive settle for the wishlist page — anchors on the card list. */
async function waitForWishlistReady(page: Page, settleMs: number): Promise<void> {
  if (settleMs <= 0) return;
  const anchor = SELECTORS.wishlist.cardList.candidates.join(", ");
  await page
    .locator(anchor)
    .first()
    .waitFor({ state: "visible", timeout: settleMs })
    .catch(() => {
      /* nothing rendered within settleMs — classify whatever is there */
    });
}

/**
 * Classifies every tracked item from the wishlist DOM. Items not present on the
 * wishlist are returned with matchedCard:false / status:"unknown".
 */
async function classifyCards(
  page: Page,
  trackedIds: string[],
  logger: Logger
): Promise<WishlistClassification[]> {
  const byId = new Map<string, WishlistClassification>();
  for (const id of trackedIds) {
    byId.set(id, { productId: id, status: "unknown", matchedCard: false });
  }

  const cards = await getCardLocators(page);

  for (const card of cards) {
    const href = await readCardHref(card);
    if (!href) continue;
    const id = extractProductId(href);
    if (!id || !byId.has(id)) continue;

    const status = await classifyCard(card);
    byId.set(id, { productId: id, status, matchedCard: true });
    logger.debug(MODULE, "card_classified", { productId: id, status });
  }

  return trackedIds.map((id) => byId.get(id)!);
}

/** Returns every wishlist card locator, using the first cardList candidate that matches. */
async function getCardLocators(page: Page): Promise<Locator[]> {
  for (const candidate of SELECTORS.wishlist.cardList.candidates) {
    const locator = page.locator(candidate);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return locator.all();
    }
  }
  return [];
}

/** Reads the PDP link href from a card via the abstraction layer. */
async function readCardHref(card: Locator): Promise<string | null> {
  const resolved = await resolveSelectorWithin(card, SELECTORS.wishlist.cardProductLink, 1_000).catch(
    () => null
  );
  if (!resolved) return null;
  return card.locator(resolved.selector).first().getAttribute("href").catch(() => null);
}

/** OOS marker wins; else an enabled Add to Cart means in stock; else unknown. */
async function classifyCard(card: Locator): Promise<StockStatus> {
  const oos = await resolveSelectorWithin(card, SELECTORS.wishlist.cardOutOfStock, 1_000).catch(
    () => null
  );
  if (oos) return "out_of_stock";

  const addToCart = await resolveSelectorWithin(card, SELECTORS.wishlist.cardAddToCart, 1_000).catch(
    () => null
  );
  if (addToCart) return "in_stock";

  return "unknown";
}
