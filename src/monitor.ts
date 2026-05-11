import { Page } from "playwright";
import { Item, CheckResult, StockStatus } from "./types";

// Selectors based on Lazada SG product page structure (update if Lazada redesigns)
const SELECTORS = {
  // Price element on product detail page
  price: '[class*="pdp-price"], [class*="price-container"] [class*="price"]',
  // Add to Cart button (enabled = in stock)
  addToCart: 'button[data-spm-click*="cart"], button:has-text("Add to Cart")',
  // Buy Now button (faster path to checkout)
  buyNow: 'button[data-spm-click*="buynow"], button:has-text("Buy Now")',
  // Out-of-stock indicators
  outOfStock: 'button:has-text("Sold Out"), button:has-text("Out of Stock"), button:has-text("Notify Me")',
};

export async function checkStock(page: Page, item: Item): Promise<CheckResult> {
  try {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500); // allow dynamic content to settle
  } catch (err) {
    console.error(`[monitor] Failed to load page for "${item.name}":`, err);
    return { status: "unknown", price: null, itemName: item.name };
  }

  const price = await extractPrice(page);
  const status = await determineStockStatus(page, item, price);

  return { status, price, itemName: item.name };
}

async function extractPrice(page: Page): Promise<number | null> {
  try {
    const el = page.locator(SELECTORS.price).first();
    const text = await el.textContent({ timeout: 5000 });
    if (!text) return null;
    // Parse "$XX.XX" or "S$XX.XX"
    const match = text.match(/[\d,]+\.?\d*/);
    return match ? parseFloat(match[0].replace(",", "")) : null;
  } catch {
    return null;
  }
}

async function determineStockStatus(
  page: Page,
  item: Item,
  price: number | null
): Promise<StockStatus> {
  // Check for explicit out-of-stock markers first
  const soldOutVisible = await page
    .locator(SELECTORS.outOfStock)
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (soldOutVisible) return "out_of_stock";

  const buyNowVisible = await page
    .locator(SELECTORS.buyNow)
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  const addToCartVisible = await page
    .locator(SELECTORS.addToCart)
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!buyNowVisible && !addToCartVisible) return "unknown";

  // Enforce max price guard
  if (price !== null && price > item.maxPrice) {
    console.log(
      `[monitor] "${item.name}" is available at $${price} but exceeds maxPrice $${item.maxPrice}. Skipping.`
    );
    return "out_of_stock"; // treat as skip-worthy
  }

  return "available";
}

export async function waitForStock(
  page: Page,
  item: Item,
  intervalMs: number,
  signal: { stop: boolean }
): Promise<CheckResult> {
  console.log(`[monitor] Watching "${item.name}" every ${intervalMs / 1000}s...`);

  while (!signal.stop) {
    const result = await checkStock(page, item);

    if (result.status === "available") {
      console.log(`[monitor] "${item.name}" is IN STOCK at $${result.price}!`);
      return result;
    }

    if (result.status === "out_of_stock") {
      console.log(`[monitor] "${item.name}" not available. Checking again in ${intervalMs / 1000}s...`);
    } else {
      console.warn(`[monitor] Unknown status for "${item.name}". Retrying...`);
    }

    await page.waitForTimeout(intervalMs);
  }

  throw new Error(`[monitor] Stopped watching "${item.name}".`);
}
