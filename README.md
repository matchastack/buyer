# Pokemon Center Buyer

Automated monitor and checkout assistant for Pokemon Center SG drops on
Lazada. It polls product pages on a jittered schedule, decides whether to
proceed based on stock and price rules, drives a real Chromium browser through
Lazada's checkout via Playwright, and places the order via **PayNow** — Lazada
displays a QR code which you scan to complete the transfer.

> This tool is intended for **personal use** to help you compete with bots on
> limited drops. It does not bypass payment, does not store credentials in
> the repo. PayNow QR scanning is the final human confirmation step.

---

## Safety model

The whole design is shaped by four invariants. None of them are optional:

1. **Dry-run is the default.** `settings.dryRun: true` ships in
   `config.example.json` and is also the in-code default. Purchases are
   skipped entirely until you flip it. `--dry-run` on the CLI forces it back
   on regardless of config.
2. **Credentials never live in `config.json`.** They come from environment
   variables (`LAZADA_EMAIL`, `LAZADA_PASSWORD`), loaded from a `.env` file
   that is `.gitignore`d. The config loader rejects any config with a
   `credentials`, `email`, or `password` key.
3. **Payment requires a human action.** The checkout uses PayNow exclusively.
   After Place Order is clicked, Lazada displays a PayNow QR code that you
   must scan and approve in your banking app — money never moves without you
   physically completing that step.
4. **Anti-bot challenges halt immediately.** CAPTCHA / slider / rate-limit
   pages are detected, logged, and the run aborts. The code does not attempt
   to solve them.

---

## Quick start

```bash
# 1. Install
npm ci
npx playwright install --with-deps chromium

# 2. Configure
cp .env.example .env           # fill in LAZADA_EMAIL, LAZADA_PASSWORD
cp config.example.json config.json
#   → edit items[] with the product URLs you care about
#   → keep "dryRun": true for first run

# 3. First run in dry-run mode (also seeds session.json after login)
npm run dev:dry-run
```

The first run opens a visible browser so you can complete login (and solve a
CAPTCHA if Lazada shows one). On success, `session.json` is saved and reused
on subsequent runs.

---

## Configuration

Edit `config.json`:

```json
{
  "items": [
    {
      "url": "https://www.lazada.sg/products/<your-item>.html",
      "name": "Display name used in logs",
      "maxPrice": 59.90,
      "quantity": 1
    }
  ],
  "settings": {
    "dryRun": true,
    "checkIntervalMs": 15000,
    "minPageLoadDelayMs": 4000,
    "maxPageLoadDelayMs": 9000,
    "headless": false,
    "maxRetries": 3,
    "retryBackoffBaseMs": 2000,
    "retryBackoffMaxMs": 30000,
    "paymentMethod": "paynow",
    "sessionFile": "session.json",
    "logDir": "logs"
  }
}
```

Settings of note:

- `checkIntervalMs` — base poll interval per item (min 5000).
- `minPageLoadDelayMs` / `maxPageLoadDelayMs` — random jitter between page
  loads. Low values get you rate-limited; the defaults are deliberately
  conservative.
- `headless` — set `false` for first login or selector debugging; `true`
  once the session is seeded and you're running on a server.
- `paymentMethod` — hardcoded to `"paynow"` in `checkout.ts`; this config key is kept for reference but has no effect on the current flow.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run from TypeScript via `ts-node` |
| `npm run dev:dry-run` | Same, forced `--dry-run` |
| `npm run build` | Compile TS into `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm run start:dry-run` | Run compiled, forced `--dry-run` |
| `npm run verify-selectors` | Open Lazada pages and report which CSS selector candidates resolved — useful when Lazada changes its DOM |
| `npm test` | Run the vitest unit suite |

---

## Testing

```bash
npm test                  # One-shot run (70 tests)
npm run test:watch        # Re-runs on file changes
npm run test:coverage     # Coverage report

# Run a single file or filter by name:
npx vitest run tests/decision.test.ts
npx vitest run -t "returns proceed=false in dry-run mode"
```

Unit tests cover **pure logic only** — modules with no I/O or Playwright dependency:

| File | What it covers |
| --- | --- |
| `tests/decision.test.ts` | `isPriceAcceptable`, `shouldProceed`, `computeBackoff`, `isAntiBot`, `formatOrderSummary` (including null price/total fallbacks) |
| `tests/config.test.ts` | `loadCredentials`, `loadConfig` — validation, key rejection, defaults |
| `tests/rate-limiter.test.ts` | Per-domain rate limiting, jitter, reset, `getLastUsed` |
| `tests/payment-approval.test.ts` | Telegram message building, callback parsing, polling loop, dispatcher routing |

Modules that require a live browser (`auth`, `monitor`, `checkout`, `browser-actions`) are tested manually via `npm run verify-selectors` and `npm run dev:dry-run`.

---

## Architecture

```
src/
  index.ts            Entry point — lifecycle, per-item workers, shutdown
  config.ts           Config loader/validator, env-var credentials
  monitor.ts          Stock polling loop with rate limiting
  decision.ts         Pure decision functions (proceed/skip, backoff, formatters)
  checkout.ts         Buy Now → PayNow → Place Order orchestration + retry
  payment-approval.ts Human approval gate (stdin or Telegram) — retained, not active
  auth.ts             Login flow, session save/load, anti-bot detection
  browser-actions.ts  Thin Playwright wrappers
  selectors.ts        Centralised CSS selector candidates
  rate-limiter.ts     Per-domain delay + jitter
  logger.ts           JSON-line audit log + coloured stdout
  types.ts            Domain types
tests/                Vitest unit tests (pure functions only)
```

`decision.ts` is intentionally pure — no I/O, no Playwright, no `fs` — so the
risky logic is trivially testable.

---

## Logs

Every run appends to `logs/audit-YYYY-MM-DD.log`, one JSON object per line.
Look for these `action` fields when reviewing a run:

- `dry_run_skip` — purchase aborted because dry-run was on
- `buy_now_unavailable` — Buy Now button not found; attempt failed
- `clicked_buy_now` — navigating to checkout
- `payment_method_selected` — PayNow was selected on the checkout page
- `place_order_clicked` — order submitted; Lazada now shows PayNow QR
- `order_confirmed` — confirmation page detected
- `purchase_complete` — only emitted on a confirmed order

---

## Deployment

To run this 24/7 on a server with mobile approval, see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.
Recommended setup is a ~$12/mo DigitalOcean droplet in Singapore under systemd,
with Telegram for approvals.

---

## Disclaimer

You are responsible for complying with Lazada's terms of service and any
applicable laws in your jurisdiction. The author makes no warranty as to
fitness for purpose, and is not liable for missed drops, failed payments, or
account actions taken against you.
