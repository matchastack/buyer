/**
 * Optional local health/metrics HTTP server.
 *
 * Exposes a single JSON endpoint (GET /) with a live snapshot of runtime
 * status — item check counts, last stock status, checkout/purchase tallies.
 *
 * Binds to 127.0.0.1 only — never exposed on 0.0.0.0.
 * Enabled only when settings.healthPort > 0.
 * Uses Node's built-in `http` module — no external dependencies.
 */

import * as http from "http";

export interface ItemStatus {
  name: string;
  lastChecked: string | null; // ISO-8601 or null if not yet checked
  lastStatus: string | null;  // StockStatus or null
  checkCount: number;
  antiBotCount: number;
}

export interface RuntimeStatus {
  startedAt: string;            // ISO-8601 of process start
  dryRun: boolean;
  items: ItemStatus[];
  totalChallengesDetected: number;
  totalCheckoutAttempts: number;
  totalPurchases: number;
}

export function startHealthServer(
  port: number,
  getStatus: () => RuntimeStatus
): http.Server {
  const server = http.createServer((_req, res) => {
    const body = JSON.stringify(getStatus(), null, 2);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  server.listen(port, "127.0.0.1");
  return server;
}
