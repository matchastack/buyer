# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automated monitor and checkout assistant for Pokemon Center SG products on Lazada SG. TypeScript + Playwright (headed Chromium). Runs one worker per configured item that polls a product page, decides whether to buy, clicks Buy Now, selects PayNow, and places the order. Lazada then presents a PayNow QR which the user scans to complete payment.

## Commands

```bash
npm run build               # tsc → dist/
npm run dev                 # ts-node src/index.ts (reads config.json + .env)
npm run dev:dry-run         # Force dry-run regardless of config.settings.dryRun
npm run start               # Run the built dist/index.js
npm run start:dry-run       # Built version, forced dry-run
npm run verify-selectors    # Headed dry-run that opens login + first product page
                            #   and reports which selector candidates resolve
npm run list-wishlist       # Read-only diagnostic: logs every item on the account
                            #   wishlist (itemId, title, stock) and each config item's
                            #   match result — use to fix a failing wishlist match
npm run auth-debug          # Headed, observable login: clears cookies and steps through
                            #   fill email → fill password → submit → homepage, writing a
                            #   screenshot + HTML per step to data/debug/auth/ (no secrets logged)
npm run dev:dry-run -- --debug-dom   # Same as dev:dry-run but also writes a full-page
                            #   screenshot + HTML + per-selector match report to data/debug/
                            #   on every stock check. Use when investigating selector bugs.
npm test                    # vitest run (one-shot)
npm run test:watch          # vitest watch mode
npm run test:coverage       # vitest with coverage

# Run a single test file or filter by name:
npx vitest run tests/decision.test.ts
npx vitest run -t "returns proceed=false in dry-run mode"
```

First-time setup: copy `config.example.json` → `config.json` and `.env.example` → `.env`. Both are git-ignored. Credentials (`LAZADA_EMAIL`, `LAZADA_PASSWORD`) MUST come from env vars — `config.ts` rejects any `credentials`/`email`/`password` key found in `config.json`.

## Architecture

`src/index.ts::main` is the orchestrator. There are two monitor modes, chosen by `settings.monitorMode`:

**`per-item`** (default) — a strict three-stage flow per item, with safety gates between each stage:

```
config + env  ──►  auth (load/restore session, login if needed)
                       │
                       ▼
   For each item, in parallel (Promise.allSettled):
       monitor.waitForStock ──► decision.shouldProceed ──► checkout
              (polls)              (pure function)         (Buy Now → PayNow QR)
```

**`wishlist`** — one watcher polls the account wishlist and fans out restock signals to N buyers (one full page load per cycle regardless of item count → far lower anti-bot footprint). Buyer pages are pre-opened and warm:

```
config + env ──► auth ──► one watcher page + N buyer pages
   wishlist-monitor.watchWishlist  ──fire(productId)──►  RestockRegistry gate
       (classifies every item per poll)                         │
                                                                 ▼
                                          runBuyerWorker awaits gate, then
                                          reload PDP ──► checkout (fast retry profile)
```

In wishlist mode the watcher is a single point of failure: on `login_required` it halts the run (aborts the controller) so all buyers exit for re-auth.

### Module roles

- **`index.ts`** — Calls `dotenv.config()` to load `.env`, validates config, launches Chromium with anti-automation flags, applies the stealth init script (when `settings.stealth`), restores session. Branches on `settings.monitorMode`: `per-item` spawns one `runItemWorker` per item (passes `settings.fastCheckout` to `checkout`); `wishlist` opens one watcher page + N pre-opened buyer pages, builds a `RestockRegistry`, runs `watchWishlist`, and spawns one `runBuyerWorker` per item (idles on its gate, then reloads its warm PDP and runs `checkout` with a fast retry profile). SIGINT/SIGTERM trigger graceful shutdown that saves session and closes browser.
- **`wishlist-monitor.ts`** — Wishlist watcher. `watchWishlist` polls `settings.wishlistUrl` and classifies **every** tracked item per poll from the **JSON Lazada embeds in the served HTML** (`decision.parseWishlistStock`: `lightItemDetailDTO` = all wishlist items, `outOfStock` = the OOS subset). Config item → wishlist entry matching is **title-first** (`decision.matchWishlistItem`: exact normalized title, then unique title-substring, then URL id via `extractProductId`) because config URLs can be non-canonical — but classifications and the registry/gates stay keyed by the **config-URL product id**. No DOM scraping — robust to UI/CSS changes and needs no render settle (the data is present at domcontentloaded). `fire`s the item's gate on an out_of_stock→in_stock transition (pure `isRestockTransition`). Mirrors `monitor.ts` challenge-survival; halts loudly on `login_required`. **Pauses while any buy is in flight** (`isPaused` callback wired to a shared `activeBuys` counter in `index.ts`): the buy is the session's peak request rate, and stacking wishlist reloads on top primes anti-bot punishment — fired gates are latched, so pausing loses nothing for the item being bought. `verify-selectors` reports the parsed wishlist payload (item count + per-config-item match), not selectors. When a match fails (`item_not_found_on_wishlist`), run `npm run list-wishlist` to see the wishlist's actual ids/titles/stock and fix the config.
- **`restock-signal.ts`** — `RestockRegistry` / `RestockGate`: the producer/consumer link. Latched, edge-triggered, re-armable gates keyed by product id. The watcher fires gates; buyers `await waitForRestock(signal)`. Impure (holds promises) so it lives outside `decision.ts`. `abortAll()` + controller abort wake idle buyers on shutdown.
- **`config.ts`** — Loads + validates `config.json`. `loadCredentials()` is the only path to env-var credentials and throws if missing. Strict key allow-listing — unknown keys throw. `dryRun` defaults to `true`.
- **`auth.ts`** — Session cookies persisted to disk with mode `0o600`. `detectChallenge` checks URL patterns (pure `decision.isChallengeUrl`: `/baxia/`, `/block`, `/robot`, `captcha`, `/cdn-cgi/challenge-platform/`, `/awswaf/`, `/sec/`, plus the Alibaba x5sec punish shape `_____tmd_____`/`/punish`/`x5secdata` seen live) and DOM markers (captcha frames, slider, rate-limit pages). Any challenge throws `ChallengeDetectedError` — the script never attempts to solve CAPTCHAs, MFA, or rate limits. Lazada moved auth to `member.lazada.sg` — the login page is `settings.loginUrl` (default `https://member.lazada.sg/user/login`; the old `www.lazada.sg/customer/account/login/` 404s, which is what silently broke login). `isLoggedIn` uses **positive + negative** detection (`login.loggedInIndicator` = `#myAccountTrigger`/account section vs `login.loginLink` = `#anonLogin`) and **fails toward logged-out** when neither matches — do not regress to inferring "logged in" purely from the absence of a login link (that false-positive skipped login on a dead session). `runAuthDebug` (CLI `--auth-debug`) clears cookies and steps through the login visibly, snapshotting each step to `data/debug/auth/`; credential values are never logged.
- **`monitor.ts`** — `waitForStock` polls a product page at `checkIntervalMs` with an interruptible sleep (checks `AbortSignal` every 500ms). Each check waits for the page to render via an **adaptive settle** (`waitForProductReady`): it returns the instant the price anchor is visible, capped at `pollSettleMs`, instead of burning a fixed delay — this plus the lowered cadence floors (`checkIntervalMs >= 1000`, `minPageLoadDelayMs >= 250`) is what lets the sampling rate sit under the ~3s restock window. Defaults are intentionally aggressive; raise them for a calmer watch. Never throws on transient page errors; returns `StockCheckResult` with status `unknown` so the caller decides. On `login_required` it returns immediately. On `anti_bot`: if `settings.surviveChallenges` is true (default) it backs off via `computeChallengeBackoff` (exponential from `challengeBackoffBaseMs`, capped at `challengeBackoffMaxMs`) and **resumes** monitoring so a single challenge doesn't end the 2-hour watch — a circuit breaker (`maxConsecutiveChallenges`) stops endless hammering and returns `anti_bot`. With `surviveChallenges: false` it returns `anti_bot` immediately (legacy fail-closed).
- **`decision.ts`** — **Pure functions only.** No I/O, no Playwright, no fs, no console. `shouldProceed`, `isPriceAcceptable`, `computeBackoff`, `computeChallengeBackoff`, `isChallengeUrl` (the anti-bot URL pattern list, incl. the x5sec punish shape), `extractProductId` (parses both Lazada URL shapes: `…-i<digits>.html` and id-first `…/i<digits>-s<sku>.html`), `isRestockTransition`, `parseWishlistStock`/`classifyFromWishlistState` (read stock + decoded titles from the wishlist's embedded `lightItemDetailDTO`/`outOfStock` JSON with a string-aware array scanner), `matchWishlistItem`/`normalizeTitle`/`decodeJsonString` (title-first config→wishlist matching), `formatOrderSummary`. Keep this discipline — these are the unit-test core. Note: `isPriceAcceptable(null, …)` returns `true` (unknown price is not a skip reason — the user controls payment via the PayNow QR).
- **`checkout.ts`** — **Dry-run guard is the first check** (before any navigation). **Fast path:** when called with `alreadyOnProductPage` (driven by `settings.fastCheckout`), the *first* attempt skips both the rate-limiter wait and the re-navigation and acts on the live in-stock page the monitor just left — this is the key change that makes the sub-3s window winnable. Retries (and all attempts when fast path is off) re-navigate with a rate-limit slot as before. Clicks **Buy Now** only — no Add to Cart fallback — but **waits (bounded, `BUY_NOW_WAIT_MS`) for the button via `waitForSelectorSet`** rather than sampling the instant page state: Lazada PDP/checkout pages hydrate after domcontentloaded, so instant checks always miss (this exact bug produced 5× `buy_now_unavailable` at ~110ms each on a live run). The same waiting applies to the checkout page's Place Order CTA, the PayNow option scan, and confirmation detection. **Checkout-page arrival is element-gated, not URL-gated** — "we are on the checkout page" := the Place Order CTA is visible (`CHECKOUT_READY_WAIT_MS=15s`). The old `waitForUrl(/checkout path/)` gate timed out on every live run because Lazada SG checkout lives on the `checkout.lazada.sg` **host** (pathname `/`), and its `load` event may never fire. **Checkout-ready and PayNow selection are one OVERLAPPED loop (`waitForCheckoutReadyAndPayNow`), not sequential:** it drives PayNow selection *while* the page hydrates, so the payment work hides inside the (irreducible, ~1.6s) Buy Now→checkout transition instead of adding after it — this is the change that took a live buy from ~3.4s toward ~2s. It exits only when **both** the Place Order CTA is visible **and** PayNow is positively confirmed (so the fail-closed guardrail can't be bypassed); the CTA's 15s deadline still throws `SelectorNotFoundError` (retryable) and PayNow's `PAYMENT_OPTIONS_WAIT_MS=8s` deadline (measured from CTA-seen) still returns the non-retryable abort. **The loops poll at `CHECKOUT_POLL_MS=75` (was 250)** — faster polling is pure client-side CPU (DOM `isVisible`/URL reads, never a Lazada request), so it trims latency with no added anti-bot footprint. **The waits stay challenge-aware:** each pass runs `detectChallenge` (throttled to ~`CHALLENGE_CHECK_MS=300` so the 75ms poll doesn't multiply checks), so an anti-bot punish redirect throws `ChallengeDetectedError` immediately (clean halt + `checkout-challenge-*` snapshot) instead of masquerading as a selector timeout and re-clicking Buy Now into a flagged session — exactly what a live x5sec punish produced. **Every failed attempt** logs the page URL and writes an always-on `checkout-failed-<item>-attempt<N>` snapshot (the terminal snapshot only preserves the last attempt's page; the first attempt is usually the informative one). On terminal failure (all retries exhausted) it additionally writes the full forensic snapshot (screenshot + HTML + `describeProductSelectors` report) to `<dataDir>/debug/` — none of this is gated by `debugSnapshots`, because that page state is the only evidence of why the buy failed. **PayNow is fail-closed (dev-phase guardrail):** the checkout page offers a saved card next to PayNow, so the overlapped loop must positively confirm PayNow as the *selected* method (via `paymentSelectedIndicator` text, after optionally clicking the PayNow row — at most once/sec, `isPayNowConfirmed` is the proof it landed) before Place Order is ever clicked. If it can't confirm within `PAYMENT_OPTIONS_WAIT_MS`, the loop returns `paynow-unconfirmed` and `attemptCheckout` **aborts without placing the order**, logs `paynow_not_confirmed`, writes an always-on `paynow-not-confirmed-*` snapshot, and returns a sentinel error that the retry loop treats as **non-retryable** (re-running Buy Now can't fix a selector mismatch and would stack abandoned checkouts). **The PayNow QR page counts as success:** `waitForConfirmation` accepts *either* the classic order-success page (extracts order number) *or* the PayNow QR / cashier page (`confirmation.paymentPending` markers or a navigation to a `cashier`/`pay` URL) → success with `orderNumber: null`, logs `paynow_qr_displayed`. That QR is the user's scan-to-pay handoff: the buyer worker returns (terminates) and the headed browser stays open on the QR while other workers keep running. Both success shapes capture an always-on `order-confirmed-*` snapshot — now **fire-and-forget** via `CheckoutResult.pendingSnapshot`: success returns the instant the QR/order page is detected, so the screenshot+HTML write no longer inflates `place_order_to_confirm` or the real time-to-QR; the workers drain `pendingSnapshot` before any `page.close()` (monitor mode closes the page on return) so the capture isn't truncated. Retries with exponential backoff; the profile defaults to `retryBackoffBaseMs/retryBackoffMaxMs/maxRetries` but an optional `RetryProfile` arg overrides it (wishlist buyers pass a fast sub-second profile: `buyRetryBaseMs/buyRetryMaxMs/buyMaxRetries`). The retry loop already covers transient OOS (Buy Now not visible) — that is the "traffic vs genuine sellout" retry. `ChallengeDetectedError` is re-thrown so `index.ts` shuts down.
- **`payment-approval.ts`** — Human approval gate (stdin readline or Telegram inline keyboard). **Not currently called from `checkout.ts`** — the PayNow QR serves as the payment confirmation step. The module is retained for reference if the gate is needed again.
- **`browser-actions.ts`** — Thin Playwright wrappers (`navigateTo`, `clickElement`, `fillInput`, `extractText`, `isVisible`, `waitForUrl`). They **only accept `SelectorSet` objects, never raw CSS strings** — this is enforced by type. `navigateTo` retries 3× with backoff.
- **`selectors.ts`** — The single source of truth for every DOM selector in the app. `SELECTORS` is structured by page (`login`, `antiBot`, `product`, `cart`, `checkout`, `confirmation`). Each `SelectorSet` has `candidates` (tried in order, first visible wins), `description`, and `required` (true ⇒ throw `SelectorNotFoundError`; false ⇒ return null). Text-based `:has-text()` candidates are listed last as resilient fallbacks. **Two resolvers:** `resolveSelector` is an *instant* single pass — Playwright's `isVisible` ignores its timeout option, so the `timeoutMs` arg never waited and never will; `waitForSelectorSet(page, set, timeoutMs)` is the waiting counterpart (re-polls until visible or deadline, returns the moment a candidate appears). Use the waiting one anywhere the element may still be hydrating (checkout does); the instant one only on pages already settled (the monitor, after `waitForProductReady`). (Wishlist mode does **not** use selectors — it parses embedded JSON; see `wishlist-monitor.ts`.) **Selectors are unverified against live Lazada pages — run `npm run verify-selectors` after any Lazada UI change.**
- **`diagnostics.ts`** — DOM-capture helpers for debugging selector issues. `captureDomSnapshot` saves a full-page screenshot + HTML to `<dataDir>/debug/`. `describeProductSelectors` logs each `SELECTORS.product` set with `{ winner, matchCount, firstText, firstVisible, firstEnabled }` — the `matchCount` shows whether a selector resolves once (real buy-box) or many times (carousels). Activated by `--debug-dom` or `"debugSnapshots": true` in config; no-ops otherwise.
- **`health.ts`** — Optional local HTTP metrics server. `startHealthServer(port, getStatus)` binds to `127.0.0.1` only (never `0.0.0.0`) using Node's built-in `http` module. Responds to any request with a JSON `RuntimeStatus` snapshot (per-item check counts, last stock status, checkout/purchase tallies). Enabled only when `settings.healthPort > 0`; disabled by default (`healthPort: 0`).
- **`rate-limiter.ts`** — Per-domain `acquire(domain)` enforces `minIntervalMs` since last request plus random jitter up to `maxJitterMs`. Called before every page navigation in `monitor` and on `checkout` retries — but **deliberately skipped on the fast-checkout first attempt**, where the latency would lose the drop.
- **`stealth.ts`** — `applyStealth(context)` adds a browser-context init script (run before page scripts on every navigation) that masks common automation fingerprints: `navigator.webdriver`, empty `plugins`/`mimeTypes`, `languages`, `window.chrome`, the notifications permission query, WebGL vendor/renderer, and hardware profile. This is **avoidance, not bypass** — it lowers how often a challenge fires; it never solves a CAPTCHA. Enabled by `settings.stealth` (default true). Shipped as a string because the project has no DOM lib.
- **`logger.ts`** — Append-only JSONL audit log at `logs/audit-YYYY-MM-DD.log` plus colored stdout/stderr. Never truncates. Logging errors are swallowed so the main process can never crash from log I/O.
- **`timing.ts`** — `PhaseTimer` (injectable clock) records wall-clock durations between named marks (`mark` = delta since the previous mark; `markAt(name, at)` = delta up to an explicit absolute timestamp, for **overlapping** phases — pass non-decreasing `at`s, clamp at the call site). Used to measure the buy path: `checkout.ts` logs `checkout_timing` (phase breakdown: nav/locate_buy_now/buy_now_to_checkout/select_payment/place_order_to_confirm), and the workers log `instock_to_confirm` (headline detection→confirm `durationMs`; the wishlist buyer also splits out `reloadMs`). Since checkout-ready and PayNow now overlap, `buy_now_to_checkout` is marked at CTA-seen and `select_payment` at PayNow-confirmed via `markAt` — so **`select_payment≈0` is the intended signal that payment fully hid under the hydration window**, and a non-zero value means payment was the residual bottleneck. **Timing only populates on a real purchase** — `checkout` short-circuits at the dry-run guard, so `dryRun:false` is required to see buy-phase timings.

### Cross-cutting invariants

- **Credentials never touch `config.json` or logs.** `config.ts` rejects credential keys at the top level. After login, `auth.ts` overwrites the in-memory password string immediately.
- **Dry-run defaults to true** at both `DEFAULTS` (config.ts) and the example config. Live purchases require explicitly setting `"dryRun": false` AND not passing `--dry-run`. CLI flag always wins (force-enables dry-run).
- **Anti-bot handling — tuned for a 2-hour continuous watch, not strictly fail-closed.** During monitoring, a challenge backs off and resumes (see `monitor.ts`) so the watch survives, bounded by `maxConsecutiveChallenges`. During **login** and **checkout** it is still fail-closed: `ChallengeDetectedError` propagates and halts. The script never *solves* a CAPTCHA/MFA — survival means waiting it out and retrying, plus stealth to avoid tripping it. Set `surviveChallenges: false` to restore the old halt-on-first-challenge behaviour.
- **Selector additions go through the abstraction.** Don't inline `page.locator("…")` calls outside `selectors.ts`/`browser-actions.ts`. Add a new `SelectorSet` to the relevant group in `SELECTORS` with multiple candidates and pick the right `required` flag.
- **Payment is always PayNow.** `checkout.ts` hardcodes the method to `"paynow"` regardless of config. Lazada displays a QR code after Place Order is clicked; the user scans it to transfer funds. This is the final human confirmation step.
- Tests run against pure logic (`decision`, `rate-limiter`, `config`). There are no Playwright/integration tests — exercise UI changes manually via `verify-selectors` and headed `dev:dry-run`.

## Runtime artifacts (git-ignored)

- `config.json` — your real config
- `.env` — your credentials
- `data/` — runtime artifacts root (configurable via `settings.dataDir`, default `"data"`)
  - `data/session.json` — persisted cookies (mode 0600)
  - `data/logs/audit-YYYY-MM-DD.log` — JSONL audit trail
  - `data/debug/<item>-<timestamp>.png` / `.html` — DOM snapshots (only when `--debug-dom` is active)
- `dist/` — tsc output

## Development workflow

For every task:

1. Sync the feature branch with the latest `main`: `git fetch origin main && git merge origin/main`
2. Complete the task
3. Update all relevant documentation (CLAUDE.md, inline comments, config.example.json)
4. Sync with `main` again and resolve any merge conflicts before pushing
5. Create a pull request
