# Deployment

This app is a long-running, single-instance Node.js daemon that drives a Chromium
browser (Playwright). When stock is detected it clicks Buy Now, selects PayNow,
and places the order. Lazada then shows a PayNow QR that you scan in your
banking app to complete the transfer. No inbound ports are needed — outbound
HTTPS is sufficient.

## TL;DR

| What | Choice |
| --- | --- |
| Where | **DigitalOcean Basic droplet, SGP1 region** |
| Size | 2 vCPU shared, 2 GB RAM, 50 GB SSD |
| Cost | **~$12–14 / month** all-in |
| Process supervisor | systemd |
| Payment confirmation | PayNow QR (scan in banking app after Place Order) |

SGP1 is preferred because Lazada SG profiles non-SG IPs as suspicious — a
Singapore-region host minimises anti-bot friction and latency. The app needs
only outbound HTTPS — no reverse proxy, no TLS cert, no firewall holes.

---

## Prerequisites

1. **Node.js 18+** on the target host.
2. **A Lazada SG account** with PayNow linked as a payment method in-app.
3. **Your phone** nearby when the bot is live — you will need to scan the
   PayNow QR that Lazada presents after Place Order is clicked.

---

## Running locally (your laptop / desktop)

Use this when you want to run real purchases from your own machine. No server
needed — the app runs as a foreground process you can watch.

### Setup

```bash
# 1. Install deps and Chromium
npm ci
npx playwright install --with-deps chromium

# 2. Configure credentials
cp .env.example .env
# Edit .env — fill in LAZADA_EMAIL and LAZADA_PASSWORD
chmod 600 .env

# 3. Configure items
cp config.example.json config.json
# Edit config.json — add your target item URLs, set maxPrice per item
```

Set these in `config.json` for local use:

```json
{
  "settings": {
    "headless": false,
    "dryRun": true
  }
}
```

`headless: false` keeps the browser visible so you can see the PayNow QR when
it appears. `dryRun: true` stays on until you've verified the full flow.

### Seed the session (first run)

```bash
npm run dev:dry-run
```

This opens a browser, logs you into Lazada (solve any CAPTCHA manually), and
saves `data/session.json`. Subsequent runs reuse the session silently.

### Verify end-to-end in dry-run

With `dryRun: true` still set, watch the logs confirm stock detection, price
evaluation, and that checkout is reached but skipped:

```
[info] checkout     dry_run_skip   { item: "Pikachu Plush" }
```

### Go live

Once you're confident the flow works, flip `dryRun` to `false`:

```json
"dryRun": false
```

Then run:

```bash
npm run dev
```

When an item comes into stock and the price is within `maxPrice`:

1. The bot clicks **Buy Now** → navigates to checkout → selects PayNow.
2. It clicks **Place Order** — Lazada displays a **PayNow QR**.
3. **Open your banking app, scan the QR, and approve the payment.**
   The order is only confirmed once you complete this step.
4. The bot waits for the confirmation page and logs `order_confirmed`.

> Keep your phone within reach. The PayNow QR has a short expiry (~5 min).
> If you don't scan in time, the order fails and the bot retries up to
> `maxRetries` times.

### Optional: health endpoint

Set `healthPort` to a free port to get a local status page at
`http://127.0.0.1:<port>/`:

```json
"healthPort": 3456
```

```bash
curl http://127.0.0.1:3456/ | jq .
```

Returns a JSON snapshot of item check counts, last stock status, and purchase
totals. Useful for confirming the bot is running and polling correctly.

---

## Recommended: DigitalOcean droplet in Singapore

### Sizing

| Plan | vCPU | RAM | Disk | Monthly | Notes |
| --- | --- | --- | --- | --- | --- |
| Basic 1 GB | 1 | 1 GB | 25 GB | **$6** | Tight with Chromium — add a 2 GB swap file |
| Basic 2 GB | 1 | 2 GB | 50 GB | **$12** | **Recommended sweet spot** |

Equivalent options at similar prices: AWS Lightsail Singapore ($5 / $10),
Vultr Singapore ($6 / $12), Linode Singapore ($5 / $12). Hetzner is cheaper
(€4.51/mo CX22, 4 GB) but **has no Singapore region** — avoid for this
workload.

### Setup

On a fresh Ubuntu 24.04 droplet:

```bash
# 1. System deps
sudo apt update && sudo apt install -y curl git

# 2. Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Clone and install
sudo adduser --disabled-password --gecos "" buyer
sudo -iu buyer
git clone <repo-url> ~/buyer && cd ~/buyer
npm ci
npx playwright install --with-deps chromium   # version tied to playwright 1.56.1 in package.json

# 4. Configure
cp .env.example .env && nano .env             # fill in LAZADA_EMAIL, LAZADA_PASSWORD
cp config.example.json config.json && nano config.json
#   → set "headless": true   (no display on a headless server)
#   → keep "dryRun": true    (flip to false only after verifying the flow)
chmod 600 .env

# 5. Build
npm run build

# 6. Smoke test in dry-run mode
npm run start:dry-run
```

### Seeding the session (one-time)

Lazada login occasionally shows a CAPTCHA / slider that needs a real display.
Do the **first login locally** on your laptop (with `headless: false`), let the
browser solve / show the challenge, then copy the resulting session file up:

```bash
# On your laptop, after a successful login:
scp data/session.json buyer@<droplet>:~/buyer/data/session.json
ssh buyer@<droplet> chmod 600 ~/buyer/data/session.json
```

After that the droplet can run fully headless.

### Run as a systemd service

Create `/etc/systemd/system/buyer.service`:

```ini
[Unit]
Description=Pokemon Center Buyer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=buyer
WorkingDirectory=/home/buyer/buyer
EnvironmentFile=/home/buyer/buyer/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now buyer
sudo systemctl status buyer
journalctl -u buyer -f       # tail live logs
```

The app already rotates its own audit log daily (`data/logs/audit-YYYY-MM-DD.log`),
so no extra logrotate config is required.

### Going live on the droplet

Once dry-run is confirmed working, enable purchases:

```bash
# Edit config.json on the droplet
nano ~/buyer/config.json
# set "dryRun": false
# set "headless": true   (already set)

# Rebuild and restart
npm run build
sudo systemctl restart buyer
sudo systemctl status buyer
```

When a purchase fires, Lazada shows a PayNow QR **in the headless browser** —
since there is no screen, you need to intercept it from logs. The checkout logs
`place_order_clicked` and then either `order_confirmed` (success) or
`confirmation_not_detected` (failure). Check Lazada's app / website for the
pending payment QR under **My Orders** if the log shows a failure.

> For a better experience on a remote server consider running with
> `headless: false` and a VNC session during the transition to live, so you
> can see and scan the PayNow QR directly.

### Optional: health endpoint on the droplet

Add `"healthPort": 3456` (or any port 1024–65535) to `config.json` to expose
a JSON status page on `127.0.0.1` only:

```bash
curl http://127.0.0.1:3456/ | jq .
```

```json
{
  "startedAt": "2026-06-09T08:00:00.000Z",
  "dryRun": false,
  "items": [
    {
      "name": "Pikachu Plush",
      "lastChecked": "2026-06-09T08:05:12.000Z",
      "lastStatus": "out_of_stock",
      "checkCount": 20,
      "antiBotCount": 0
    }
  ],
  "totalCheckoutAttempts": 0,
  "totalPurchases": 0
}
```

To expose it over SSH from your laptop without opening a firewall port:

```bash
ssh -L 3456:127.0.0.1:3456 buyer@<droplet>
# then open http://127.0.0.1:3456/ in your browser
```

### Monthly cost

| Item | Cost |
| --- | --- |
| DO Basic 2 GB droplet, SGP1 | $12.00 |
| Outbound bandwidth (well under 2 TB included) | $0.00 |
| Backups (optional, +20 %) | $2.40 |
| Telegram Bot API | $0.00 |
| **Total** | **~$12–14 / month** |

---

## Alternative 1 — Docker on any host

Use the official Playwright image as the base (already has Chromium plus all
system libs); mount config, env, session and logs as volumes. Same monthly cost
as the underlying host. Pick this if you already run Docker; otherwise systemd
is simpler.

```Dockerfile
FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc
CMD ["node", "dist/index.js"]
```

```bash
docker run -d --name buyer --restart unless-stopped \
  -v $PWD/config.json:/app/config.json:ro \
  -v $PWD/.env:/app/.env:ro \
  -v $PWD/data:/app/data \
  buyer:latest
```

The `data/` volume covers both the session file (`data/session.json`) and audit
logs (`data/logs/`). No separate `logs` mount is needed.

---

## Alternative 2 — Always-on home machine / Raspberry Pi

Zero hosting cost (just electricity, ~$2–5 / month). A Singapore-residential IP
is actually *better* than a cloud IP for Lazada SG anti-bot, so this is a
genuinely good option if you already have a Pi 4 / 5 or a NUC running 24/7.
Caveat: ARM Playwright Chromium works but is noticeably slower than x86 — verify
`npx playwright install --with-deps chromium` succeeds on `linux/arm64` before
committing.

Setup is identical to the droplet steps; just swap the systemd unit's `User=`
and `WorkingDirectory=` to match your home account.

---

## Not recommended — serverless

Lambda / Cloud Run / Fly Machines on-demand are wrong fits for this app:

- It's a stateful daemon with a persistent browser session and a per-item
  polling loop, not a request/response handler.
- Lambda has a 15-minute execution ceiling.
- Cloud Run scales to zero and would lose the browser session.
- Per-second pricing for a process that runs 24/7 ends up costing more than a
  $6 droplet.

---

## Security checklist

The codebase already enforces several invariants — don't undo them when you
deploy:

- `chmod 600 .env` on the host; never commit it.
- `data/session.json` is written with mode `0600` by `src/auth.ts` — keep it
  that way; treat it like a password.
- Have PayNow linked to your Lazada account before going live — the bot
  selects it automatically and the QR will only appear if the payment method
  is correctly configured on the Lazada side.
- Keep `"dryRun": true` in `config.json` until you've verified an end-to-end
  cycle on the host (item is detected → checkout page is reached → PayNow QR
  appears). Then flip to `false`.
- Confirm the firewall only allows outbound; no inbound rules are needed.
