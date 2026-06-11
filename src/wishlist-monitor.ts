/**
 * Wishlist watcher.
 *
 * A single page polls the account wishlist and classifies every tracked item
 * (in_stock / out_of_stock / unknown). On an out_of_stock → in_stock transition
 * it fires that item's RestockGate, waking the corresponding buyer. One watcher
 * fans out to N buyers — far fewer requests than one PDP poll per item, which is
 * the main anti-bot win.
 *
 * Stock state is read from the JSON Lazada embeds in the served wishlist HTML
 * (`lightItemDetailDTO` = all items, `outOfStock` = the out-of-stock subset),
 * parsed by the pure decision.parseWishlistStock. This is robust to UI/CSS
 * changes and needs no render settle — the data is present at domcontentloaded,
 * before the card grid hydrates.
 *
 * Config items are matched to wishlist entries title-first (the config URL id
 * can be non-canonical) via decision.matchWishlistItem; classifications stay
 * keyed by the config-URL product id, which is the registry/gate key.
 *
 * Mirrors monitor.ts: never throws on transient page errors, survives anti-bot
 * challenges by backing off and resuming (bounded by a circuit breaker), and
 * halts loudly on login_required (the watcher is a single point of failure for
 * all buyers, so a session expiry must surface, not be swallowed).
 */

import { Page } from "playwright";
import { Item, StockStatus, ChallengeSurvivalOptions } from "./types";
import { Logger } from "./logger";
import { RateLimiter } from "./rate-limiter";
import { detectChallenge } from "./auth";
import { navigateTo } from "./browser-actions";
import {
  computeChallengeBackoff,
  extractProductId,
  isRestockTransition,
  parseWishlistStock,
  matchWishlistItem,
} from "./decision";
import { interruptibleSleep } from "./monitor";
import { captureNamedSnapshot } from "./diagnostics";
import { RestockRegistry } from "./restock-signal";

const MODULE = "wishlist";
const LAZADA_DOMAIN = "www.lazada.sg";
const MATCH_MISS_WARN_THRESHOLD = 5;

export interface WishlistClassification {
  productId: string;    // config-URL product id — the registry/gate key
  status: StockStatus;  // in_stock | out_of_stock | unknown
  matchedCard: boolean; // false ⇒ item not found in the wishlist data this poll
  matchedBy: "title" | "title_substring" | "id" | null;
  wishlistItemId: string | null; // the wishlist itemId the match resolved to
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
  items: Item[],
  wishlistUrl: string,
  rateLimiter: RateLimiter,
  logger: Logger,
  debugDir?: string
): Promise<WishlistResult> {
  await rateLimiter.acquire(LAZADA_DOMAIN);

  try {
    await navigateTo(page, wishlistUrl, logger);
  } catch (err) {
    logger.warn(MODULE, "navigation_failed", { error: (err as Error).message });
    return { kind: "error" };
  }

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
    await captureNamedSnapshot(page, "wishlist", debugDir, logger);
  }

  const html = await page.content().catch(() => null);
  if (!html) {
    logger.warn(MODULE, "page_content_unreadable");
    return { kind: "error" };
  }

  const state = parseWishlistStock(html);
  if (state.knownIds.size === 0) {
    // No embedded wishlist data — wrong page, empty wishlist, or Lazada changed
    // the payload shape. Treat as no-data; every item classifies "unknown".
    logger.warn(MODULE, "no_wishlist_data_in_page", { url: page.url() });
  }

  // Title-first matching (URL id as fallback), but classifications stay keyed
  // by the config-URL product id — that is what the registry/gates use.
  const classifications = items.map((it): WishlistClassification => {
    const configId = extractProductId(it.url) ?? it.url;
    const match = matchWishlistItem(it, state);
    if (!match) {
      return { productId: configId, status: "unknown", matchedCard: false, matchedBy: null, wishlistItemId: null };
    }
    return {
      productId: configId,
      status: match.status,
      matchedCard: true,
      matchedBy: match.matchedBy,
      wishlistItemId: match.itemId,
    };
  });

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
  onClassified: (c: WishlistClassification) => void,
  debugDir?: string
): Promise<void> {
  logger.info(MODULE, "watch_started", {
    wishlistUrl,
    intervalMs,
    tracked: items.map((it) => ({ name: it.name, productId: extractProductId(it.url) })),
    surviveChallenges: survival.surviveChallenges,
  });

  const lastStatus = new Map<string, StockStatus>();
  const missStreak = new Map<string, number>();
  const matchAnnounced = new Set<string>();
  let consecutiveChallenges = 0;

  while (!signal.aborted) {
    const result = await checkWishlist(page, items, wishlistUrl, rateLimiter, logger, debugDir);

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
            hint: "Neither the item name matched a wishlist title nor the URL id a wishlist itemId. Run `npm run list-wishlist` to see what the wishlist actually contains, then fix the config name/url.",
          });
        }
        continue;
      }
      missStreak.set(c.productId, 0);
      if (!matchAnnounced.has(c.productId)) {
        matchAnnounced.add(c.productId);
        logger.info(MODULE, "item_matched_on_wishlist", {
          productId: c.productId,
          wishlistItemId: c.wishlistItemId,
          matchedBy: c.matchedBy,
        });
      }

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
