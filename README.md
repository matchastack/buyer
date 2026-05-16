# Pokemon Center Buyer

Automated monitor and checkout assistant for Pokemon Center SG drops on
Lazada. It polls product pages on a jittered schedule, decides whether to
proceed based on stock and price rules, drives a real Chromium browser through
Lazada's checkout via Playwright, and **stops at a human-approval gate before
ever clicking "Place Order"**.

> This tool is intended for **personal use** to help you compete with bots on
> limited drops. It does not bypass payment, does not store credentials in
> the repo, and never auto-submits an order without you saying yes.

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
3. **No purchase without explicit human approval.** Every checkout pauses at
   `requestApproval()` — either type `CONFIRM` in the terminal, or tap
   **Approve** on a Telegram message. Two minutes without a response =
   timeout = no purchase.
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

## Approval methods

`settings.approvalMethod` selects how purchases are gated:

| Value | How it works | Use when |
| --- | --- | --- |
| `"stdin"` *(default)* | Prompts in the terminal — type `CONFIRM` | Running locally with the terminal visible |
| `"telegram"` | Sends a message with **Approve** / **Reject** buttons to a Telegram bot | Running on a server / you want phone approval |

For Telegram: create a bot via **@BotFather**, send it a message, find your
chat id via `https://api.telegram.org/bot<TOKEN>/getUpdates`, and set
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`. The bot uses HTTP long
polling, so the host needs only outbound internet — no inbound ports.

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
    "paymentMethod": "credit_card",
    "sessionFile": "session.json",
    "logDir": "logs",
    "approvalMethod": "stdin"
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
- `paymentMethod` — `"credit_card"`, `"cod"`, `"paynow"`, or a custom
  string matched against the on-page payment label.

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

## Architecture

```
src/
  index.ts            Entry point — lifecycle, per-item workers, shutdown
  config.ts           Config loader/validator, env-var credentials
  monitor.ts          Stock polling loop with rate limiting
  decision.ts         Pure decision functions (proceed/skip, backoff, formatters)
  checkout.ts         Single-attempt + retry orchestration
  payment-approval.ts Human approval gate (stdin or Telegram)
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
- `approval_requested` / `approval_granted` / `approval_rejected` / `approval_timeout`
- `order_summary_built` — what the gate showed you
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
