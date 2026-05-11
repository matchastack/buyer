import { Page } from "playwright";
import { Item, Settings } from "./types";

// Lazada checkout page selectors (update if Lazada redesigns the checkout flow)
const SELECTORS = {
  buyNow: 'button[data-spm-click*="buynow"], button:has-text("Buy Now")',
  addToCart: 'button[data-spm-click*="cart"], button:has-text("Add to Cart")',
  quantityInput: 'input[class*="quantity"], input[aria-label*="quantity"]',

  // Checkout page
  checkoutPage: '[class*="checkout"], [data-spm*="checkout"]',
  placeOrderBtn: 'button:has-text("Place Order"), button:has-text("Confirm Order"), button[class*="place-order"]',
  addressSection: '[class*="address"], [data-spm*="address"]',
  editAddressBtn: 'button:has-text("Change"), button:has-text("Edit Address")',

  // Payment section
  paymentSection: '[class*="payment"], [data-spm*="payment"]',
  paymentOption: '[class*="payment-option"], [class*="payment-method"]',

  // Order confirmation
  orderSuccess: '[class*="order-success"], [class*="success"], h2:has-text("Thank you"), h1:has-text("Order Placed")',
  orderNumber: '[class*="order-number"], [class*="order-id"]',
};

export async function buyItem(page: Page, item: Item, settings: Settings): Promise<boolean> {
  for (let attempt = 1; attempt <= settings.maxRetries; attempt++) {
    try {
      console.log(`[checkout] Attempt ${attempt}/${settings.maxRetries} for "${item.name}"`);
      const success = await attemptCheckout(page, item, settings);
      if (success) return true;
    } catch (err) {
      console.error(`[checkout] Attempt ${attempt} failed:`, err);
      if (attempt < settings.maxRetries) {
        await page.waitForTimeout(3000);
      }
    }
  }
  return false;
}

async function attemptCheckout(page: Page, item: Item, settings: Settings): Promise<boolean> {
  // Navigate to the product page
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Set quantity if > 1
  if (item.quantity > 1) {
    await setQuantity(page, item.quantity);
  }

  // Click "Buy Now" to go directly to checkout (preferred over Add to Cart)
  const buyNowBtn = page.locator(SELECTORS.buyNow).first();
  const addToCartBtn = page.locator(SELECTORS.addToCart).first();

  if (await buyNowBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await buyNowBtn.click();
    console.log("[checkout] Clicked Buy Now.");
  } else if (await addToCartBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addToCartBtn.click();
    console.log("[checkout] Clicked Add to Cart — navigating to cart...");
    await navigateToCheckout(page);
  } else {
    throw new Error("Neither Buy Now nor Add to Cart button found.");
  }

  // Wait for checkout page to load
  await page.waitForURL((url) => url.toString().includes("/checkout") || url.toString().includes("/cart"), {
    timeout: 15000,
  });
  await page.waitForTimeout(2000);

  // If landed on cart, proceed to checkout
  if (page.url().includes("/cart")) {
    await navigateToCheckout(page);
    await page.waitForTimeout(2000);
  }

  console.log("[checkout] On checkout page.");

  // Select payment method
  await selectPaymentMethod(page, settings.paymentMethod);

  // Place the order
  return await placeOrder(page);
}

async function setQuantity(page: Page, quantity: number): Promise<void> {
  const input = page.locator(SELECTORS.quantityInput).first();
  if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
    await input.click({ clickCount: 3 });
    await input.fill(String(quantity));
  }
}

async function navigateToCheckout(page: Page): Promise<void> {
  // From cart page, click the checkout/proceed button
  const checkoutBtn = page.locator(
    'button:has-text("Proceed to Checkout"), button:has-text("Checkout"), a:has-text("Checkout")'
  ).first();

  if (await checkoutBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await checkoutBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function selectPaymentMethod(page: Page, paymentMethod: string): Promise<void> {
  const method = paymentMethod.toLowerCase();
  console.log(`[checkout] Selecting payment method: ${paymentMethod}`);

  // Look for payment options by label text (partial match)
  const options = page.locator(SELECTORS.paymentOption);
  const count = await options.count().catch(() => 0);

  if (count === 0) {
    console.warn("[checkout] No payment options found — proceeding with current selection.");
    return;
  }

  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = ((await option.textContent().catch(() => "")) ?? "").toLowerCase();

    if (
      (method === "cod" && (text.includes("cash on delivery") || text.includes("cod"))) ||
      (method === "credit_card" && (text.includes("credit") || text.includes("debit") || text.includes("card"))) ||
      (method === "paynow" && text.includes("paynow")) ||
      (method !== "cod" && method !== "credit_card" && method !== "paynow" && text.includes(method))
    ) {
      await option.click().catch(() => {});
      console.log(`[checkout] Selected payment method matching "${paymentMethod}".`);
      await page.waitForTimeout(1000);
      return;
    }
  }

  console.warn(`[checkout] Payment method "${paymentMethod}" not found — using current default.`);
}

async function placeOrder(page: Page): Promise<boolean> {
  const placeOrderBtn = page.locator(SELECTORS.placeOrderBtn).first();

  if (!(await placeOrderBtn.isVisible({ timeout: 10000 }).catch(() => false))) {
    throw new Error("Place Order button not found on checkout page.");
  }

  console.log("[checkout] Clicking Place Order...");
  await placeOrderBtn.click();

  // Wait for order confirmation page
  try {
    await page.waitForSelector(SELECTORS.orderSuccess, { timeout: 20000 });
    const orderNumEl = page.locator(SELECTORS.orderNumber).first();
    const orderNum = (await orderNumEl.textContent({ timeout: 3000 }).catch(() => "")) ?? "";
    console.log(`[checkout] Order placed successfully! Order: ${orderNum.trim() || "(number not found)"}`);
    return true;
  } catch {
    // Check if we're still on checkout (payment may have failed or extra step needed)
    if (page.url().includes("/checkout")) {
      const pageText = await page.locator("body").textContent().catch(() => "");
      if (pageText?.toLowerCase().includes("failed") || pageText?.toLowerCase().includes("error")) {
        throw new Error("Payment failed or an error occurred at checkout.");
      }
      // Possibly a 3DS/OTP step — wait for manual resolution
      console.warn("[checkout] Waiting for manual step (3DS/OTP) — up to 90s...");
      await page.waitForSelector(SELECTORS.orderSuccess, { timeout: 90000 });
      return true;
    }
    throw new Error("Order confirmation not detected.");
  }
}
