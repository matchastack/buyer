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
cp .env.example .env && nano .env             # Lazada creds + Telegram bot/chat id
cp config.example.json config.json && nano config.json
#   → set "headless": true
#   → keep "dryRun": true for first run
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
scp session.json buyer@<droplet>:~/buyer/session.json
ssh buyer@<droplet> chmod 600 ~/buyer/session.json
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

The app already rotates its own audit log daily (`logs/audit-YYYY-MM-DD.log`),
so no extra logrotate config is required.

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
  -v $PWD/session.json:/app/session.json \
  -v $PWD/logs:/app/logs \
  buyer:latest
```

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
- Cloud Run scales to zero and would lose the browser session and the Telegram
  long poller.
- Per-second pricing for a process that runs 24/7 ends up costing more than a
  $6 droplet.

---

## Security checklist

The codebase already enforces several invariants — don't undo them when you
deploy:

- `chmod 600 .env` on the host; never commit it.
- `session.json` is written with mode `0600` by `src/auth.ts` — keep it that
  way; treat it like a password.
- Have PayNow linked to your Lazada account before going live — the bot
  selects it automatically and the QR will only appear if the payment method
  is correctly configured on the Lazada side.
- Keep `"dryRun": true` in `config.json` until you've verified an end-to-end
  cycle on the host (item is detected → checkout page is reached → PayNow QR
  appears). Then flip to `false`.
- Confirm the firewall only allows outbound; no inbound rules are needed.
