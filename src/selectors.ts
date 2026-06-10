/**
 * Selector Abstraction Layer
 *
 * IMPORTANT: Every selector here is UNVERIFIED against live Lazada SG pages.
 * Before using in production, open each page in a headed browser and inspect
 * the DOM to confirm each candidate matches the intended element.
 *
 * Run `npm run verify-selectors` (dry-run mode) to get a report of which
 * candidates resolve on each page type.
 *
 * Candidates are tried in order; the first one visible on the page wins.
 * Text-based selectors (has-text) are listed last as fallbacks because they
 * are more resilient to class-name changes but slower to match.
 */

import { Page, Locator } from "playwright";
import { SelectorSet, ResolvedSelector } from "./types";

// ---------------------------------------------------------------------------
// Selector definitions
// ---------------------------------------------------------------------------

export const SELECTORS = {
  // ---- Login page ----------------------------------------------------------
  login: {
    emailLoginTab: {
      description: "Tab/button to switch from phone login to email login",
      candidates: [
        '[class*="login-with-email"]',
        '[class*="email-login"]',
        'span:has-text("Log in with Email")',
        'a:has-text("Log in with Email")',
      ],
      required: false,
    } satisfies SelectorSet,

    emailInput: {
      description: "Email / account name input on the login form",
      candidates: [
        'input[name="loginName"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="Email"]',
        'input[placeholder*="email"]',
      ],
      required: true,
    } satisfies SelectorSet,

    passwordInput: {
      description: "Password input on the login form",
      candidates: [
        'input[name="password"]',
        'input[type="password"]',
        'input[placeholder*="Password"]',
        'input[placeholder*="password"]',
      ],
      required: true,
    } satisfies SelectorSet,

    submitButton: {
      description: "Login / submit button",
      candidates: [
        'button[type="submit"]',
        'button[class*="login-btn"]',
        'button[class*="btn-login"]',
        'button:has-text("Log In")',
        'button:has-text("Login")',
      ],
      required: true,
    } satisfies SelectorSet,

    loginLink: {
      description: "Login affordance in the site header — visible = logged OUT",
      candidates: [
        '#anonLogin',                 // Lazada header: logged-out "login" link container
        '#anonLogin a',
        '#anonSignup',
        'a[data-spm-click*="locaid=login"]',
        'a[href*="member.lazada"][href*="login"]',
      ],
      required: false,
    } satisfies SelectorSet,

    loggedInIndicator: {
      description: "Account affordance in the header — visible = logged IN (positive signal)",
      candidates: [
        '#myAccountTrigger',                          // account-name trigger, shown only when logged in
        '#topActionUserAccont:not(.top-links-item-hidden)',
        'a[href*="member.lazada.sg/user/account"]',
        'a[href*="member.lazada.sg/user/logout"]',
        '[data-spm-click*="locaid=account"]',
      ],
      required: false,
    } satisfies SelectorSet,
  },

  // ---- Anti-bot / challenge indicators ------------------------------------
  antiBot: {
    captchaFrame: {
      description: "Google reCAPTCHA iframe or hCaptcha container",
      candidates: [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '[class*="captcha"]',
        '[id*="captcha"]',
        '[class*="nc_container"]',  // Alibaba/Lazada slider CAPTCHA
        '[class*="baxia"]',         // Lazada/Alibaba bot challenge
      ],
      required: false,
    } satisfies SelectorSet,

    rateLimitMessage: {
      description: "Page-level rate-limit or access-denied message",
      candidates: [
        'h1:has-text("Access Denied")',
        'h1:has-text("Too Many Requests")',
        '[class*="error-page"]:has-text("blocked")',
      ],
      required: false,
    } satisfies SelectorSet,
  },

  // ---- Product detail page -------------------------------------------------
  product: {
    price: {
      description: "Current selling price on the product detail page",
      candidates: [
        '[class*="pdp-price_type_normal"]',
        '[class*="pdp-price"]',
        '[class*="price-container"] [class*="price"]',
        '[class*="product-price"]',
        'span[class*="price"]:not([class*="original"])',
      ],
      required: false,
    } satisfies SelectorSet,

    addToCartButton: {
      description: "Add to Cart button (enabled = in stock)",
      candidates: [
        'button[data-spm-click*="cart"]',
        // class*="add-to-cart" removed: Lazada's wishlist button shares this class substring
        'button:has-text("Add to Cart")',
      ],
      required: false,
    } satisfies SelectorSet,

    buyNowButton: {
      description: "Buy Now button — takes directly to checkout",
      candidates: [
        'button[data-spm-click*="buynow"]',
        // class*="buy-now" removed: Lazada's wishlist button shares this class substring
        'button:has-text("Buy Now")',
      ],
      required: false,
    } satisfies SelectorSet,

    outOfStockIndicator: {
      description: "Out-of-stock or notify-me state indicator",
      candidates: [
        'button:has-text("Notify Me")',
        'button:has-text("Out of Stock")',
        'button:has-text("Sold Out")',
        '[class*="sold-out"]',
        '[class*="out-of-stock"]',
        // Lazada often keeps standard buttons visible but disabled when out-of-stock
        'button[disabled]:has-text("Add to Cart")',
        'button[disabled]:has-text("Buy Now")',
        'button[aria-disabled="true"]:has-text("Add to Cart")',
        'button[aria-disabled="true"]:has-text("Buy Now")',
      ],
      required: false,
    } satisfies SelectorSet,

    quantityInput: {
      description: "Quantity selector input on the product page",
      candidates: [
        'input[class*="quantity-input"]',
        'input[aria-label*="quantity"]',
        'input[aria-label*="Quantity"]',
        'input[class*="qty"]',
      ],
      required: false,
    } satisfies SelectorSet,
  },

  // ---- Account wishlist page (wishlist monitor mode) -----------------------
  // UNVERIFIED against live Lazada — run `npm run verify-selectors` (it opens the
  // wishlist URL and reports matches) before trusting these for a live drop.
  // The live page groups cards under "Watchlist" (in stock, with an Add to Cart
  // button) and "Out of Stock" (greyed, "NOT AVAILABLE" overlay, no Add to Cart).
  wishlist: {
    cardList: {
      description: "A wishlist item card (container). Used as the adaptive-settle anchor and iterated for classification.",
      candidates: [
        '[class*="wishlist"] [class*="item"]',
        '[class*="favorite"] [class*="card"]',
        '[data-spm*="wishlist"] [class*="item"]',
        '[class*="Wishlist"] [class*="item"]',
      ],
      required: false,
    } satisfies SelectorSet,

    cardProductLink: {
      description: "Anchor inside a wishlist card linking to the PDP (href carries -i<digits>.html)",
      candidates: [
        'a[href*="/products/"]',
        'a[href*="-i"][href*=".html"]',
        'a[href*="lazada.sg"]',
      ],
      required: false,
    } satisfies SelectorSet,

    cardAddToCart: {
      description: "Enabled Add to Cart button on a wishlist card — presence ⇒ in stock",
      candidates: [
        'button[data-spm-click*="cart"]:not([disabled])',
        'button[class*="add-to-cart"]:not([disabled])',
        'button:has-text("Add to Cart"):not([disabled])',
      ],
      required: false,
    } satisfies SelectorSet,

    cardOutOfStock: {
      description: "Out-of-stock marker on a wishlist card (NOT AVAILABLE overlay / sold-out)",
      candidates: [
        ':has-text("NOT AVAILABLE")',
        ':has-text("Out of Stock")',
        ':has-text("Sold Out")',
        '[class*="sold-out"]',
        '[class*="out-of-stock"]',
        'button:has-text("Notify Me")',
      ],
      required: false,
    } satisfies SelectorSet,
  },

  // ---- Cart page -----------------------------------------------------------
  cart: {
    proceedToCheckout: {
      description: "Proceed to Checkout button on the cart page",
      candidates: [
        'button:has-text("Proceed to Checkout")',
        'a:has-text("Proceed to Checkout")',
        'button:has-text("Checkout")',
        '[class*="checkout-btn"]',
      ],
      required: true,
    } satisfies SelectorSet,
  },

  // ---- Checkout page -------------------------------------------------------
  checkout: {
    deliveryAddress: {
      description: "Selected delivery address block on the checkout page",
      candidates: [
        '[class*="delivery-address"]',
        '[class*="shipping-address"]',
        '[data-spm*="address"]',
        '[class*="address-box"]',
      ],
      required: false,
    } satisfies SelectorSet,

    paymentMethodOption: {
      description: "Individual payment method option row",
      candidates: [
        '[class*="payment-option"]',
        '[class*="payment-method-item"]',
        '[class*="payment-item"]',
      ],
      required: false,
    } satisfies SelectorSet,

    selectedPaymentLabel: {
      description: "Label of the currently selected payment method",
      candidates: [
        '[class*="payment-option"][class*="selected"] [class*="title"]',
        '[class*="payment-method"][aria-selected="true"]',
        '[class*="selected-payment"] [class*="label"]',
      ],
      required: false,
    } satisfies SelectorSet,

    placeOrderButton: {
      description: "Final Place Order / Confirm Order button",
      candidates: [
        'button:has-text("Place Order")',
        'button:has-text("Confirm Order")',
        'button[class*="place-order"]',
        'button[class*="submit-order"]',
      ],
      required: true,
    } satisfies SelectorSet,

    orderTotal: {
      description: "Total amount displayed on the checkout summary",
      candidates: [
        '[class*="order-total"] [class*="price"]',
        '[class*="total-amount"]',
        '[class*="grand-total"]',
      ],
      required: false,
    } satisfies SelectorSet,
  },

  // ---- Order confirmation page ---------------------------------------------
  confirmation: {
    successHeading: {
      description: "Heading present only on a successful order confirmation page",
      candidates: [
        '[class*="order-success"]',
        'h1:has-text("Thank You")',
        'h2:has-text("Thank You")',
        'h1:has-text("Order Placed")',
        '[class*="success-title"]',
      ],
      required: false,
    } satisfies SelectorSet,

    orderNumber: {
      description: "Order ID / reference number on the confirmation page",
      candidates: [
        '[class*="order-number"]',
        '[class*="order-id"]',
        'span:has-text("Order No.")',
        '[class*="order-sn"]',
      ],
      required: false,
    } satisfies SelectorSet,
  },
} as const;

// ---------------------------------------------------------------------------
// resolveSelector — tries each candidate in order, returns first match
// ---------------------------------------------------------------------------

export class SelectorNotFoundError extends Error {
  constructor(description: string, candidates: readonly string[]) {
    super(
      `Required selector not found: "${description}"\nCandidates tried: ${candidates.join(", ")}`
    );
    this.name = "SelectorNotFoundError";
  }
}

/**
 * Returns the first candidate selector that is visible on the page.
 * For required selectors, throws SelectorNotFoundError if none match.
 * For optional selectors, returns null.
 */
export async function resolveSelector(
  page: Page,
  selectorSet: SelectorSet,
  timeoutMs = 3000
): Promise<ResolvedSelector | null> {
  for (let i = 0; i < selectorSet.candidates.length; i++) {
    const candidate = selectorSet.candidates[i]!; // safe: i is within bounds (loop invariant)
    try {
      const visible = await page
        .locator(candidate)
        .first()
        .isVisible({ timeout: timeoutMs });
      if (visible) {
        return { selector: candidate, candidateIndex: i };
      }
    } catch {
      // Selector timed out or threw — try next candidate
    }
  }

  if (selectorSet.required) {
    throw new SelectorNotFoundError(selectorSet.description, selectorSet.candidates);
  }
  return null;
}

/**
 * Like resolveSelector but scoped to a sub-tree (e.g. a single wishlist card)
 * instead of the whole page. Keeps per-card matching inside the abstraction
 * layer rather than inlining page.locator() in business logic.
 */
export async function resolveSelectorWithin(
  scope: Locator,
  selectorSet: SelectorSet,
  timeoutMs = 2000
): Promise<ResolvedSelector | null> {
  for (let i = 0; i < selectorSet.candidates.length; i++) {
    const candidate = selectorSet.candidates[i]!;
    try {
      const visible = await scope.locator(candidate).first().isVisible({ timeout: timeoutMs });
      if (visible) {
        return { selector: candidate, candidateIndex: i };
      }
    } catch {
      // try next candidate
    }
  }

  if (selectorSet.required) {
    throw new SelectorNotFoundError(selectorSet.description, selectorSet.candidates);
  }
  return null;
}

/**
 * Checks every selector set in the registry and returns a summary.
 * Used by dry-run selector verification mode.
 */
export async function verifySelectorPage(
  page: Page,
  group: Record<string, SelectorSet>
): Promise<Record<string, { resolved: boolean; winner: string | null }>> {
  const results: Record<string, { resolved: boolean; winner: string | null }> = {};

  for (const [key, selectorSet] of Object.entries(group)) {
    const resolved = await resolveSelector(page, selectorSet, 2000).catch(() => null);
    results[key] = {
      resolved: resolved !== null,
      winner: resolved?.selector ?? null,
    };
  }

  return results;
}
