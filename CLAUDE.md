# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automated monitor and checkout assistant for Pokemon Center SG products on Lazada SG. TypeScript + Playwright (headed Chromium). Runs one worker per configured item that polls a product page, decides whether to buy, and walks through checkout — pausing for explicit human approval before placing the order.

## Commands

```bash
npm run build               # tsc → dist/
npm run dev                 # ts-node src/index.ts (reads config.json + .env)
npm run dev:dry-run         # Force dry-run regardless of config.settings.dryRun
npm run start               # Run the built dist/index.js
npm run start:dry-run       # Built version, forced dry-run
npm run verify-selectors    # Headed dry-run that opens login + first product page
                            #   and reports which selector candidates resolve
npm test                    # vitest run (one-shot)
npm run test:watch          # vitest watch mode
npm run test:coverage       # vitest with coverage

# Run a single test file or filter by name:
npx vitest run tests/decision.test.ts
npx vitest run -t "returns proceed=false in dry-run mode"
```

First-time setup: copy `config.example.json` → `config.json` and `.env.example` → `.env`. Both are git-ignored. Credentials (`LAZADA_EMAIL`, `LAZADA_PASSWORD`) MUST come from env vars — `config.ts` rejects any `credentials`/`email`/`password` key found in `config.json`.

## Architecture

The pipeline is a strict three-stage flow per item, with safety gates between each stage. `src/index.ts::main` is the orchestrator; everything else is composable.

```
config + env  ──►  auth (load/restore session, login if needed)
                       │
                       ▼
   For each item, in parallel (Promise.allSettled):
       monitor.waitForStock ──► decision.shouldProceed ──► checkout
              (polls)              (pure function)         (with approval gate)
```

### Module roles

- **`index.ts`** — Loads `.env` manually (no dotenv dep), validates config, launches Chromium with anti-automation flags, restores session, spawns one `runItemWorker` per item. SIGINT/SIGTERM trigger graceful shutdown that saves session and closes browser.
- **`config.ts`** — Loads + validates `config.json`. `loadCredentials()` is the only path to env-var credentials and throws if missing. Strict key allow-listing — unknown keys throw. `dryRun` defaults to `true`.
- **`auth.ts`** — Session cookies persisted to disk with mode `0o600`. `detectChallenge` checks URL patterns (`/baxia/`, `/block`, `/robot`, `captcha`) and DOM markers (captcha frames, slider, rate-limit pages). Any challenge throws `ChallengeDetectedError` — the script never attempts to solve CAPTCHAs, MFA, or rate limits.
- **`monitor.ts`** — `waitForStock` polls a product page at `checkIntervalMs` with an interruptible sleep (checks `AbortSignal` every 500ms). Never throws on transient page errors; returns `StockCheckResult` with status `unknown` so the caller decides. Returns immediately on `anti_bot` or `login_required` so the worker can bail out.
- **`decision.ts`** — **Pure functions only.** No I/O, no Playwright, no fs, no console. `shouldProceed`, `isPriceAcceptable`, `computeBackoff`, `formatOrderSummary`. Keep this discipline — these are the unit-test core. Note: `isPriceAcceptable(null, …)` returns `true` (unknown price falls through to the human at the approval gate rather than silently skipping).
- **`checkout.ts`** — Composes browser-actions + payment-approval. **Dry-run guard is the first check** (before any navigation). Prefers Buy Now over Add-to-Cart. Builds `OrderSummary` from *live page text* (price, address, payment label), not config values. Retries with exponential backoff (`retryBackoffBaseMs * 2^attempt`, capped at `retryBackoffMaxMs`), but never retries after `ApprovalRejectedError`/`ApprovalTimeoutError`. `ChallengeDetectedError` is re-thrown so `index.ts` shuts down.
- **`payment-approval.ts`** — Blocks on a readline prompt; user must type `CONFIRM` (case-insensitive) within 120s. Anything else throws `ApprovalRejectedError`/`ApprovalTimeoutError`. **Never auto-confirm — this gate is the last human checkpoint before money moves.**
- **`browser-actions.ts`** — Thin Playwright wrappers (`navigateTo`, `clickElement`, `fillInput`, `extractText`, `isVisible`, `waitForUrl`). They **only accept `SelectorSet` objects, never raw CSS strings** — this is enforced by type. `navigateTo` retries 3× with backoff.
- **`selectors.ts`** — The single source of truth for every DOM selector in the app. `SELECTORS` is structured by page (`login`, `antiBot`, `product`, `cart`, `checkout`, `confirmation`). Each `SelectorSet` has `candidates` (tried in order, first visible wins), `description`, and `required` (true ⇒ throw `SelectorNotFoundError`; false ⇒ return null). Text-based `:has-text()` candidates are listed last as resilient fallbacks. **All selectors are unverified against live Lazada pages — run `npm run verify-selectors` after any Lazada UI change.**
- **`rate-limiter.ts`** — Per-domain `acquire(domain)` enforces `minIntervalMs` since last request plus random jitter up to `maxJitterMs`. Called before every page navigation in `monitor` and `checkout`.
- **`logger.ts`** — Append-only JSONL audit log at `logs/audit-YYYY-MM-DD.log` plus colored stdout/stderr. Never truncates. Logging errors are swallowed so the main process can never crash from log I/O.

### Cross-cutting invariants

- **Credentials never touch `config.json` or logs.** `config.ts` rejects credential keys at the top level. After login, `auth.ts` overwrites the in-memory password string immediately.
- **Dry-run defaults to true** at both `DEFAULTS` (config.ts) and the example config. Live purchases require explicitly setting `"dryRun": false` AND not passing `--dry-run`. CLI flag always wins (force-enables dry-run).
- **Anti-bot detection is fail-closed:** a detected challenge halts the worker (in monitor) or aborts shutdown (during login). Do not add retry/wait logic that "powers through" a CAPTCHA.
- **Selector additions go through the abstraction.** Don't inline `page.locator("…")` calls outside `selectors.ts`/`browser-actions.ts`. Add a new `SelectorSet` to the relevant group in `SELECTORS` with multiple candidates and pick the right `required` flag.
- **`OrderSummary` reflects what the user sees on the live checkout page**, not what was configured. The approval gate's whole job is catching the case where config and reality diverge (wrong address, surprise total, wrong payment method).
- Tests run against pure logic (`decision`, `rate-limiter`, `config`). There are no Playwright/integration tests — exercise UI changes manually via `verify-selectors` and headed `dev:dry-run`.

## Runtime artifacts (git-ignored)

- `config.json` — your real config
- `.env` — your credentials
- `session.json` — persisted cookies (mode 0600)
- `logs/audit-YYYY-MM-DD.log` — JSONL audit trail
- `dist/` — tsc output
