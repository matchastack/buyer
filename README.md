# Pokemon Center SG Buyer

Automated monitor and checkout assistant for Pokemon Center SG products on Lazada SG. Polls a product page, decides whether to buy, and walks through checkout — pausing for explicit human approval before placing any order.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create config files

```bash
cp config.example.json config.json
cp .env.example .env
```

### 3. Add your credentials to `.env`

```
LAZADA_EMAIL=you@example.com
LAZADA_PASSWORD=yourpassword
```

Credentials must come from env vars — `config.json` rejects any credential keys.

### 4. Configure items in `config.json`

Add the Lazada product URLs you want to monitor, with a `maxPrice` and `quantity` per item. `dryRun` defaults to `true` — set it to `false` only when you're ready to make live purchases.

---

## Running

```bash
npm run dev              # Run in development mode (reads config.json + .env)
npm run dev:dry-run      # Force dry-run regardless of config setting
npm run start            # Run the built dist/index.js
npm run start:dry-run    # Built version, forced dry-run
npm run verify-selectors # Headed browser — reports which DOM selectors resolve on live Lazada pages
```

---

## Testing

```bash
npm test                 # One-shot test run
npm run test:watch       # Re-runs on file changes
npm run test:coverage    # Coverage report

# Run a single file or filter by test name:
npx vitest run tests/decision.test.ts
npx vitest run -t "returns proceed=false in dry-run mode"
```

Unit tests cover pure logic only (`decision`, `config`, `rate-limiter`, `payment-approval`). Modules that require a live browser (`auth`, `monitor`, `checkout`, `browser-actions`) are tested manually via `verify-selectors` and `dev:dry-run`.

---

## Build

```bash
npm run build            # Compiles TypeScript to dist/
```
